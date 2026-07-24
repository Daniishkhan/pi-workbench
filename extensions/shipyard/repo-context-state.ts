import { realpath } from "node:fs/promises";
import path from "node:path";

export interface RepositoryState {
	root: string;
	head: string | null;
}

export interface GitReadResult {
	code: number;
	stdout: string;
}

export async function inspectRepositoryState(
	cwd: string,
	execGit: (args: string[]) => Promise<GitReadResult>,
): Promise<RepositoryState> {
	const fallbackRoot = await realpath(path.resolve(cwd)).catch(() => path.resolve(cwd));
	const rootResult = await execGit(["--no-optional-locks", "rev-parse", "--show-toplevel"]);
	if (rootResult.code !== 0) return { root: fallbackRoot, head: null };

	const reportedRoot = rootResult.stdout.trim() || fallbackRoot;
	const root = await realpath(reportedRoot).catch(() => path.resolve(reportedRoot));
	const headResult = await execGit(["--no-optional-locks", "rev-parse", "--verify", "HEAD"]);
	return { root, head: headResult.code === 0 ? headResult.stdout.trim() || null : null };
}
