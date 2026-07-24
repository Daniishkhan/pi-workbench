import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { compileWorkflowSource } from "../../extensions/dynamic/compiler.ts";
import { resolveConfig, resolveWorkflowPolicy } from "../../extensions/dynamic/config.ts";
import type { DelegationClient, DelegationRunOptions } from "../../extensions/dynamic/delegation.ts";
import { WorkflowManager } from "../../extensions/dynamic/manager.ts";
import { WorkflowStore } from "../../extensions/dynamic/store.ts";
import type { WorkflowAgentResult, WorkflowAgentTask } from "../../extensions/dynamic/types.ts";

const TEST_READ_ONLY_AGENTS = Object.freeze({
	"pi-workbench.fast-scout": "pi-workbench-dynamic-runtime.reader-test",
	"pi-workbench.reviewer": "pi-workbench-dynamic-runtime.verifier-test",
});

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeStore(): WorkflowStore {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-manager-test-"));
	roots.push(root);
	return new WorkflowStore({
		agentDir: path.join(root, "agent"),
		cwd: path.join(root, "project"),
		configDirName: ".pi",
		sessionId: "session-1",
		projectTrusted: true,
	});
}

function fanoutSource(maxAgents = 4): string {
	return `workflow({
  version: 1,
  name: "fanout-flow",
  description: "Discover, fan out, and return only synthesis.",
  size: "small",
  permissions: ["read"],
  phases: ["Discover", "Review", "Synthesize"],
  maxAgents: ${maxAgents},
  maxConcurrency: 2,
  steps: [
    phase("Discover", [
      run("discover", {
        agent: "pi-workbench.fast-scout",
        saveAs: "targets",
        task: "Discover {{input.request}}",
        schema: {
          type: "object",
          required: ["items"],
          properties: { items: { type: "array", maxItems: 2, items: { type: "string" } } }
        }
      })
    ]),
    phase("Review", [
      forEach("review-targets", {
        from: output("targets", "/items"),
        as: "target",
        maxItems: 2,
        concurrency: 2,
        collectAs: "reviews",
        steps: [run("review-target", { agent: "pi-workbench.reviewer", saveAs: "review", task: "Review {{target}}" })]
      })
    ]),
    phase("Synthesize", [
      run("synthesize", { agent: "pi-workbench.reviewer", saveAs: "final", task: "Synthesize {{outputs.reviews}}" })
    ])
  ],
  result: output("final")
});`;
}

class TrackingAbortSignal {
	aborted = false;
	readonly listeners = new Set<unknown>();
	addEventListener(type: string, listener: unknown): void {
		if (type === "abort") this.listeners.add(listener);
	}
	removeEventListener(type: string, listener: unknown): void {
		if (type === "abort") this.listeners.delete(listener);
	}
}

class FakeDelegation {
	singleCalls: WorkflowAgentTask[] = [];
	parallelCalls: WorkflowAgentTask[][] = [];
	async runSingle(task: WorkflowAgentTask, options: DelegationRunOptions): Promise<WorkflowAgentResult> {
		this.singleCalls.push(task);
		options.onProgress?.({ requestId: `single-${this.singleCalls.length}`, agent: task.agent, currentTool: "read" });
		if (task.agent === TEST_READ_ONLY_AGENTS["pi-workbench.fast-scout"]) {
			return { agent: task.agent, status: "completed", output: '{"items":["a","b"]}' };
		}
		return { agent: task.agent, status: "completed", output: "FINAL REPORT" };
	}
	async runParallel(tasks: WorkflowAgentTask[], options: DelegationRunOptions): Promise<WorkflowAgentResult[]> {
		this.parallelCalls.push(tasks);
		options.onProgress?.({
			requestId: `parallel-${this.parallelCalls.length}`,
			tasks: tasks.map((task, index) => ({ index, agent: task.agent, status: "running", currentTool: "read" })),
		});
		return tasks.map((task) => ({ agent: task.agent, status: "completed", output: `review:${task.task.at(-1)}` }));
	}
	dispose(): void {}
}

