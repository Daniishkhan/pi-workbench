/**
 * Team storage layer for pi-agent-teams.
 *
 * Layout on disk (mirrors the Claude Code agent-teams model):
 *
 *   ~/.pi/agent/teams/<team>/
 *     config.json            team metadata + member roster
 *     tasks.json             shared task list
 *     inboxes/<member>.json  mailbox per member ("lead" is the lead's mailbox)
 *     inboxes/<member>.cursor  read cursor (timestamp watermark) per member
 *     notes/<member>.md      continuity notes per member
 *
 * All mutations go through a mkdir-based lock so multiple Pi processes
 * (lead + teammates) can share state safely. Writes are atomic
 * (write temp file in the same directory, then rename).
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type MemberStatus = "running" | "stopping" | "idle" | "failed" | "stopped";
export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TeamMember {
	name: string;
	role: string;
	task: string;
	agent: string;
	runId?: string;
	status: MemberStatus;
	spawns: number;
	spawnedAt: number;
	endedAt?: number;
	lastSummary?: string;
	model?: string;
}

export interface TeamConfig {
	version: 1;
	name: string;
	goal: string;
	leadSessionId?: string;
	createdAt: number;
	/** A disband was accepted for every active member; mutations stay blocked
	 * while the lead waits for terminal completion artifacts. */
	closing?: boolean;
	closed: boolean;
	members: TeamMember[];
}

export interface TeamTask {
	id: string;
	title: string;
	description?: string;
	status: TaskStatus;
	owner?: string;
	deps: string[];
	createdBy: string;
	createdAt: number;
	updatedAt: number;
}

export interface TeamMessage {
	id: string;
	from: string;
	to: string;
	ts: number;
	message: string;
}

export const LEAD = "lead";

export function teamsRoot(): string {
	const override = process.env.PI_AGENT_TEAMS_ROOT?.trim();
	if (override) return path.resolve(override);
	return path.join(os.homedir(), ".pi", "agent", "teams");
}

export function sanitizeName(raw: string): string {
	const cleaned = raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40);
	if (cleaned.length < 2) throw new Error(`Invalid team/member name: '${raw}'. Use 2-40 chars of a-z, 0-9, '-'.`);
	return cleaned;
}

export function sanitizeMemberName(raw: string): string {
	const cleaned = sanitizeName(raw);
	if (cleaned === LEAD || cleaned === "all") {
		throw new Error(`Member name '${cleaned}' is reserved. Choose a name other than '${LEAD}' or 'all'.`);
	}
	return cleaned;
}

export function teamDir(name: string): string {
	const canonical = sanitizeName(name);
	if (canonical !== name) throw new Error(`Team name '${name}' is not canonical; expected '${canonical}'.`);
	return path.join(teamsRoot(), canonical);
}

export function listTeamNames(): string[] {
	const root = teamsRoot();
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, "config.json"))).map((e) => e.name);
}

// ---------------------------------------------------------------------------
// Locking + atomic IO
// ---------------------------------------------------------------------------

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 50;
const INBOX_MAX_MESSAGES = 500;

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleep(ms: number): void {
	// True thread sleep without burning CPU. The store API stays synchronous
	// because critical sections are millisecond-scale JSON reads/writes.
	Atomics.wait(sleepBuffer, 0, 0, ms);
}

export function withLock<T>(dir: string, fn: () => T): T {
	fs.mkdirSync(dir, { recursive: true });
	const lockPath = path.join(dir, ".lock");
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	for (;;) {
		try {
			fs.mkdirSync(lockPath);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				const stat = fs.statSync(lockPath);
				if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
					fs.rmSync(lockPath, { recursive: true, force: true });
					continue;
				}
			} catch {
				// Lock vanished between attempts; retry.
				continue;
			}
			if (Date.now() > deadline) throw new Error(`Timed out acquiring team lock at ${lockPath}.`);
			sleep(LOCK_RETRY_MS);
		}
	}
	try {
		return fn();
	} finally {
		fs.rmSync(lockPath, { recursive: true, force: true });
	}
}

export function readJson<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
		throw error;
	}
}

