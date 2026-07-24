import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const teamsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-teams-test-"));
process.env.PI_AGENT_TEAMS_ROOT = teamsRoot;

const store = await import("../../extensions/teams/store.ts");

function freshTeam(name: string) {
	const config = store.createTeam(name, "test goal", `sess-${name}`);
	return { config, dir: store.teamDir(name) };
}

function addRunningMembers(dir: string, ...names: string[]): void {
	store.updateConfig(dir, (config) => {
		for (const name of names) {
			config.members.push({ name, role: "test", task: "test", agent: "x", status: "running", spawns: 1, spawnedAt: Date.now() });
		}
	});
}

test("createTeam initializes config, tasks, inboxes, notes; duplicates fail", () => {
	const { config, dir } = freshTeam("alpha");
	assert.equal(config.name, "alpha");
	assert.equal(config.goal, "test goal");
	assert.deepEqual(config.members, []);
	assert.ok(fs.existsSync(path.join(dir, "tasks.json")));
	assert.ok(fs.statSync(path.join(dir, "inboxes")).isDirectory());
	assert.ok(fs.statSync(path.join(dir, "notes")).isDirectory());
	assert.throws(() => store.createTeam("alpha", "again", "sess-alpha"), /already exists/);
	assert.throws(() => store.createTeam("second-alpha", "again", "sess-alpha"), /already owns open team 'alpha'/);
	assert.throws(() => store.createTeam("ownerless", "bad", ""), /persistent lead session id/);
});

test("createTeam serializes duplicate creators before checking ownership", async () => {
	const name = "create-race";
	const dir = store.teamDir(name);
	fs.mkdirSync(path.join(dir, ".lock"), { recursive: true });
	const moduleUrl = pathToFileURL(path.resolve("extensions/teams/store.ts")).href;
	const source = `
		const store = await import(${JSON.stringify(moduleUrl)});
		console.log("ready");
		try {
			store.createTeam(${JSON.stringify(name)}, "goal-" + process.env.TEST_SESSION, process.env.TEST_SESSION);
			console.log("success:" + process.env.TEST_SESSION);
		} catch (error) {
			console.log("error:" + (error instanceof Error ? error.message : String(error)));
		}
	`;
	const launch = (session: string) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", source], {
			env: { ...process.env, PI_AGENT_TEAMS_ROOT: teamsRoot, TEST_SESSION: session },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let error = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { output += chunk; });
		child.stderr.on("data", (chunk) => { error += chunk; });
		const ready = new Promise<void>((resolve) => child.stdout.on("data", () => output.includes("ready") && resolve()));
		const done = new Promise<string>((resolve, reject) => {
			child.on("error", reject);
			child.on("exit", (code) => code === 0 ? resolve(output) : reject(new Error(error || `creator exited ${code}`)));
		});
		return { ready, done };
	};
	const first = launch("session-a");
	const second = launch("session-b");
	await Promise.all([first.ready, second.ready]);
	await new Promise((resolve) => setTimeout(resolve, 100));
	fs.rmSync(path.join(dir, ".lock"), { recursive: true, force: true });
	const outputs = await Promise.all([first.done, second.done]);
	assert.equal(outputs.filter((output) => output.includes("success:")).length, 1);
	assert.equal(outputs.filter((output) => output.includes("already exists")).length, 1);
	const winner = /success:(session-[ab])/.exec(outputs.join("\n"))?.[1];
	assert.equal(store.loadConfig(dir).leadSessionId, winner);
});

test("tasks: deps block claiming until dependencies complete", () => {
	const { dir } = freshTeam("tasks");
	addRunningMembers(dir, "writer", "researcher");
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
	addRunningMembers(dir, "writer", "other");
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
	addRunningMembers(dir, "a", "b");
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
	addRunningMembers(dir, "a");
	for (let i = 1; i <= 3; i++) store.sendMessage(dir, "a", "lead", `m${i}`, []);
	const unread = store.readInbox(dir, "lead", false);
	assert.equal(unread.length, 3);
	store.advanceCursor(dir, "lead", unread[0].ts);
	const remaining = store.readInbox(dir, "lead", false);
	assert.deepEqual(remaining.map((m) => m.message), ["m2", "m3"]);
});

test("mail: inbox is capped and keeps the newest messages", () => {
	const { dir } = freshTeam("cap");
	addRunningMembers(dir, "a");
	for (let i = 1; i <= 510; i++) store.sendMessage(dir, "a", "lead", `msg-${i}`, []);
	const file = path.join(dir, "inboxes", "lead.json");
	const inbox = JSON.parse(fs.readFileSync(file, "utf8")) as Array<{ message: string }>;
	assert.equal(inbox.length, 500);
	assert.equal(inbox[0].message, "msg-11");
	assert.equal(inbox.at(-1)?.message, "msg-510");
});

test("notes: append and read stay inside the member notes directory", () => {
	const { dir } = freshTeam("notes");
	addRunningMembers(dir, "a");
	assert.equal(store.readNotes(dir, "a"), "");
	store.appendNote(dir, "a", "first finding");
	store.appendNote(dir, "a", "second finding");
	const notes = store.readNotes(dir, "a");
	assert.ok(notes.includes("first finding"));
	assert.ok(notes.includes("second finding"));
	for (const unsafe of ["../secret", "../../outside", "/tmp/secret", "a/b", "a\\b", ".", "all"]) {
		assert.throws(() => store.readNotes(dir, unsafe), /Unsafe team member storage key/);
		assert.throws(() => store.appendNote(dir, unsafe, "escape"), /Unsafe team member storage key/);
	}
	const outside = path.join(path.dirname(dir), "outside.md");
	fs.writeFileSync(outside, "outside-secret\n");
	fs.symlinkSync(outside, path.join(dir, "notes", "evil.md"));
	assert.throws(() => store.readNotes(dir, "evil"), /Unsafe symlinked team note/);
	assert.throws(() => store.appendNote(dir, "evil", "overwrite"), /Unsafe symlinked team note/);
	assert.equal(fs.readFileSync(outside, "utf8"), "outside-secret\n");

	const linked = freshTeam("linked-notes").dir;
	const outsideDir = path.join(path.dirname(linked), "outside-notes");
	fs.rmSync(path.join(linked, "notes"), { recursive: true });
	fs.mkdirSync(outsideDir);
	fs.symlinkSync(outsideDir, path.join(linked, "notes"), "dir");
	assert.throws(() => store.readNotes(linked, "a"), /Unsafe symlinked team notes directory/);
});

test("mutations fail atomically once a team is closing or a caller is stopping", () => {
	const { dir } = freshTeam("closing-guards");
	addRunningMembers(dir, "alice");
	store.updateConfig(dir, (config) => { config.members[0]!.status = "stopping"; });
	assert.throws(() => store.sendMessage(dir, "alice", "lead", "late", []), /is stopping/);
	store.updateConfig(dir, (config) => { config.closing = true; });
	assert.throws(() => store.createTask(dir, { title: "late", createdBy: "lead" }), /is closing/);
	assert.throws(() => store.appendNote(dir, "alice", "late", "lead"), /is closing/);
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

test("sanitizeName normalizes names while member names reject reserved identities", () => {
	assert.equal(store.sanitizeName("Research Bot 2"), "research-bot-2");
	assert.equal(store.sanitizeMemberName("Research Bot 2"), "research-bot-2");
	assert.throws(() => store.sanitizeName("!!"), /Invalid/);
	assert.throws(() => store.sanitizeMemberName("lead"), /reserved/);
	assert.throws(() => store.sanitizeMemberName("all"), /reserved/);
});