test("executes bounded fanout and returns only the selected final value", async () => {
	const store = makeStore();
	const raw = fanoutSource();
	const staged = store.stage("fanout-flow", raw, compileWorkflowSource(raw).manifest);
	const fake = new FakeDelegation();
	const reportedAgents: string[][] = [];
	const manager = new WorkflowManager({
		store,
		delegation: fake as unknown as DelegationClient,
		config: resolveConfig(),
		readOnlyAgentMap: TEST_READ_ONLY_AGENTS,
		onChange: (snapshot) => {
			if (snapshot.activeAgents.length > 0) reportedAgents.push(snapshot.activeAgents.flatMap((entry) => entry.agents));
		},
	});
	const started = manager.start(staged, {
		input: { request: "auth" },
		cwd: store.cwd,
		sessionId: "session-1",
		model: "provider/model",
		background: false,
	});
	const result = await started.done;
	assert.equal(result.run.state, "completed");
	assert.equal(result.value, "FINAL REPORT");
	assert.equal(result.run.agentsLaunched, 4);
	assert.equal(result.run.agentsCompleted, 4);
	assert.equal(fake.parallelCalls.length, 1);
	assert.equal(fake.parallelCalls[0]?.length, 2);
	assert.match(fake.parallelCalls[0]?.[0]?.task ?? "", /read-only/);
	assert.ok(reportedAgents.flat().includes("pi-workbench.fast-scout"));
	assert.ok(reportedAgents.flat().includes("pi-workbench.reviewer"));
	assert.ok(reportedAgents.flat().every((agent) => !agent.startsWith("pi-workbench-dynamic-runtime.")));
	assert.equal(result.summary.includes("review:a"), false, "intermediate fanout values must not enter final summary");
	assert.ok(fs.existsSync(path.join(result.run.runDir, "result.json")));
	assert.equal(fs.readdirSync(path.join(result.run.runDir, "agents")).length, 4);
});

test("removes the foreground abort listener after terminal completion", async () => {
	const store = makeStore();
	const raw = fanoutSource();
	const staged = store.stage("fanout-flow", raw, compileWorkflowSource(raw).manifest);
	const signal = new TrackingAbortSignal();
	const manager = new WorkflowManager({
		store,
		delegation: new FakeDelegation() as unknown as DelegationClient,
		config: resolveConfig(),
		readOnlyAgentMap: TEST_READ_ONLY_AGENTS,
	});
	const result = await manager.start(staged, {
		input: { request: "auth" }, cwd: store.cwd, sessionId: "session-1", background: false, signal: signal as unknown as AbortSignal,
	}).done;
	assert.equal(result.run.state, "completed");
	assert.equal(signal.listeners.size, 0);
});

test("executes bounded repeat and branch nodes", async () => {
	const store = makeStore();
	const raw = `workflow({
  version: 1,
  name: "loop-flow",
  description: "Bounded loop and branch test.",
  size: "small",
  permissions: ["read"],
  phases: ["Loop"],
  maxAgents: 1,
  steps: [phase("Loop", [
    set("done", false),
    repeat("review-loop", {
      maxIterations: 2,
      until: equals(variable("done"), true),
      steps: [
        run("check", {
          agent: "pi-workbench.reviewer",
          saveAs: "check_result",
          task: "Return done",
          schema: { type: "object", required: ["done"], properties: { done: { type: "boolean" } } }
        }),
        set("done", output("check_result", "/done"))
      ]
    }),
    when("choose-result", equals(variable("done"), true), [set("result", "clean")], [set("result", "dirty")])
  ])],
  result: variable("result")
});`;
	const staged = store.stage("loop-flow", raw, compileWorkflowSource(raw).manifest);
	const fake = new FakeDelegation();
	fake.runSingle = async function (task: WorkflowAgentTask): Promise<WorkflowAgentResult> {
		this.singleCalls.push(task);
		return { agent: task.agent, status: "completed", output: '{"done":true}' };
	};
	const manager = new WorkflowManager({ store, delegation: fake as unknown as DelegationClient, config: resolveConfig(), readOnlyAgentMap: TEST_READ_ONLY_AGENTS });
	const result = await manager.start(staged, {
		cwd: store.cwd,
		sessionId: "session-1",
		model: "provider/model",
		background: false,
	}).done;
	assert.equal(result.run.state, "completed");
	assert.equal(result.value, "clean");
	assert.equal(result.run.agentsLaunched, 1);
});

