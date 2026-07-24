import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeJsonAtomic } from "./json.ts";
import { writerLeasesRoot } from "./paths.ts";

export interface WriterLease {
	version: 1;
	token: string;
	cwd: string;
	owner: string;
	createdAt: number;
	pid: number;
	sessionId?: string;
	runId?: string;
	uncertain?: boolean;
}

export interface WriterCoordinatorOptions {
	enabled?: boolean;
	rootDir?: string;
	pid?: number;
	processAlive?: (pid: number) => boolean;
}

const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const MALFORMED_LOCK_STALE_MS = 10_000;
const sleepCell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function canonicalPath(value: string): string {
	const resolved = path.resolve(value);
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

function markerWorktreeRoot(start: string): string | undefined {
	let current = start;
	for (;;) {
		try {
			const marker = fs.lstatSync(path.join(current, ".git"));
			if (marker.isDirectory() || marker.isFile() || marker.isSymbolicLink()) return canonicalPath(current);
		} catch {
			// No marker at this level.
		}
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/** Resolve every directory inside one Git checkout to the checkout's worktree
 * root. Linked worktrees remain independent because --show-toplevel returns the
 * concrete root of the active worktree, not the shared Git common directory. */
export function canonicalWriterCwd(cwd: string): string {
	const resolved = canonicalPath(cwd);
	let probe = resolved;
	while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
	try {
		const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
		const worktree = execFileSync("git", ["-C", probe, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5_000,
		}).trim();
		if (worktree) return canonicalPath(worktree);
	} catch {
		// Fall through to a conservative marker walk. This preserves worktree-wide
		// exclusion when Git is absent or refuses discovery (for example safe.directory).
	}
	return markerWorktreeRoot(probe) ?? resolved;
}

function parseLease(value: unknown): WriterLease | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const lease = value as Partial<WriterLease>;
	if (
		lease.version !== 1
		|| typeof lease.token !== "string"
		|| typeof lease.cwd !== "string"
		|| typeof lease.owner !== "string"
		|| typeof lease.createdAt !== "number"
		|| typeof lease.pid !== "number"
	) return undefined;
	return lease as WriterLease;
}

interface OperationLock {
	token: string;
	pid: number;
	createdAt: number;
}

interface LocatedLease {
	lease: WriterLease;
	dir: string;
}

function readOperationLock(file: string): OperationLock | undefined {
	try {
		const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<OperationLock>;
		if (typeof value.token !== "string" || typeof value.pid !== "number" || typeof value.createdAt !== "number") return undefined;
		return value as OperationLock;
	} catch {
		return undefined;
	}
}

export class WriterCoordinator {
	readonly #enabled: boolean;
	readonly #rootDir: string;
	readonly #pid: number;
	readonly #processAlive: (pid: number) => boolean;
	#sessionId?: string;

	constructor(options: WriterCoordinatorOptions | boolean = {}) {
		const resolved = typeof options === "boolean" ? { enabled: options } : options;
		this.#enabled = resolved.enabled ?? true;
		this.#rootDir = path.resolve(resolved.rootDir ?? writerLeasesRoot());
		this.#pid = resolved.pid ?? process.pid;
		this.#processAlive = resolved.processAlive ?? processAlive;
	}

	setSessionId(sessionId: string | undefined): void {
		this.#sessionId = sessionId;
	}

	#key(cwd: string): string {
		return createHash("sha256").update(canonicalWriterCwd(cwd)).digest("hex");
	}

	#dir(cwd: string): string {
		return path.join(this.#rootDir, this.#key(cwd));
	}

	#lockFile(cwd: string): string {
		return path.join(this.#rootDir, `.op-${this.#key(cwd)}.lock`);
	}

	#readDir(dir: string): WriterLease | undefined {
		try {
			return parseLease(JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf8")));
		} catch {
			return undefined;
		}
	}

	#locatedLeases(): LocatedLease[] {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(this.#rootDir, { withFileTypes: true });
		} catch {
			return [];
		}
		return entries
			.filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
			.flatMap((entry) => {
				const dir = path.join(this.#rootDir, entry.name);
				const lease = this.#readDir(dir);
				return lease ? [{ lease, dir }] : [];
			})
			.sort((a, b) => a.lease.createdAt - b.lease.createdAt);
	}

	#locatedForCwd(cwd: string): LocatedLease[] {
		const canonical = canonicalWriterCwd(cwd);
		return this.#locatedLeases().filter(({ lease }) => canonicalWriterCwd(lease.cwd) === canonical);
	}

	#withCwdLock<T>(cwd: string, operation: () => T): T {
		fs.mkdirSync(this.#rootDir, { recursive: true, mode: 0o700 });
		const file = this.#lockFile(cwd);
		const lock: OperationLock = { token: randomUUID(), pid: process.pid, createdAt: Date.now() };
		const deadline = Date.now() + LOCK_TIMEOUT_MS;
		for (;;) {
			try {
				const handle = fs.openSync(file, "wx", 0o600);
				try {
					fs.writeFileSync(handle, `${JSON.stringify(lock)}\n`, "utf8");
				} finally {
					fs.closeSync(handle);
				}
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const existing = readOperationLock(file);
				let stale = Boolean(existing && !processAlive(existing.pid));
				if (!existing) {
					try {
						stale = Date.now() - fs.statSync(file).mtimeMs > MALFORMED_LOCK_STALE_MS;
					} catch {
						continue;
					}
				}
				if (stale) {
					try { fs.unlinkSync(file); } catch { /* another coordinator won */ }
					continue;
				}
				if (Date.now() >= deadline) throw new Error(`Workbench writer guard timed out waiting to inspect ${canonicalWriterCwd(cwd)}.`);
				Atomics.wait(sleepCell, 0, 0, LOCK_WAIT_MS);
			}
		}
		try {
			return operation();
		} finally {
			const current = readOperationLock(file);
			if (current?.token === lock.token) {
				try { fs.unlinkSync(file); } catch { /* already removed */ }
			}
		}
	}

	acquire(cwd: string, owner: string): WriterLease | undefined {
		if (!this.#enabled) return undefined;
		if (!owner.trim()) throw new Error("Workbench writer guard requires a non-empty owner label.");
		const canonical = canonicalWriterCwd(cwd);
		return this.#withCwdLock(canonical, () => {
			for (const existing of this.#locatedForCwd(canonical)) {
				if (!existing.lease.runId && !existing.lease.uncertain && !this.#processAlive(existing.lease.pid)) {
					fs.rmSync(existing.dir, { recursive: true, force: true });
				}
			}
			const blocking = this.#locatedForCwd(canonical)[0];
			if (blocking) {
				const existing = blocking.lease;
				const detail = `'${existing.owner}' already owns ${canonical}${existing.runId ? ` (run ${existing.runId})` : ""}${existing.uncertain ? " (launch uncertain)" : ""}`;
				throw new Error(`Workbench writer guard: ${detail}. Wait for it to finish, inspect /workbench, or use an isolated worktree.`);
			}
			const dir = this.#dir(canonical);
			if (fs.existsSync(dir)) {
				throw new Error(`Workbench writer guard: an unreadable lease already exists for ${canonical}. Wait for it to finish, inspect /workbench, or use an isolated worktree.`);
			}
			const lease: WriterLease = {
				version: 1,
				token: randomUUID(),
				cwd: canonical,
				owner,
				createdAt: Date.now(),
				pid: this.#pid,
				...(this.#sessionId ? { sessionId: this.#sessionId } : {}),
			};
			fs.mkdirSync(dir, { mode: 0o700 });
			try {
				writeJsonAtomic(path.join(dir, "owner.json"), lease);
			} catch (error) {
				fs.rmSync(dir, { recursive: true, force: true });
				throw error;
			}
			return { ...lease };
		});
	}

	#update(token: string | undefined, mutate: (lease: WriterLease) => WriterLease): boolean {
		if (!token) return false;
		const candidate = this.#locatedLeases().find(({ lease }) => lease.token === token);
		if (!candidate) return false;
		return this.#withCwdLock(candidate.lease.cwd, () => {
			const current = this.#readDir(candidate.dir);
			if (current?.token !== token) return false;
			writeJsonAtomic(path.join(candidate.dir, "owner.json"), mutate(current));
			return true;
		});
	}

	attachRun(token: string | undefined, runId: string | undefined): void {
		if (!runId) return;
		this.#update(token, (lease) => ({ ...lease, runId, uncertain: false }));
	}

	markUncertain(token: string | undefined): void {
		this.#update(token, (lease) => ({ ...lease, uncertain: true }));
	}

	release(token: string | undefined): boolean {
		if (!token) return false;
		const candidate = this.#locatedLeases().find(({ lease }) => lease.token === token);
		if (!candidate) return false;
		return this.#withCwdLock(candidate.lease.cwd, () => {
			if (this.#readDir(candidate.dir)?.token !== token) return false;
			fs.rmSync(candidate.dir, { recursive: true, force: true });
			return true;
		});
	}

	releaseRun(runId: string): boolean {
		const candidate = this.list().find((lease) => lease.runId === runId);
		return candidate ? this.release(candidate.token) : false;
	}

	releaseCwd(cwd: string): boolean {
		const canonical = canonicalWriterCwd(cwd);
		return this.#withCwdLock(canonical, () => {
			const dirs = new Set(this.#locatedForCwd(canonical).map(({ dir }) => dir));
			const canonicalDir = this.#dir(canonical);
			if (fs.existsSync(canonicalDir)) dirs.add(canonicalDir);
			for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
			return dirs.size > 0;
		});
	}

	get(cwd: string): WriterLease | undefined {
		const lease = this.#locatedForCwd(cwd)[0]?.lease;
		return lease ? { ...lease } : undefined;
	}

	list(): WriterLease[] {
		return this.#locatedLeases().map(({ lease }) => ({ ...lease }));
	}
}
