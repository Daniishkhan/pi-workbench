import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentRpcClient } from "../../extensions/core/subagent-rpc.ts";
import type { WriterCoordinator } from "../../extensions/core/writer-coordinator.ts";
import type { MemberStatus } from "../../extensions/teams/store.ts";

const teamsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-teams-index-test-"));
process.env.PI_AGENT_TEAMS_ROOT = teamsRoot;

const store = await import("../../extensions/teams/store.ts");
const { isConfirmedTerminalRunArtifact } = await import("../../extensions/core/run-lifecycle.ts");
const { default: registerTeams } = await import("../../extensions/teams/index.ts");

after(() => fs.rmSync(teamsRoot, { recursive: true, force: true }));

interface ToolDefinition {
	execute: (id: string, params: Record<string, any>, signal: AbortSignal | undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<any>;
}

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

class FakePi {
	readonly events = new FakeBus();
	readonly tools = new Map<string, ToolDefinition>();
	readonly lifecycle = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	readonly entries: Array<{ type: string; data: unknown }> = [];
	readonly messages: unknown[] = [];
	registerTool(tool: ToolDefinition & { name: string }): void { this.tools.set(tool.name, tool); }
	on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): void {
		const handlers = this.lifecycle.get(event) ?? [];
		handlers.push(handler);
		this.lifecycle.set(event, handlers);
	}
	appendEntry(type: string, data: unknown): void { this.entries.push({ type, data }); }
	sendMessage(message: unknown): void { this.messages.push(message); }
	async emitLifecycle(event: string, ctx: ExtensionContext): Promise<void> {
		for (const handler of this.lifecycle.get(event) ?? []) await handler({}, ctx);
	}
}

class FakeRpc {
	readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
	readonly reply: (method: string, params: Record<string, unknown>) => Record<string, unknown>;
	constructor(reply: (method: string, params: Record<string, unknown>) => Record<string, unknown>) { this.reply = reply; }
	async request(method: string, params: Record<string, unknown>): Promise<any> {
		this.calls.push({ method, params });
		return this.reply(method, params);
	}
}

function activeEntry(team: string | null) {
	return { type: "custom", customType: "pi-agent-teams:active", data: { team } };
}

function context(sessionId: string, initialBranch: unknown[] = []) {
	let branch = initialBranch;
	let entries = initialBranch;
	const ctx = {
		cwd: process.cwd(),
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => branch,
			getEntries: () => entries,
		},
	} as unknown as ExtensionContext;
	return {
		ctx,
		setBranch(value: unknown[]) { branch = value; },
		setEntries(value: unknown[]) { entries = value; },
	};
}

async function execute(pi: FakePi, name: string, params: Record<string, unknown>, ctx: ExtensionContext): Promise<any> {
	const tool = pi.tools.get(name);
	assert.ok(tool, `missing tool ${name}`);
	return tool.execute(`call-${name}`, params, undefined, undefined, ctx);
}

function addMember(dir: string, input: { name: string; runId: string; status?: MemberStatus }): void {
	store.updateConfig(dir, (config) => {
		config.members.push({
			name: input.name,
			role: "test",
			task: "test",
			agent: "pi-agent-teams.scout",
			runId: input.runId,
			status: input.status ?? "running",
			spawns: 1,
			spawnedAt: Date.now(),
		});
	});
}

test("provisional stopped/failed status is not terminal before endedAt or a result artifact", () => {
	assert.equal(isConfirmedTerminalRunArtifact("stopped", false), false);
	assert.equal(isConfirmedTerminalRunArtifact("failed", false), false);
	assert.equal(isConfirmedTerminalRunArtifact("stopped", false, Date.now()), true);
	assert.equal(isConfirmedTerminalRunArtifact("failed", true), true);
	assert.equal(isConfirmedTerminalRunArtifact("running", true, Date.now()), false);
});