test("wall timeout wakes a cooperatively paused workflow", async () => {
	const store = makeStore();
	const raw = `workflow({
  version: 1,
  name: "paused-timeout",
  description: "Paused timeout test.",
  size: "small",
  permissions: ["read"],
  phases: ["Run"],
  timeoutMs: 50,
  maxAgents: 1,
  steps: [phase("Run", [
    run("check", { agent: "pi-workbench.reviewer", saveAs: "checked", task: "Check" }),
    set("after", true)
  ])],
  result: variable("after")
});`;
	const staged = store.stage("paused-timeout", raw, compileWorkflowSource(raw).manifest);
	let release!: () => void;
	let began!: () => void;
	const beganPromise = new Promise<void>((resolve) => { began = resolve; });
	const gate = new Promise<WorkflowAgentResult>((resolve) => {
		release = () => resolve({ agent: "pi-workbench.reviewer", status: "completed", output: "ok" });
	});
	const fake = {
		runSingle: async (_task: WorkflowAgentTask, options: DelegationRunOptions) => {
			options.onProgress?.({ requestId: "gate", agent: "pi-workbench.reviewer" });
			began();
			return gate;
		},
		runParallel: async () => [],
		dispose() {},
	};
	const manager = new WorkflowManager({ store, delegation: fake as unknown as DelegationClient, config: resolveConfig({ maxRuntimeMs: 50 }), readOnlyAgentMap: TEST_READ_ONLY_AGENTS });
	const started = manager.start(staged, { cwd: store.cwd, sessionId: "session-1", model: "provider/model", background: false });
	await beganPromise;
	manager.pause(started.id);
	release();
	const result = await Promise.race([
		started.done,
		new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("workflow remained paused")), 1_000)),
	]);
	assert.equal(result.run.state, "failed");
	assert.match(result.summary, /runtime limit/);
});

test("startup persistence failure does not publish an immortal active run", async () => {
	const store = makeStore();
	const raw = `workflow({ version: 1, name: "startup", description: "Startup persistence test.", size: "small", permissions: ["read"], phases: ["Run"], steps: [phase("Run", [set("value", "ok")])], result: variable("value") });`;
	const staged = store.stage("startup", raw, compileWorkflowSource(raw).manifest);
	const original = store.writeRunStatus.bind(store);
	(store as unknown as { writeRunStatus: typeof store.writeRunStatus }).writeRunStatus = () => { throw new Error("startup disk failure"); };
	const manager = new WorkflowManager({ store, delegation: new FakeDelegation() as unknown as DelegationClient, config: resolveConfig(), readOnlyAgentMap: TEST_READ_ONLY_AGENTS });
	assert.throws(
		() => manager.start(staged, { cwd: store.cwd, sessionId: "session-1", background: false }),
		/startup disk failure/,
	);
	assert.deepEqual(manager.list(), []);
	(store as unknown as { writeRunStatus: typeof store.writeRunStatus }).writeRunStatus = original;
	const result = await manager.start(staged, { cwd: store.cwd, sessionId: "session-1", background: false }).done;
	assert.equal(result.run.state, "completed");
	await manager.shutdown();
});

test("status persistence failure settles done and cannot hang shutdown", async () => {
	const store = makeStore();
	const raw = `workflow({ version: 1, name: "persistence", description: "Persistence failure test.", size: "small", permissions: ["read"], phases: ["Run"], steps: [phase("Run", [set("value", "ok")])], result: variable("value") });`;
	const staged = store.stage("persistence", raw, compileWorkflowSource(raw).manifest);
	const original = store.writeRunStatus.bind(store);
	let writes = 0;
	(store as unknown as { writeRunStatus: typeof store.writeRunStatus }).writeRunStatus = (snapshot) => {
		writes++;
		if (writes === 2) throw new Error("simulated disk failure");
		original(snapshot);
	};
	const fake = new FakeDelegation();
	const manager = new WorkflowManager({ store, delegation: fake as unknown as DelegationClient, config: resolveConfig(), readOnlyAgentMap: TEST_READ_ONLY_AGENTS });
	const started = manager.start(staged, { cwd: store.cwd, sessionId: "session-1", background: false });
	const result = await Promise.race([
		started.done,
		new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("done remained orphaned")), 500)),
	]);
	assert.equal(result.run.state, "failed");
	assert.match(result.summary, /simulated disk failure/);
	await Promise.race([
		manager.shutdown(20),
		new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("shutdown hung")), 500)),
	]);
});

