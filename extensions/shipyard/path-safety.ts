import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { RUN_ID_PATTERN, resolveStorePath } from "./findings-store.ts";

const SESSION_DIR_PATTERN = /^S-[A-Za-z0-9-]+$/;

export async function rejectSymlinkComponents(root: string, target: string): Promise<void> {
	const relative = path.relative(root, target);
	let current = root;
	for (const segment of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		try {
			const info = await lstat(current);
			if (info.isSymbolicLink()) throw new Error(`Symlinked Shipyard path component is not allowed: ${current}`);
		} catch (error) {
			const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
			if (code === "ENOENT") continue;
			throw error;
		}
	}
}

export async function resolveSafeStorePath(cwd: string, store: string, runsRoot: string): Promise<string> {
	await mkdir(runsRoot, { recursive: true, mode: 0o700 });
	const resolved = resolveStorePath(cwd, store, runsRoot);
	const parts = path.relative(runsRoot, resolved).split(path.sep);
	if (
		parts.length !== 3
		|| !SESSION_DIR_PATTERN.test(parts[0] ?? "")
		|| !RUN_ID_PATTERN.test(parts[1] ?? "")
		|| parts[2] !== "findings"
	) {
		throw new Error(`Invalid Shipyard findings location. Expected ${runsRoot}/S-<session>/R-<run>/findings.`);
	}
	await rejectSymlinkComponents(runsRoot, resolved);
	await mkdir(resolved, { recursive: true, mode: 0o700 });
	const [rootReal, storeReal] = await Promise.all([realpath(runsRoot), realpath(resolved)]);
	const relativeReal = path.relative(rootReal, storeReal);
	if (!relativeReal || relativeReal.startsWith("..") || path.isAbsolute(relativeReal)) {
		throw new Error("Shipyard findings store resolves outside the trusted run root.");
	}
	return resolved;
}

export async function resolveSafeExportPath(storePath: string, output: string): Promise<string> {
	const runDir = path.dirname(storePath);
	const raw = output.trim().startsWith("@") ? output.trim().slice(1) : output.trim();
	if (!raw) throw new Error("output is required for export.");
	const resolved = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(runDir, raw);
	const relative = path.relative(runDir, resolved);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`Findings export must stay below the current Shipyard run directory: ${runDir}`);
	}
	const storeRelative = path.relative(storePath, resolved);
	if (!storeRelative || (!storeRelative.startsWith("..") && !path.isAbsolute(storeRelative))) {
		throw new Error("Findings export may not overwrite the findings store or its records.");
	}
	if (path.extname(resolved).toLowerCase() !== ".md") {
		throw new Error("Findings exports must use a .md file below the current Shipyard run directory.");
	}
	await rejectSymlinkComponents(runDir, resolved);
	await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
	await rejectSymlinkComponents(runDir, resolved);
	const [runReal, parentReal] = await Promise.all([realpath(runDir), realpath(path.dirname(resolved))]);
	const realRelative = path.relative(runReal, parentReal);
	if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
		throw new Error("Findings export parent resolves outside the current Shipyard run directory.");
	}
	try {
		if ((await lstat(resolved)).isSymbolicLink()) throw new Error(`Symlinked findings export target is not allowed: ${resolved}`);
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
		if (code !== "ENOENT") throw error;
	}
	return resolved;
}