export function writeJsonAtomic(file: string, data: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
	fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Team config
// ---------------------------------------------------------------------------

export function createTeam(name: string, goal: string, leadSessionId: string): TeamConfig {
	if (!leadSessionId.trim()) throw new Error("Creating an Agent Team requires a persistent lead session id.");
	const dir = teamDir(name);
	const creationLockDir = path.join(teamsRoot(), ".creation-lock");
	return withLock(creationLockDir, () => {
		if (fs.existsSync(path.join(dir, "config.json"))) throw new Error(`Team '${name}' already exists at ${dir}.`);
		const existing = listTeamNames().find((candidate) => {
			try {
				const config = loadConfig(teamDir(candidate));
				return config.leadSessionId === leadSessionId && !config.closed;
			} catch {
				return false;
			}
		});
		if (existing) throw new Error(`Lead session '${leadSessionId}' already owns open team '${existing}'.`);
		return withLock(dir, () => {
			// Recheck under the team-specific lock as a defense against older writers
			// that do not participate in the global creation lock.
			if (fs.existsSync(path.join(dir, "config.json"))) throw new Error(`Team '${name}' already exists at ${dir}.`);
			const config: TeamConfig = {
				version: 1,
				name,
				goal,
				leadSessionId,
				createdAt: Date.now(),
				closed: false,
				members: [],
			};
			writeJsonAtomic(path.join(dir, "config.json"), config);
			writeJsonAtomic(path.join(dir, "tasks.json"), { version: 1, tasks: [] });
			fs.mkdirSync(path.join(dir, "inboxes"), { recursive: true });
			fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
			return config;
		});
	});
}

export function loadConfig(dir: string): TeamConfig {
	const config = readJson<TeamConfig | null>(path.join(dir, "config.json"), null);
	if (!config) throw new Error(`No team config found at ${dir}. Create a team first.`);
	return config;
}

export function saveConfig(dir: string, config: TeamConfig): void {
	withLock(dir, () => {
		writeJsonAtomic(path.join(dir, "config.json"), config);
	});
}

function assertTeamMutationAllowed(dir: string, caller: string, action: string): TeamConfig {
	const config = loadConfig(dir);
	if (config.closed || config.closing) {
		throw new Error(`Team '${config.name}' is ${config.closed ? "closed" : "closing"}; cannot ${action}.`);
	}
	if (caller !== LEAD) {
		const member = config.members.find((candidate) => candidate.name === caller);
		if (!member || member.status !== "running") {
			throw new Error(`Teammate '${caller}' is ${member?.status ?? "unregistered"}; cannot ${action}.`);
		}
	}
	return config;
}

export function updateConfig<T>(dir: string, mutate: (config: TeamConfig) => T): T {
	return withLock(dir, () => {
		const config = loadConfig(dir);
		const result = mutate(config);
		writeJsonAtomic(path.join(dir, "config.json"), config);
		return result;
	});
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

interface TaskFile {
	version: 1;
	tasks: TeamTask[];
}

function tasksPath(dir: string): string {
	return path.join(dir, "tasks.json");
}

export function listTasks(dir: string): TeamTask[] {
	return readJson<TaskFile>(tasksPath(dir), { version: 1, tasks: [] }).tasks;
}

export function isTaskBlocked(task: TeamTask, all: TeamTask[]): boolean {
	return task.deps.some((dep) => {
		const other = all.find((t) => t.id === dep);
		return !other || other.status !== "completed";
	});
}

export function decorateTasks(tasks: TeamTask[]): Array<TeamTask & { blocked: boolean }> {
	return tasks.map((task) => ({ ...task, blocked: task.status !== "completed" && isTaskBlocked(task, tasks) }));
}

export function createTask(dir: string, input: { title: string; description?: string; deps?: string[]; createdBy: string }): TeamTask {
	return withLock(dir, () => {
		assertTeamMutationAllowed(dir, input.createdBy, "create a task");
		const file = readJson<TaskFile>(tasksPath(dir), { version: 1, tasks: [] });
		for (const dep of input.deps ?? []) {
			if (!file.tasks.some((t) => t.id === dep)) throw new Error(`Dependency task '${dep}' does not exist.`);
		}
		const nextNum = file.tasks.reduce((max, t) => {
			const match = /^t(\d+)$/.exec(t.id);
			return match ? Math.max(max, Number(match[1])) : max;
		}, 0) + 1;
		const now = Date.now();
		const task: TeamTask = {
			id: `t${nextNum}`,
			title: input.title,
			description: input.description,
			status: "pending",
			deps: input.deps ?? [],
			createdBy: input.createdBy,
			createdAt: now,
			updatedAt: now,
		};
		file.tasks.push(task);
		writeJsonAtomic(tasksPath(dir), file);
		return task;
	});
}

export function updateTask(
	dir: string,
	id: string,
	caller: string,
	patch: { title?: string; description?: string; status?: TaskStatus; deps?: string[] },
): TeamTask {
	return withLock(dir, () => {
		assertTeamMutationAllowed(dir, caller, "update a task");
		const file = readJson<TaskFile>(tasksPath(dir), { version: 1, tasks: [] });
		const task = file.tasks.find((t) => t.id === id);
		if (!task) throw new Error(`Task '${id}' not found.`);
		if (patch.status === "in_progress" && task.owner && task.owner !== caller) {
			throw new Error(`Task '${id}' is owned by '${task.owner}'.`);
		}
		if (patch.title !== undefined) task.title = patch.title;
		if (patch.description !== undefined) task.description = patch.description;
		if (patch.deps !== undefined) {
			for (const dep of patch.deps) {
				if (!file.tasks.some((t) => t.id === dep)) throw new Error(`Dependency task '${dep}' does not exist.`);
			}
			task.deps = patch.deps;
		}
		if (patch.status !== undefined) {
			if (patch.status === "in_progress" && isTaskBlocked(task, file.tasks)) {
				throw new Error(`Task '${id}' is blocked by incomplete dependencies: ${task.deps.join(", ")}.`);
			}
			task.status = patch.status;
			if (patch.status === "in_progress" && !task.owner) task.owner = caller;
		}
		task.updatedAt = Date.now();
		writeJsonAtomic(tasksPath(dir), file);
		return task;
	});
}

export function claimTask(dir: string, id: string, caller: string): TeamTask {
	return withLock(dir, () => {
		assertTeamMutationAllowed(dir, caller, "claim a task");
		const file = readJson<TaskFile>(tasksPath(dir), { version: 1, tasks: [] });
		const task = file.tasks.find((t) => t.id === id);
		if (!task) throw new Error(`Task '${id}' not found.`);
		if (task.status === "completed") throw new Error(`Task '${id}' is already completed.`);
		if (task.owner && task.owner !== caller) throw new Error(`Task '${id}' is owned by '${task.owner}'.`);
		if (isTaskBlocked(task, file.tasks)) {
			throw new Error(`Task '${id}' is blocked by incomplete dependencies: ${task.deps.join(", ")}.`);
		}
		task.owner = caller;
		task.status = "in_progress";
		task.updatedAt = Date.now();
		writeJsonAtomic(tasksPath(dir), file);
		return task;
	});
}

export function claimNextTask(dir: string, caller: string): TeamTask | null {
	return withLock(dir, () => {
		assertTeamMutationAllowed(dir, caller, "claim a task");
		const file = readJson<TaskFile>(tasksPath(dir), { version: 1, tasks: [] });
		const task = file.tasks.find((t) => t.status === "pending" && !t.owner && !isTaskBlocked(t, file.tasks));
		if (!task) return null;
		task.owner = caller;
		task.status = "in_progress";
		task.updatedAt = Date.now();
		writeJsonAtomic(tasksPath(dir), file);
		return task;
	});
}

export function completeTask(dir: string, id: string, caller: string): TeamTask {
	return withLock(dir, () => {
		assertTeamMutationAllowed(dir, caller, "complete a task");
		const file = readJson<TaskFile>(tasksPath(dir), { version: 1, tasks: [] });
		const task = file.tasks.find((t) => t.id === id);
		if (!task) throw new Error(`Task '${id}' not found.`);
		if (task.owner && task.owner !== caller && caller !== LEAD) {
			throw new Error(`Task '${id}' is owned by '${task.owner}'; only the owner or the lead can complete it.`);
		}
		task.status = "completed";
		task.updatedAt = Date.now();
		writeJsonAtomic(tasksPath(dir), file);
		return task;
	});
}

// ---------------------------------------------------------------------------
// Mailboxes
// ---------------------------------------------------------------------------

function memberStoragePath(dir: string, area: "inboxes" | "notes", member: string, suffix: string): string {
	if (member !== LEAD) {
		if (member === "all" || !/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(member)) {
			throw new Error(`Unsafe team member storage key '${member}'.`);
		}
	}
	const base = path.resolve(dir, area);
	const file = path.resolve(base, `${member}${suffix}`);
	if (path.dirname(file) !== base) throw new Error(`Unsafe team member storage path '${member}'.`);
	return file;
}

function verifiedNotesPath(dir: string, member: string): { file: string; realArea: string } {
	const file = memberStoragePath(dir, "notes", member, ".md");
	const teamStat = fs.lstatSync(dir);
	const area = path.resolve(dir, "notes");
	const areaStat = fs.lstatSync(area);
	if (teamStat.isSymbolicLink() || areaStat.isSymbolicLink() || !teamStat.isDirectory() || !areaStat.isDirectory()) {
		throw new Error(`Unsafe symlinked team notes directory for '${member}'.`);
	}
	const realTeam = fs.realpathSync.native(dir);
	const realArea = fs.realpathSync.native(area);
	if (path.dirname(realArea) !== realTeam) throw new Error(`Unsafe team notes directory for '${member}'.`);
	try {
		const noteStat = fs.lstatSync(file);
		if (noteStat.isSymbolicLink()) throw new Error(`Unsafe symlinked team note '${member}'.`);
		if (!noteStat.isFile()) throw new Error(`Team note '${member}' is not a regular file.`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return { file, realArea };
}

function verifyOpenedNote(fd: number, file: string, realArea: string, member: string): void {
	const stat = fs.fstatSync(fd);
	if (!stat.isFile()) throw new Error(`Team note '${member}' is not a regular file.`);
	if (stat.nlink !== 1) throw new Error(`Team note '${member}' must not be hard-linked.`);
	const realFile = fs.realpathSync.native(file);
	if (path.dirname(realFile) !== realArea) throw new Error(`Unsafe team note target '${member}'.`);
}

function inboxPath(dir: string, member: string): string {
	return memberStoragePath(dir, "inboxes", member, ".json");
}

function cursorPath(dir: string, member: string): string {
	return memberStoragePath(dir, "inboxes", member, ".cursor");
}

export function sendMessage(dir: string, from: string, to: string, message: string, members: string[]): string[] {
	const recipients = to === "all" ? [LEAD, ...members].filter((m) => m !== from) : [to];
	return withLock(dir, () => {
		assertTeamMutationAllowed(dir, from, "send team mail");
		const delivered: string[] = [];
		for (const recipient of recipients) {
			const file = inboxPath(dir, recipient);
			let inbox = readJson<TeamMessage[]>(file, []);
			// Strictly-increasing per-inbox timestamps: cursors compare ts >
			// watermark, so two messages sharing a millisecond must not collapse
			// into one (the later one would be skipped on capped delivery).
			const ts = Math.max(Date.now(), (inbox.at(-1)?.ts ?? 0) + 1);
			inbox.push({ id: randomUUID().slice(0, 8), from, to: recipient, ts, message });
			if (inbox.length > INBOX_MAX_MESSAGES) inbox = inbox.slice(-INBOX_MAX_MESSAGES);
			writeJsonAtomic(file, inbox);
			delivered.push(recipient);
		}
		return delivered;
	});
}

function readCursor(dir: string, member: string): number {
	try {
		return Number(fs.readFileSync(cursorPath(dir, member), "utf8").trim()) || 0;
	} catch {
		return 0;
	}
}

/** Advance a member's read cursor to an exact watermark (used for capped delivery). */
export function advanceCursor(dir: string, member: string, ts: number): void {
	withLock(dir, () => {
		writeJsonAtomic(cursorPath(dir, member), ts);
	});
}

export function readInbox(dir: string, member: string, markRead: boolean): TeamMessage[] {
	const readUnread = (): TeamMessage[] => {
		const inbox = readJson<TeamMessage[]>(inboxPath(dir, member), []);
		const cursor = readCursor(dir, member);
		return inbox.filter((m) => m.ts > cursor);
	};
	// Pure reads skip the lock entirely: writes are atomic renames, so a read
	// can never observe a partial file. This keeps hot poll paths from ever
	// blocking on a lock held by a crashed process.
	if (!markRead) return readUnread();
	return withLock(dir, () => {
		assertTeamMutationAllowed(dir, member, "advance the inbox cursor");
		const unread = readUnread();
		if (unread.length > 0) {
			const watermark = Math.max(...unread.map((m) => m.ts));
			writeJsonAtomic(cursorPath(dir, member), watermark);
		}
		return unread;
	});
}

export function inboxSize(dir: string, member: string): number {
	return readJson<TeamMessage[]>(inboxPath(dir, member), []).length;
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export function appendNote(dir: string, member: string, content: string, caller = member): void {
	verifiedNotesPath(dir, member);
	withLock(dir, () => {
		assertTeamMutationAllowed(dir, caller, "append team notes");
		const { file, realArea } = verifiedNotesPath(dir, member);
		const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
		try {
			verifyOpenedNote(fd, file, realArea, member);
			fs.writeFileSync(fd, `\n\n## ${new Date().toISOString()}\n\n${content.trim()}\n`, "utf8");
		} finally {
			fs.closeSync(fd);
		}
	});
}

export function readNotes(dir: string, member: string): string {
	const { file, realArea } = verifiedNotesPath(dir, member);
	let fd: number;
	try {
		fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
	try {
		verifyOpenedNote(fd, file, realArea, member);
		return fs.readFileSync(fd, "utf8").trim();
	} finally {
		fs.closeSync(fd);
	}
}

// ---------------------------------------------------------------------------
// Identity resolution for teammate child sessions
// ---------------------------------------------------------------------------

export interface MemberIdentity {
	team: string;
	dir: string;
	member: TeamMember;
}

/** Find the team + member that owns a given pi-subagents run id. */
export function findMemberByRunId(runId: string): MemberIdentity | null {
	for (const name of listTeamNames()) {
		const dir = teamDir(name);
		try {
			const config = loadConfig(dir);
			const member = config.members.find((m) => m.runId === runId);
			if (member) return { team: name, dir, member };
		} catch {
			continue;
		}
	}
	return null;
}