test("shutdown awaits delegated cancellation acknowledgement within its grace period", async () => {
	const store = makeStore();
	const raw = `workflow({ version: 1, name: "shutdown", description: "Shutdown acknowledgement test.", size: "small", permissions: ["read"], phases: ["Run"], steps: [phase("Run", [run("check", { agent: "pi-workbench.reviewer", saveAs: "checked", task: "Check" })])], result: output("checked") });`;
	const staged = store.stage("shutdown", raw, compileWorkflowSource(raw).manifest);
	let began!: () => void;
	const beganPromise = new Promise<void>((resolve) => { began = resolve; });
	let disposedForce: boolean | undefined;
	const fake = {
		runSingle: async (task: WorkflowAgentTask, options: DelegationRunOptions): Promise<WorkflowAgentResult> => {
			began();
			await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => setTimeout(resolve, 50), { once: true }));
			return { agent: task.agent, status: "cancelled", output: "" };
		},
		runParallel: async () => [],
		dispose(force?: boolean) { disposedForce = force; },
	};
	const manager = new WorkflowManager({ store, delegation: fake as unknown as DelegationClient, config: resolveConfig(), readOnlyAgentMap: TEST_READ_ONLY_AGENTS });
	const started = manager.start(staged, { cwd: store.cwd, sessionId: "session-1", background: false });
	await beganPromise;
	const before = Date.now();
	await manager.shutdown(500);
	assert(Date.now() - before >= 40);
	assert.equal((await started.done).run.state, "stopped");
	assert.notEqual(disposedForce, true);
});

test("rejects non-allowlisted agents from read-only nodes", async () => {
	const store = makeStore();
	const raw = `workflow({
  version: 1,
  name: "agent-policy",
  description: "Read-only agent policy test.",
  size: "small",
  permissions: ["read"],
  phases: ["Review"],
  steps: [phase("Review", [run("review", { agent: "pi-workbench.deep-reader", saveAs: "done", task: "Review" })])],
  result: output("done")
});`;
	const staged = store.stage("agent-policy", raw, compileWorkflowSource(raw).manifest);
	const fake = new FakeDelegation();
	const manager = new WorkflowManager({ store, delegation: fake as unknown as DelegationClient, config: resolveConfig(), readOnlyAgentMap: TEST_READ_ONLY_AGENTS });
	const result = await manager.start(staged, { cwd: store.cwd, sessionId: "session-1", background: false }).done;
	assert.equal(result.run.state, "failed");
	assert.match(result.summary, /permits only the pinned logical agents/);
	assert.equal(fake.singleCalls.length, 0);
});

test("fails closed when a node requests undeclared write permission", async () => {
	const store = makeStore();
	const raw = `workflow({
  version: 1,
  name: "write-flow",
  description: "Write permission test.",
  size: "small",
  permissions: ["read"],
  phases: ["Write"],
  steps: [phase("Write", [run("writer", { agent: "pi-workbench.worker", saveAs: "done", write: true, task: "Change a file" })])],
  result: output("done")
});`;
	const staged = store.stage("write-flow", raw, compileWorkflowSource(raw).manifest);
	const fake = new FakeDelegation();
	const manager = new WorkflowManager({ store, delegation: fake as unknown as DelegationClient, config: resolveConfig(), readOnlyAgentMap: TEST_READ_ONLY_AGENTS });
	const result = await manager.start(staged, {
		cwd: store.cwd,
		sessionId: "session-1",
		background: false,
	}).done;
	assert.equal(result.run.state, "failed");
	assert.match(result.summary, /permissions do not include 'write'/);
	assert.equal(fake.singleCalls.length, 0);
});