test("child identity is authenticated by run id and assertions cannot impersonate", async () => {
	const config = store.createTeam("child-auth", "test", "lead-session");
	const dir = store.teamDir(config.name);
	addMember(dir, { name: "alice", runId: "run-alice" });
	addMember(dir, { name: "bob", runId: "run-bob" });
	store.createTeam("other-team", "test", "other-lead");

	const pi = new FakePi();
	registerTeams(pi as unknown as ExtensionAPI, { childSession: true, runId: "run-alice" });
	const harness = context("child-session");
	const peers = await execute(pi, "team_peers", {}, harness.ctx);
	assert.equal(peers.details.you, "alice");
	await assert.rejects(() => execute(pi, "team_peers", { team: "child-auth", member: "bob" }, harness.ctx), /Member assertion.*run-id identity/);
	await assert.rejects(() => execute(pi, "team_peers", { team: "other-team", member: "alice" }, harness.ctx), /Team assertion.*run-id identity/);

	const unrelated = new FakePi();
	registerTeams(unrelated as unknown as ExtensionAPI, { childSession: true, runId: "" });
	await assert.rejects(
		() => execute(unrelated, "team_peers", { team: "child-auth", member: "alice" }, harness.ctx),
		/not a registered team teammate/,
	);

	addMember(dir, { name: "lead", runId: "legacy-lead" });
	const legacyLead = new FakePi();
	registerTeams(legacyLead as unknown as ExtensionAPI, { childSession: true, runId: "legacy-lead" });
	await assert.rejects(() => execute(legacyLead, "team_inbox", { markRead: false }, harness.ctx), /Reserved legacy member 'lead'/);
});

test("team_notes accepts roster targets but rejects traversal and cross-member append", async () => {
	const config = store.createTeam("notes-auth", "test", "notes-lead-session");
	const dir = store.teamDir(config.name);
	addMember(dir, { name: "alice", runId: "notes-alice" });
	addMember(dir, { name: "bob", runId: "notes-bob" });
	const pi = new FakePi();
	registerTeams(pi as unknown as ExtensionAPI, { childSession: true, runId: "notes-alice" });
	const harness = context("child-session");

	await execute(pi, "team_notes", { action: "append", content: "alice note" }, harness.ctx);
	const own = await execute(pi, "team_notes", { action: "read" }, harness.ctx);
	assert.match(own.details.notes, /alice note/);
	await execute(pi, "team_notes", { action: "read", member: "bob" }, harness.ctx);
	await assert.rejects(() => execute(pi, "team_notes", { action: "read", member: "../../../private/secret" }, harness.ctx), /Unknown notes target/);
	await assert.rejects(() => execute(pi, "team_notes", { action: "append", member: "bob", content: "forged" }, harness.ctx), /only append to their own notes/);
});

test("lead access follows the active branch and exact creating session", async () => {
	store.createTeam("branch-owned", "test", "session-a");
	store.createTeam("sibling-team", "test", "sibling-session");
	store.createTeam("foreign-team", "test", "session-b");
	const pi = new FakePi();
	const harness = context("session-a", [activeEntry("branch-owned")]);
	// A later marker on a sibling branch must not override the active branch.
	harness.setEntries([activeEntry("branch-owned"), activeEntry("sibling-team")]);
	registerTeams(pi as unknown as ExtensionAPI, { rpc: new FakeRpc(() => ({ success: true })) as unknown as SubagentRpcClient });
	await pi.emitLifecycle("session_start", harness.ctx);
	const status = await execute(pi, "team_status", {}, harness.ctx);
	assert.equal(status.details.team, "branch-owned");
	await assert.rejects(() => execute(pi, "team_status", { team: "sibling-team" }, harness.ctx), /does not match.*active team/);

	harness.setBranch([]);
	await pi.emitLifecycle("session_tree", harness.ctx);
	await assert.rejects(() => execute(pi, "team_status", {}, harness.ctx), /No active team/);
	harness.setBranch([activeEntry("branch-owned")]);
	await pi.emitLifecycle("session_tree", harness.ctx);
	assert.equal((await execute(pi, "team_status", {}, harness.ctx)).details.team, "branch-owned");
	await pi.emitLifecycle("session_shutdown", harness.ctx);

	const foreignPi = new FakePi();
	const foreignHarness = context("session-a", [activeEntry("foreign-team")]);
	registerTeams(foreignPi as unknown as ExtensionAPI, { rpc: new FakeRpc(() => ({ success: true })) as unknown as SubagentRpcClient });
	await foreignPi.emitLifecycle("session_start", foreignHarness.ctx);
	await assert.rejects(() => execute(foreignPi, "team_status", {}, foreignHarness.ctx), /No active team/);
	await foreignPi.emitLifecycle("session_shutdown", foreignHarness.ctx);
});

