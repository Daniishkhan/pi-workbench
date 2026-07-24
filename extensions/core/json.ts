/**
 * Shared JSON persistence helpers: atomic temp-file-then-rename writes with
 * private permissions, and tolerant reads with an explicit fallback.
 * All Workbench state files go through here so durability and permission
 * rules are defined once.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export function ensurePrivateDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	try { fs.chmodSync(dir, 0o700); } catch { /* Best effort on filesystems without POSIX modes. */ }
}

export function writeTextAtomic(file: string, content: string): void {
	ensurePrivateDir(path.dirname(file));
	const temp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
	fs.writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
	fs.renameSync(temp, file);
}

/** Strict JSON write: refuses values JSON would silently corrupt. */
export function writeJsonAtomic(file: string, value: unknown): void {
	const serialized = JSON.stringify(value, (_key, child) => {
		if (typeof child === "number" && !Number.isFinite(child)) {
			throw new Error(`Refusing to persist non-finite JSON number to '${file}'.`);
		}
		if (typeof child === "bigint") throw new Error(`Refusing to persist BigInt to JSON file '${file}'.`);
		return child;
	}, 2);
	if (serialized === undefined) throw new Error(`Refusing to persist undefined JSON root to '${file}'.`);
	writeTextAtomic(file, `${serialized}\n`);
}

export function readJson<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
		throw error;
	}
}