test("rejects agents that belong to another orchestration surface", async () => {
	const store = makeStore();
	const raw = `workflow({
  version: 1,
  name: "nested-shipyard-role",
  description: "Surface isolation test.",
  size: "small",
  permissions: ["read"],
  phases: ["Run"],
  steps: [phase("Run", [run("review", { agent: "pi-shipyard.review-synthesizer", saveAs: "done", task: "Review" })])],
  result: output("done")
});`;
	const staged = store.stage("nested-shipyard-role", raw, compileWorkflowSource(raw).manifest);
	const fake = new FakeDelegation();
	const result = await new WorkflowManager({ store, delegation: fake as unknown as DelegationClient, config: resolveConfig(), readOnlyAgentMap: TEST_READ_ONLY_AGENTS }).start(staged, {
		cwd: store.cwd, sessionId: "session-1", background: false,
	}).done;
	assert.equal(result.run.state, "failed");
	assert.match(result.summary, /not approved for the Dynamic Workflows surface/);
	assert.equal(fake.singleCalls.length, 0);
});

test("requires explicit write:true for every writer-capable agent", async () => {
	const store = makeStore();
	const raw = `workflow({
  version: 1,
  name: "implicit-writer",
  description: "Writer declaration test.",
  size: "small",
  permissions: ["read"],
  phases: ["Run"],
  steps: [phase("Run", [run("worker", { agent: "pi-workbench.worker", saveAs: "done", task: "Inspect" })])],
  result: output("done")
});`;
	const staged = store.stage("implicit-writer", raw, compileWorkflowSource(raw).manifest);
	const fake = new FakeDelegation();
	const result = await new WorkflowManager({ store, delegation: fake as unknown as DelegationClient, config: resolveConfig(), readOnlyAgentMap: TEST_READ_ONLY_AGENTS }).start(staged, {
		cwd: store.cwd, sessionId: "session-1", background: false,
	}).done;
	assert.equal(result.run.state, "failed");
	assert.match(result.summary, /without explicit write:true/);
	assert.equal(fake.singleCalls.length, 0);
});

test("rejects parallel writers even when old source requests worktree isolation", async () => {
	const store = makeStore();
	const raw = `workflow({
  version: 1,
  name: "parallel-writers",
  description: "Parallel writer safety test.",
  size: "small",
  permissions: ["read", "write"],
  phases: ["Write"],
  maxAgents: 2,
  steps: [phase("Write", [parallel("writers", { worktree: true, steps: [
    run("writer-a", { agent: "pi-workbench.worker", saveAs: "a", write: true, task: "A" }),
    run("writer-b", { agent: "pi-workbench.worker", saveAs: "b", write: true, task: "B" })
  ] })])],
  result: output("a")
});`;
	const staged = store.stage("parallel-writers", raw, compileWorkflowSource(raw).manifest);
	const fake = new FakeDelegation();
	const result = await new WorkflowManager({ store, delegation: fake as unknown as DelegationClient, config: resolveConfig(), readOnlyAgentMap: TEST_READ_ONLY_AGENTS }).start(staged, {
		cwd: store.cwd, sessionId: "session-1", model: "provider/model", background: false,
	}).done;
	assert.equal(result.run.state, "failed");
	assert.match(result.summary, /serialize writers/);
	assert.equal(fake.parallelCalls.length, 0);
});

test("rejects intermediate outputs above the configured hard byte limit", async () => {
	const store = makeStore();
	const raw = `workflow({
  version: 1,
  name: "output-limit",
  description: "Output limit test.",
  size: "small",
  permissions: ["read"],
  phases: ["Run"],
  steps: [phase("Run", [run("large", { agent: "pi-workbench.reviewer", saveAs: "result", task: "Return data" })])],
  result: output("result")
});`;
	const staged = store.stage("output-limit", raw, compileWorkflowSource(raw).manifest);
	const fake = new FakeDelegation();
	fake.runSingle = async (task: WorkflowAgentTask) => ({ agent: task.agent, status: "completed", output: "x".repeat(100) });
	const manager = new WorkflowManager({ store, delegation: fake as unknown as DelegationClient, config: resolveConfig({ maxIntermediateBytes: 32 }), readOnlyAgentMap: TEST_READ_ONLY_AGENTS });
	const result = await manager.start(staged, { cwd: store.cwd, sessionId: "session-1", model: "provider/model", background: false }).done;
	assert.equal(result.run.state, "failed");
	assert.match(result.summary, /intermediate-output limit/);
});

