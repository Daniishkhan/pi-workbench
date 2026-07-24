import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultAgentDir } from "./config.ts";

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

function writeJsonAtomic(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
	fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	fs.renameSync(temp, file);
}

export function canonicalWriterCwd(cwd: string): string {
	const resolved = path.resolve(cwd);
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
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
		this.#rootDir = path.resolve(resolved.rootDir ?? path.join(defaultAgentDir(), "workbench", "writer-leases"));
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
			const dir = this.#dir(canonical);
			const existing = this.#readDir(dir);
			if (existing && !existing.runId && !existing.uncertain && !this.#processAlive(existing.pid)) {
				fs.rmSync(dir, { recursive: true, force: true });
			} else if (fs.existsSync(dir)) {
				const detail = existing
					? `'${existing.owner}' already owns ${canonical}${existing.runId ? ` (run ${existing.runId})` : ""}${existing.uncertain ? " (launch uncertain)" : ""}`
					: `an unreadable lease already exists for ${canonical}`;
				throw new Error(`Workbench writer guard: ${detail}. Wait for it to finish, inspect /workbench, or use an isolated worktree.`);
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
		const candidate = this.list().find((lease) => lease.token === token);
		if (!candidate) return false;
		return this.#withCwdLock(candidate.cwd, () => {
			const dir = this.#dir(candidate.cwd);
			const current = this.#readDir(dir);
			if (current?.token !== token) return false;
			writeJsonAtomic(path.join(dir, "owner.json"), mutate(current));
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
		const candidate = this.list().find((lease) => lease.token === token);
		if (!candidate) return false;
		return this.#withCwdLock(candidate.cwd, () => {
			const dir = this.#dir(candidate.cwd);
			if (this.#readDir(dir)?.token !== token) return false;
			fs.rmSync(dir, { recursive: true, force: true });
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
			const dir = this.#dir(canonical);
			if (!fs.existsSync(dir)) return false;
			fs.rmSync(dir, { recursive: true, force: true });
			return true;
		});
	}

	get(cwd: string): WriterLease | undefined {
		const lease = this.#readDir(this.#dir(canonicalWriterCwd(cwd)));
		return lease ? { ...lease } : undefined;
	}

	list(): WriterLease[] {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(this.#rootDir, { withFileTypes: true });
		} catch {
			return [];
		}
		return entries
			.filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
			.flatMap((entry) => {
				const lease = this.#readDir(path.join(this.#rootDir, entry.name));
				return lease ? [{ ...lease }] : [];
			})
			.sort((a, b) => a.createdAt - b.createdAt);
	}
}
