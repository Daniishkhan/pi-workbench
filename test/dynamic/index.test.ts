import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WriterCoordinator, WriterLease } from "../../extensions/core/writer-coordinator.ts";
import registerDynamicWorkflows from "../../extensions/dynamic/index.ts";

const REQUEST = "prompt-template:subagent:request";
const RESPONSE = "prompt-template:subagent:response";
const CANCEL = "prompt-template:subagent:cancel";
const roots: string[] = [];

afterEach(() => {
	delete process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_CODING_AGENT_DIR;
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

class FakeBus {
	readonly handlers = new Map<string, Set<(payload: unknown) => void>>();
	on(event: string, handler: (payload: unknown) => void): () => void {
		let handlers = this.handlers.get(event);
		if (!handlers) this.handlers.set(event, handlers = new Set());
		handlers.add(handler);
		return () => handlers!.delete(handler);
	}
	emit(event: string, payload: unknown): void {
		for (const handler of [...(this.handlers.get(event) ?? [])]) handler(payload);
	}
}

interface RegisteredTool {
	name: string;
	execute: (id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<unknown>;
}

interface RegisteredCommand {
	name: string;
	handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
}

class FakePi {
	readonly events = new FakeBus();
	readonly tools = new Map<string, RegisteredTool>();
	readonly commands = new Map<string, RegisteredCommand>();
	readonly lifecycle = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	readonly entries: Array<{ type: string; data: unknown }> = [];
	readonly messages: unknown[] = [];

	registerTool(tool: RegisteredTool): void { this.tools.set(tool.name, tool); }
	registerCommand(name: string, command: Omit<RegisteredCommand, "name">): void { this.commands.set(name, { name, ...command }); }
	getCommands(): Array<{ name: string }> { return [...this.commands.values()].map(({ name }) => ({ name })); }
	registerMessageRenderer(): void {}
	on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): void {
		const handlers = this.lifecycle.get(event) ?? [];
		handlers.push(handler);
		this.lifecycle.set(event, handlers);
	}
	appendEntry(type: string, data: unknown): void { this.entries.push({ type, data }); }
	sendMessage(message: unknown): void { this.messages.push(message); }
	sendUserMessage(): void {}
	async emitLifecycle(event: string, ctx: ExtensionContext): Promise<void> {
		for (const handler of this.lifecycle.get(event) ?? []) await handler({}, ctx);
	}
}

class RecordingWriterCoordinator {
	readonly acquired: Array<{ cwd: string; owner: string; token: string }> = [];
	readonly attached: Array<{ token: string | undefined; runId: string | undefined }> = [];
	readonly released: Array<string | undefined> = [];
	acquire(cwd: string, owner: string): WriterLease {
		const token = `lease-${this.acquired.length + 1}`;
		this.acquired.push({ cwd, owner, token });
		return { version: 1, token, cwd, owner, createdAt: Date.now(), pid: process.pid };
	}
	attachRun(token: string | undefined, runId: string | undefined): void { this.attached.push({ token, runId }); }
	release(token: string | undefined): boolean { this.released.push(token); return true; }
}

function makeHarness(editor: (title: string, text: string) => Promise<string | undefined>): {
	root: string;
	pi: FakePi;
	ctx: ExtensionContext;
	confirmations: Array<{ title: string; body: string }>;
	notifications: Array<{ text: string; level: string }>;
} {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workbench-dynamic-index-"));
	roots.push(root);
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "project");
	fs.mkdirSync(cwd, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const pi = new FakePi();
	const confirmations: Array<{ title: string; body: string }> = [];
	const notifications: Array<{ text: string; level: string }> = [];
	const ctx = {
		cwd,
		hasUI: true,
		mode: "tui",
		model: { provider: "provider", id: "model" },
		isProjectTrusted: () => true,
		isIdle: () => true,
		sessionManager: { getSessionId: () => "index-session" },
		ui: {
			editor,
			confirm: async (title: string, body: string) => { confirmations.push({ title, body }); return true; },
			notify: (text: string, level: string) => { notifications.push({ text, level }); },
			setStatus: () => undefined,
			setWidget: () => undefined,
			select: async () => undefined,
		},
	} as unknown as ExtensionContext;
	return { root, pi, ctx, confirmations, notifications };
}

function workflowSource(name: string, marker: string, write = false): string {
	return `workflow({
  version: 1,
  name: "${name}",
  description: "Index integration test.",
  size: "small",
  permissions: ["read"${write ? ', "write"' : ""}],
  phases: ["Run"],
  maxAgents: 1,
  steps: [phase("Run", [run("task", { agent: "${write ? "pi-workbench.worker" : "pi-workbench.reviewer"}", saveAs: "result", ${write ? "write: true, " : ""}task: "${marker}" })])],
  result: output("result")
});`;
}

function autoComplete(pi: FakePi, requests: Array<Record<string, unknown>>): void {
	pi.events.on(REQUEST, (payload) => {
		const request = payload as Record<string, unknown>;
		requests.push(request);
		queueMicrotask(() => pi.events.emit(RESPONSE, {
			version: 1,
			requestId: request.requestId,
			status: "completed",
			agent: request.agent,
			output: `completed:${request.task}`,
		}));
	});
}

test("child sessions register no Dynamic Workflows surface", () => {
	process.env.PI_SUBAGENT_CHILD = "1";
	const pi = new FakePi();
	registerDynamicWorkflows(pi as unknown as ExtensionAPI);
	assert.equal(pi.tools.size, 0);
	assert.equal(pi.commands.size, 0);
	assert.equal(pi.lifecycle.size, 0);
});

test("executes the exact edited draft and acquires its compiled write manifest", async () => {
	const edited = workflowSource("edited-flow", "EDITED WRITER", true);
	const harness = makeHarness(async () => edited);
	const coordinator = new RecordingWriterCoordinator();
	const requests: Array<Record<string, unknown>> = [];
	autoComplete(harness.pi, requests);
	registerDynamicWorkflows(harness.pi as unknown as ExtensionAPI, { writerCoordinator: coordinator as unknown as WriterCoordinator });
	await harness.pi.emitLifecycle("session_start", harness.ctx);

	await harness.pi.tools.get("dynamic_create")!.execute(
		"create",
		{ name: "edited-flow", source: workflowSource("edited-flow", "ORIGINAL READ") },
		undefined,
		undefined,
		harness.ctx,
	);
	const run = await harness.pi.tools.get("dynamic_run")!.execute(
		"run",
		{ name: "edited-flow", input: {}, background: false },
		undefined,
		undefined,
		harness.ctx,
	) as { details: { run: { state: string } } };

	assert.equal(run.details.run.state, "completed");
	assert.equal(requests.length, 1);
	assert.equal(requests[0]?.agent, "pi-workbench.worker", "writers must remain unremapped");
	assert.match(String(requests[0]?.task), /EDITED WRITER$/);
	assert.doesNotMatch(String(requests[0]?.task), /ORIGINAL READ/);
	assert.equal(coordinator.acquired.length, 1);
	assert.equal(coordinator.acquired[0]?.owner, "dynamic:edited-flow");
	assert.equal(coordinator.attached.length, 1);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(coordinator.released, [coordinator.acquired[0]?.token]);
	assert.match(harness.confirmations.at(-1)?.body ?? "", /Permissions: read, write/);
	const staged = path.join(harness.root, "agent", "workbench", "dynamic", "drafts", "index-session", "edited-flow.workflow.js");
	assert.equal(fs.readFileSync(staged, "utf8"), `${edited}\n`);
	assert.equal(harness.pi.entries.at(-1)?.type, "pi-workbench:dynamic:run");
	await harness.pi.emitLifecycle("session_shutdown", harness.ctx);
});

test("keeps the writer lease until delegated cancellation is terminally acknowledged", async () => {
	const source = workflowSource("cancel-flow", "WAIT FOR CANCEL", true);
	const harness = makeHarness(async () => source);
	const coordinator = new RecordingWriterCoordinator();
	let request: Record<string, unknown> | undefined;
	let cancellation: Record<string, unknown> | undefined;
	harness.pi.events.on(REQUEST, (payload) => { request = payload as Record<string, unknown>; });
	harness.pi.events.on(CANCEL, (payload) => { cancellation = payload as Record<string, unknown>; });
	registerDynamicWorkflows(harness.pi as unknown as ExtensionAPI, { writerCoordinator: coordinator as unknown as WriterCoordinator });
	await harness.pi.emitLifecycle("session_start", harness.ctx);
	await harness.pi.tools.get("dynamic_create")!.execute("create", { name: "cancel-flow", source }, undefined, undefined, harness.ctx);
	const controller = new AbortController();
	const running = harness.pi.tools.get("dynamic_run")!.execute("run", { name: "cancel-flow", input: {}, background: false }, controller.signal, undefined, harness.ctx);
	for (let index = 0; index < 20 && !request; index++) await new Promise((resolve) => setImmediate(resolve));
	assert.ok(request);
	controller.abort();
	for (let index = 0; index < 20 && !cancellation; index++) await new Promise((resolve) => setImmediate(resolve));
	assert.equal(cancellation?.version, 1);
	assert.equal(coordinator.released.length, 0, "a terminating child still owns the canonical worktree");
	harness.pi.events.emit(RESPONSE, {
		version: 1,
		requestId: request!.requestId,
		status: "cancelled",
		agent: request!.agent,
		output: "",
	});
	const result = await running as { details: { run: { state: string } } };
	assert.equal(result.details.run.state, "stopped");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(coordinator.released, [coordinator.acquired[0]?.token]);
	await harness.pi.emitLifecycle("session_shutdown", harness.ctx);
});

test("recompiles trusted saved bytes before writer leasing instead of trusting stale metadata", async () => {
	const source = workflowSource("metadata-flow", "METADATA WRITER", true);
	const harness = makeHarness(async () => source);
	const coordinator = new RecordingWriterCoordinator();
	const requests: Array<Record<string, unknown>> = [];
	autoComplete(harness.pi, requests);
	registerDynamicWorkflows(harness.pi as unknown as ExtensionAPI, { writerCoordinator: coordinator as unknown as WriterCoordinator });
	await harness.pi.emitLifecycle("session_start", harness.ctx);
	await harness.pi.tools.get("dynamic_create")!.execute("create", { name: "metadata-flow", source }, undefined, undefined, harness.ctx);
	await harness.pi.tools.get("dynamic_control")!.execute("save", { action: "save", name: "metadata-flow", scope: "user" }, undefined, undefined, harness.ctx);
	const metadataPath = path.join(harness.root, "agent", "workbench", "dynamic", "saved", "metadata-flow.workflow.json");
	const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as { manifest: { permissions: string[] } };
	metadata.manifest.permissions = ["read"];
	fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
	await harness.pi.tools.get("dynamic_run")!.execute("run", { name: "metadata-flow", input: {}, background: false }, undefined, undefined, harness.ctx);
	for (let index = 0; index < 20 && requests.length === 0; index++) await new Promise((resolve) => setImmediate(resolve));
	assert.equal(requests[0]?.agent, "pi-workbench.worker");
	assert.equal(coordinator.acquired.length, 1, "compiled source permissions—not mutable metadata—must control writer ownership");
	assert.match(harness.confirmations.at(-1)?.body ?? "", /Permissions: read, write/);
	await harness.pi.emitLifecycle("session_shutdown", harness.ctx);
});

test("an exact reviewed save remains reusable without registering a slash command", async () => {
	const original = workflowSource("saved-flow", "UNREVIEWED ORIGINAL");
	const saved = workflowSource("saved-flow", "SAVED SOURCE");
	const edits = [saved, saved];
	const harness = makeHarness(async () => edits.shift());
	const requests: Array<Record<string, unknown>> = [];
	autoComplete(harness.pi, requests);
	registerDynamicWorkflows(harness.pi as unknown as ExtensionAPI);
	await harness.pi.emitLifecycle("session_start", harness.ctx);

	await harness.pi.tools.get("dynamic_create")!.execute("create", { name: "saved-flow", source: original }, undefined, undefined, harness.ctx);
	await harness.pi.tools.get("dynamic_control")!.execute("save", { action: "save", name: "saved-flow", scope: "user" }, undefined, undefined, harness.ctx);
	assert.equal(harness.pi.commands.size, 0, "Dynamic Workflows must not create standalone slash commands");
	await harness.pi.tools.get("dynamic_run")!.execute("run", { name: "saved-flow", input: {}, background: false }, undefined, undefined, harness.ctx);
	for (let index = 0; index < 20 && requests.length === 0; index++) await new Promise((resolve) => setImmediate(resolve));

	assert.equal(requests.length, 1);
	assert.match(String(requests[0]?.task), /SAVED SOURCE$/);
	assert.doesNotMatch(String(requests[0]?.task), /UNREVIEWED ORIGINAL/);
	assert.equal(harness.notifications.some((entry) => entry.level === "error"), false);
	await harness.pi.emitLifecycle("session_shutdown", harness.ctx);
});

test("publishes active runs to the pi-subagents background-work provider", async () => {
	const source = workflowSource("provider-flow", "WAIT FOR ME");
	const harness = makeHarness(async () => source);
	interface Provider {
		name: string;
		listActiveWork(): Array<{ id: string; sessionId: string }>;
	}
	let provider: Provider | undefined;
	registerDynamicWorkflows(harness.pi as unknown as ExtensionAPI, {
		registerBackgroundWork: (candidate) => {
			provider = candidate as unknown as Provider;
			return () => { provider = undefined; };
		},
	});
	await harness.pi.emitLifecycle("session_start", harness.ctx);
	assert.equal(provider?.name, "pi-workbench:dynamic-workflows");
	assert.deepEqual(provider?.listActiveWork(), []);

	let request: Record<string, unknown> | undefined;
	harness.pi.events.on(REQUEST, (payload) => { request = payload as Record<string, unknown>; });
	await harness.pi.tools.get("dynamic_create")!.execute("create", { name: "provider-flow", source }, undefined, undefined, harness.ctx);
	const started = await harness.pi.tools.get("dynamic_run")!.execute(
		"run",
		{ name: "provider-flow", input: {}, background: true },
		undefined,
		undefined,
		harness.ctx,
	) as { details: { run: { id: string; state: string } } };
	for (let index = 0; index < 20 && !request; index++) await new Promise((resolve) => setImmediate(resolve));
	assert.ok(request);
	assert.deepEqual(provider?.listActiveWork(), [{ id: started.details.run.id, sessionId: "index-session" }]);

	harness.pi.events.emit(RESPONSE, {
		version: 1,
		requestId: request.requestId,
		status: "completed",
		agent: request.agent,
		output: "done",
	});
	for (let index = 0; index < 40 && provider?.listActiveWork().length !== 0; index++) await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(provider?.listActiveWork(), [], "terminal runs must leave the background-work snapshot");
	await harness.pi.emitLifecycle("session_shutdown", harness.ctx);
});

test("an initialization failure surfaces at session start and in later tool calls", async () => {
	const harness = makeHarness(async () => "unreachable");
	// Force initialize() to fail: the pinned-agent directory collides with a file.
	const agentsPath = path.join(harness.root, "agent", "agents");
	fs.mkdirSync(path.dirname(agentsPath), { recursive: true });
	fs.writeFileSync(agentsPath, "not a directory\n");
	registerDynamicWorkflows(harness.pi as unknown as ExtensionAPI);
	await harness.pi.emitLifecycle("session_start", harness.ctx);
	const failure = harness.notifications.find((entry) => entry.level === "error");
	assert.ok(failure, "session_start must surface the initialization failure");
	assert.match(failure!.text, /Dynamic Workflows failed to initialize/);
	await assert.rejects(
		() => harness.pi.tools.get("dynamic_create")!.execute("create", { name: "x", source: "workflow({})" }, undefined, undefined, harness.ctx),
		/failed to initialize/,
	);
	await harness.pi.emitLifecycle("session_shutdown", harness.ctx);
});