test("rejects aggregate fanout collections above the intermediate byte limit", async () => {
	const store = makeStore();
	const raw = `workflow({
  version: 1,
  name: "aggregate-limit",
  description: "Aggregate output limit test.",
  size: "small",
  permissions: ["read"],
  phases: ["Run"],
  steps: [phase("Run", [
    set("items", [1, 2]),
    forEach("each", { from: variable("items"), maxItems: 2, collectAs: "all", steps: [run("item", { agent: "pi-workbench.reviewer", saveAs: "item_result", task: "Check {{item}}" })] }),
    set("small", "ok")
  ])],
  result: variable("small")
});`;
	const staged = store.stage("aggregate-limit", raw, compileWorkflowSource(raw).manifest);
	const fake = new FakeDelegation();
	fake.runParallel = async (tasks: WorkflowAgentTask[]) => tasks.map((task) => ({ agent: task.agent, status: "completed", output: "x".repeat(20) }));
	const manager = new WorkflowManager({ store, delegation: fake as unknown as DelegationClient, config: resolveConfig({ maxIntermediateBytes: 32 }), readOnlyAgentMap: TEST_READ_ONLY_AGENTS });
	const result = await manager.start(staged, { cwd: store.cwd, sessionId: "session-1", model: "provider/model", background: false }).done;
	assert.equal(result.run.state, "failed");
	assert.match(result.summary, /collection.*intermediate-value limit/);
});

test("reserves actual children and stops before exceeding the workflow cap", async () => {
	const store = makeStore();
	const raw = fanoutSource(2);
	const staged = store.stage("fanout-flow", raw, compileWorkflowSource(raw).manifest);
	const fake = new FakeDelegation();
	const manager = new WorkflowManager({ store, delegation: fake as unknown as DelegationClient, config: resolveConfig(), readOnlyAgentMap: TEST_READ_ONLY_AGENTS });
	const result = await manager.start(staged, {
		input: { request: "auth" },
		cwd: store.cwd,
		sessionId: "session-1",
		model: "provider/model",
		background: false,
	}).done;
	assert.equal(result.run.state, "failed");
	assert.match(result.summary, /agent budget exceeded/);
	assert.equal(fake.singleCalls.length, 1, "discovery ran before the bounded fanout was rejected");
	assert.equal(fake.parallelCalls.length, 0);
});

test("rejects oversized selected results even when intermediate storage permits them", async () => {
	const store = makeStore();
	const value = "x".repeat(100);
	const raw = `workflow({ version: 1, name: "result-limit", description: "Final result limit.", size: "small", permissions: ["read"], phases: ["Run"], steps: [phase("Run", [set("value", ${JSON.stringify(value)})])], result: variable("value") });`;
	const staged = store.stage("result-limit", raw, compileWorkflowSource(raw).manifest);
	const manager = new WorkflowManager({
		store,
		delegation: new FakeDelegation() as unknown as DelegationClient,
		config: resolveConfig({ maxIntermediateBytes: 1_024, maxResultBytes: 32 }),
		readOnlyAgentMap: TEST_READ_ONLY_AGENTS,
	});
	const result = await manager.start(staged, { cwd: store.cwd, sessionId: "session-1", background: false }).done;
	assert.equal(result.run.state, "failed");
	assert.match(result.summary, /final-result limit/);
	assert.equal(fs.existsSync(path.join(result.run.runDir, "result.json")), false);
});

