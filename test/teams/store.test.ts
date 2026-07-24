import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

process.env.PI_AGENT_TEAMS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-teams-test-"));

const store = await import("../../extensions/teams/store.ts");

function freshTeam(name: string) {
	const config = store.createTeam(name, "test goal", "sess-test");
	return { config, dir: store.teamDir(name) };
}

test("createTeam initializes config, tasks, inboxes, notes; duplicates fail", () => {
	const { config, dir } = freshTeam("alpha");
	assert.equal(config.name, "alpha");
	assert.equal(config.goal, "test goal");
	assert.deepEqual(config.members, []);
	assert.ok(fs.existsSync(path.join(dir, "tasks.json")));
	assert.ok(fs.statSync(path.join(dir, "inboxes")).isDirectory());
	assert.ok(fs.statSync(path.join(dir, "notes")).isDirectory());
	assert.throws(() => store.createTeam("alpha", "again"), /already exists/);
});

test("tasks: deps block claiming until dependencies complete", () => {
	const { dir } = freshTeam("tasks");
	store.createTask(dir, { title: "research", createdBy: "lead" });
	store.createTask(dir, { title: "implement", deps: ["t1"], createdBy: "lead" });

	const decorated = store.decorateTasks(store.listTasks(dir));
	assert.equal(decorated.find((t) => t.id === "t2")?.blocked, true);
	assert.throws(() => store.claimTask(dir, "t2", "writer"), /blocked/);

	const claimed = store.claimNextTask(dir, "researcher");
	assert.equal(claimed?.id, "t1");
	assert.equal(claimed?.owner, "researcher");

	store.completeTask(dir, "t1", "researcher");
	assert.equal(store.decorateTasks(store.listTasks(dir)).find((t) => t.id === "t2")?.blocked, false);
});

test("tasks: unknown dependency ids are rejected", () => {
	const { dir } = freshTeam("baddeps");
	assert.throws(() => store.createTask(dir, { title: "x", deps: ["t99"], createdBy: "lead" }), /does not exist/);
});

test("tasks: ownership is enforced for claim and complete", () => {
	const { dir } = freshTeam("owners");
	store.createTask(dir, { title: "owned work", createdBy: "lead" });
	store.claimTask(dir, "t1", "writer");
	assert.throws(() => store.claimTask(dir, "t1", "other"), /owned by 'writer'/);
	assert.throws(() => store.completeTask(dir, "t1", "other"), /only the owner or the lead/);
	// The lead may complete anyone's task.
	const done = store.completeTask(dir, "t1", "lead");
	assert.equal(done.status, "completed");
	assert.throws(() => store.claimTask(dir, "t1", "writer"), /already completed/);
});

test("tasks: claimNext skips owned and blocked tasks", () => {
	const { dir } = freshTeam("nextskip");
	store.createTask(dir, { title: "first", createdBy: "lead" });
	store.createTask(dir, { title: "second", deps: ["t1"], createdBy: "lead" });
	store.claimTask(dir, "t1", "a");
	assert.equal(store.claimNextTask(dir, "b"), null);
});

test("mail: cursor semantics — unread drains once, broadcast fans out", () => {
	const { dir } = freshTeam("mail");
	store.updateConfig(dir, (c) => {
		c.members.push(
			{ name: "a", role: "r", task: "t", agent: "x", status: "running", spawns: 1, spawnedAt: Date.now() },
			{ name: "b", role: "r", task: "t", agent: "x", status: "running", spawns: 1, spawnedAt: Date.now() },
		);
	});

	const delivered = store.sendMessage(dir, "lead", "all", "hello team", ["a", "b"]);
	assert.deepEqual(delivered.sort(), ["a", "b"]);
	// Sender excluded from own broadcast.
	const selfDelivered = store.sendMessage(dir, "a", "all", "ping", ["a", "b"]);
	assert.deepEqual(selfDelivered.sort(), ["b", "lead"]);

	const first = store.readInbox(dir, "b", true);
	assert.equal(first.length, 2);
	assert.equal(store.readInbox(dir, "b", true).length, 0);
	// markRead=false does not advance the cursor.
	assert.equal(store.readInbox(dir, "lead", false).length, 1);
	assert.equal(store.readInbox(dir, "lead", false).length, 1);
});

test("mail: advanceCursor delivers only up to the watermark", () => {
	const { dir } = freshTeam("cursor");
	for (let i = 1; i <= 3; i++) store.sendMessage(dir, "a", "lead", `m${i}`, []);
	const unread = store.readInbox(dir, "lead", false);
	assert.equal(unread.length, 3);
	store.advanceCursor(dir, "lead", unread[0].ts);
	const remaining = store.readInbox(dir, "lead", false);
	assert.deepEqual(remaining.map((m) => m.message), ["m2", "m3"]);
});

test("mail: inbox is capped and keeps the newest messages", () => {
	const { dir } = freshTeam("cap");
	for (let i = 1; i <= 510; i++) store.sendMessage(dir, "a", "lead", `msg-${i}`, []);
	const file = path.join(dir, "inboxes", "lead.json");
	const inbox = JSON.parse(fs.readFileSync(file, "utf8")) as Array<{ message: string }>;
	assert.equal(inbox.length, 500);
	assert.equal(inbox[0].message, "msg-11");
	assert.equal(inbox.at(-1)?.message, "msg-510");
});

test("notes: append and read round-trip", () => {
	const { dir } = freshTeam("notes");
	assert.equal(store.readNotes(dir, "a"), "");
	store.appendNote(dir, "a", "first finding");
	store.appendNote(dir, "a", "second finding");
	const notes = store.readNotes(dir, "a");
	assert.ok(notes.includes("first finding"));
	assert.ok(notes.includes("second finding"));
});

test("identity: findMemberByRunId resolves team and member", () => {
	const { dir } = freshTeam("identity");
	store.updateConfig(dir, (c) => {
		c.members.push({ name: "checker", role: "r", task: "t", agent: "x", runId: "run-abc", status: "running", spawns: 1, spawnedAt: Date.now() });
	});
	const found = store.findMemberByRunId("run-abc");
	assert.equal(found?.team, "identity");
	assert.equal(found?.member.name, "checker");
	assert.equal(store.findMemberByRunId("nope"), null);
});

test("locking: stale locks are broken, concurrent sections serialize", () => {
	const { dir } = freshTeam("locks");
	// Plant a stale lock older than the stale threshold.
	const lockPath = path.join(dir, ".lock");
	fs.mkdirSync(lockPath);
	const old = new Date(Date.now() - 60_000);
	fs.utimesSync(lockPath, old, old);
	let ran = false;
	store.withLock(dir, () => {
		ran = true;
	});
	assert.equal(ran, true);

	// Mutations under the same lock do not interleave-corrupt.
	store.updateConfig(dir, (c) => {
		c.members.push({ name: "x", role: "r", task: "t", agent: "a", status: "idle", spawns: 1, spawnedAt: 1 });
	});
	assert.equal(store.loadConfig(dir).members.length, 1);
});

test("sanitizeName normalizes and rejects bad names", () => {
	assert.equal(store.sanitizeName("Research Bot 2"), "research-bot-2");
	assert.throws(() => store.sanitizeName("!!"), /Invalid/);
});