test("team_spawn rejects unknown read-only self-attestation and unauthenticated spawn replies", async () => {
	const config = store.createTeam("spawn-auth", "test", "spawn-session");
	const dir = store.teamDir(config.name);
	const rpc = new FakeRpc(() => ({ success: true, data: {} }));
	const pi = new FakePi();
	const harness = context("spawn-session", [activeEntry("spawn-auth")]);
	registerTeams(pi as unknown as ExtensionAPI, { rpc: rpc as unknown as SubagentRpcClient });
	await pi.emitLifecycle("session_start", harness.ctx);
	await assert.rejects(
		() => execute(pi, "team_spawn", { name: "custom", role: "test", task: "test", agent: "custom.agent", write: false }, harness.ctx),
		/cannot self-declare as read-only/,
	);
	assert.equal(rpc.calls.length, 0);
	await assert.rejects(
		() => execute(pi, "team_spawn", { name: "scout", role: "test", task: "test", agent: "pi-agent-teams.scout", write: false }, harness.ctx),
		/accepted without a run id/,
	);
	assert.deepEqual(store.loadConfig(dir).members, []);
	await pi.emitLifecycle("session_shutdown", harness.ctx);
});

test("failed disband stays open, keeps failed stops running, and blocks stopping callers", async () => {
	const config = store.createTeam("partial-stop", "test", "stop-session");
	const dir = store.teamDir(config.name);
	addMember(dir, { name: "alice", runId: "stop-alice" });
	addMember(dir, { name: "bob", runId: "stop-bob" });
	const rpc = new FakeRpc((_method, params) => params.id === "stop-alice"
		? { success: true }
		: { success: false, error: { message: "stop timed out" } });
	const pi = new FakePi();
	const harness = context("stop-session", [activeEntry("partial-stop")]);
	registerTeams(pi as unknown as ExtensionAPI, { rpc: rpc as unknown as SubagentRpcClient });
	await pi.emitLifecycle("session_start", harness.ctx);
	const result = await execute(pi, "team_disband", {}, harness.ctx);
	assert.equal(result.details.closed, false);
	assert.equal(result.details.closing, false);
	const after = store.loadConfig(dir);
	assert.equal(after.closed, false);
	assert.equal(after.members.find((member) => member.name === "alice")?.status, "stopping");
	assert.equal(after.members.find((member) => member.name === "bob")?.status, "running");
	await assert.rejects(
		() => execute(pi, "team_spawn", { name: "alice", role: "x", task: "x" }, harness.ctx),
		/is stopping/,
	);

	const child = new FakePi();
	registerTeams(child as unknown as ExtensionAPI, { childSession: true, runId: "stop-alice" });
	await assert.rejects(
		() => execute(child, "team_send", { to: "lead", message: "late mutation" }, harness.ctx),
		/is stopping; cannot send team mail/,
	);
	await pi.emitLifecycle("session_shutdown", harness.ctx);
});

test("fully acknowledged disband closes only after terminal completion and retains the writer lease until then", async () => {
	const config = store.createTeam("closing-team", "test", "closing-session");
	const dir = store.teamDir(config.name);
	addMember(dir, { name: "alice", runId: "closing-alice" });
	const releasedRuns: string[] = [];
	const writerCoordinator = { releaseRun(runId: string) { releasedRuns.push(runId); return true; } } as unknown as WriterCoordinator;
	const pi = new FakePi();
	const harness = context("closing-session", [activeEntry("closing-team")]);
	registerTeams(pi as unknown as ExtensionAPI, {
		rpc: new FakeRpc(() => ({ success: true })) as unknown as SubagentRpcClient,
		writerCoordinator,
	});
	await pi.emitLifecycle("session_start", harness.ctx);
	const disband = await execute(pi, "team_disband", {}, harness.ctx);
	assert.equal(disband.details.closed, false);
	assert.equal(disband.details.closing, true);
	assert.equal(store.loadConfig(dir).members[0]?.status, "stopping");
	assert.deepEqual(releasedRuns, []);
	await assert.rejects(() => execute(pi, "team_tasks", { action: "create", title: "late" }, harness.ctx), /is closing/);

	pi.events.emit("subagent:async-complete", { runId: "closing-alice", status: "stopped", summary: "stopped" });
	const closed = store.loadConfig(dir);
	assert.equal(closed.closed, true);
	assert.equal(closed.closing, false);
	assert.equal(closed.members[0]?.status, "stopped");
	assert.deepEqual(releasedRuns, ["closing-alice"]);
	assert.deepEqual(pi.entries.at(-1), { type: "pi-agent-teams:active", data: { team: null } });
	await pi.emitLifecycle("session_shutdown", harness.ctx);
});