test("rejects oversized set variables and repeat collections", async () => {
	const store = makeStore();
	const largeVariable = "x".repeat(100);
	const setRaw = `workflow({ version: 1, name: "set-limit", description: "Set limit.", size: "small", permissions: ["read"], phases: ["Run"], steps: [phase("Run", [set("value", ${JSON.stringify(largeVariable)})])], result: variable("value") });`;
	const setStaged = store.stage("set-limit", setRaw, compileWorkflowSource(setRaw).manifest);
	const setManager = new WorkflowManager({
		store,
		delegation: new FakeDelegation() as unknown as DelegationClient,
		config: resolveConfig({ maxIntermediateBytes: 32, maxResultBytes: 1_024 }),
		readOnlyAgentMap: TEST_READ_ONLY_AGENTS,
	});
	const setResult = await setManager.start(setStaged, { cwd: store.cwd, sessionId: "session-1", background: false }).done;
	assert.equal(setResult.run.state, "failed");
	assert.match(setResult.summary, /Variable 'value'.*intermediate-value limit/);

	const repeatRaw = `workflow({ version: 1, name: "repeat-limit", description: "Repeat collection limit.", size: "small", permissions: ["read"], phases: ["Run"], maxAgents: 2, steps: [phase("Run", [repeat("rounds", { maxIterations: 2, until: equals(output("step_result", "/done"), true), collectAs: "all_rounds", steps: [run("step", { agent: "pi-workbench.reviewer", saveAs: "step_result", task: "Check", schema: { type: "object", required: ["done", "payload"], properties: { done: { type: "boolean" }, payload: { type: "string" } } } })] })])], result: output("all_rounds") });`;
	const repeatStaged = store.stage("repeat-limit", repeatRaw, compileWorkflowSource(repeatRaw).manifest);
	let calls = 0;
	const fake = new FakeDelegation();
	fake.runSingle = async (task: WorkflowAgentTask) => {
		calls++;
		return { agent: task.agent, status: "completed", output: JSON.stringify({ done: calls === 2, payload: "x".repeat(24) }) };
	};
	const repeatManager = new WorkflowManager({
		store,
		delegation: fake as unknown as DelegationClient,
		config: resolveConfig({ maxIntermediateBytes: 90, maxResultBytes: 1_024 }),
		readOnlyAgentMap: TEST_READ_ONLY_AGENTS,
	});
	const repeatResult = await repeatManager.start(repeatStaged, { cwd: store.cwd, sessionId: "session-1", background: false }).done;
	assert.equal(repeatResult.run.state, "failed");
	assert.match(repeatResult.summary, /repeat 'rounds' collected iterations.*intermediate-value limit/);
});

test("reconciles interrupted durable statuses without hiding terminal history", () => {
	const store = makeStore();
	const raw = fanoutSource();
	const manifest = compileWorkflowSource(raw).manifest;
	function persist(id: string, state: "running" | "completed", createdAt: number): void {
		const runDir = store.createRunDir(id);
		store.writeRunStatus({
			version: 1,
			id,
			name: "fanout-flow",
			state,
			scope: "draft",
			sourcePath: path.join(store.draftRoot, "fanout-flow.workflow.js"),
			sourceHash: "hash",
			runDir,
			cwd: store.cwd,
			sessionId: "session-1",
			manifest,
			policy: resolveWorkflowPolicy(manifest, resolveConfig()),
			createdAt,
			phases: manifest.phases.map((name) => ({ name, status: state === "completed" ? "completed" as const : "running" as const })),
			agentsLaunched: 0,
			agentsCompleted: 0,
			activeAgents: [],
			background: false,
		});
	}
	persist("wf-interrupted", "running", 20);
	persist("wf-complete", "completed", 10);
	const manager = new WorkflowManager({
		store,
		delegation: new FakeDelegation() as unknown as DelegationClient,
		config: resolveConfig(),
		readOnlyAgentMap: TEST_READ_ONLY_AGENTS,
	});
	assert.deepEqual(manager.list().map((entry) => [entry.id, entry.state]), [["wf-interrupted", "failed"], ["wf-complete", "completed"]]);
	assert.match(store.readRunStatus("wf-interrupted")?.error ?? "", /interrupted by a Pi session restart/);
});
