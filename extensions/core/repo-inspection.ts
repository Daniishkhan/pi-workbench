import { execFile, execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";

export const REPO_INSPECTION_ACTIONS = [
	"status",
	"diff",
	"diff-staged",
	"diff-worktree",
	"diff-range",
	"diff-stat",
	"changed-files",
	"show",
	"log",
	"blame",
] as const;

export type RepoInspectionAction = (typeof REPO_INSPECTION_ACTIONS)[number];

export interface RepoInspectionInput {
	action: RepoInspectionAction;
	ref?: string;
	base?: string;
	head?: string;
	staged?: boolean;
	paths?: string[];
	limit?: number;
	lineStart?: number;
	lineEnd?: number;
	context?: number;
}

export const DEFAULT_DIFF_CONTEXT = 3;
export const MAX_DIFF_CONTEXT = 20;
const MAX_GIT_CAPTURE_BYTES = 64 * 1_024 * 1_024;

export interface ReadOnlyGitResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

function sanitizedGitEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return {
		...Object.fromEntries(
			Object.entries(environment).filter(([name]) => !name.toUpperCase().startsWith("GIT_")),
		),
		GIT_OPTIONAL_LOCKS: "0",
	};
}

/** Execute only a previously built Git argv without a shell. Every invocation
 * gets the same ambient-Git-variable isolation as worktree discovery while
 * retaining AbortSignal and timeout enforcement. */
export async function executeReadOnlyGit(
	args: string[],
	cwd: string,
	signal?: AbortSignal,
	timeout = 30_000,
	environment: NodeJS.ProcessEnv = process.env,
): Promise<ReadOnlyGitResult> {
	return await new Promise((resolve) => {
		execFile("git", args, {
			cwd,
			encoding: "utf8",
			env: sanitizedGitEnvironment(environment),
			maxBuffer: MAX_GIT_CAPTURE_BYTES,
			shell: false,
			signal,
			timeout,
		}, (error, stdout, stderr) => {
			resolve({
				stdout,
				stderr: stderr || (error?.killed ? `Git inspection process was terminated after ${timeout}ms.` : error?.message ?? ""),
				code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
				killed: Boolean(error?.killed),
			});
		});
	});
}

function canonicalPath(value: string): string {
	const resolved = path.resolve(value);
	try {
		return realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

/** Resolve the concrete worktree root without allowing ambient GIT_* variables
 * to redirect discovery to a different checkout. Linked worktrees retain their
 * own root because --show-toplevel reports the active worktree. */
export function canonicalGitWorktreeRoot(cwd: string, environment: NodeJS.ProcessEnv = process.env): string {
	const start = canonicalPath(cwd);

	let output: string;
	try {
		output = execFileSync("git", [
			"--no-optional-locks",
			"--no-pager",
			"-c",
			"core.fsmonitor=false",
			"-C",
			start,
			"rev-parse",
			"--show-toplevel",
		], {
			encoding: "utf8",
			env: sanitizedGitEnvironment(environment),
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5_000,
		}).trim();
	} catch {
		throw new Error(`inspect_repo requires a Git worktree: ${cwd}`);
	}

	if (!output) throw new Error(`inspect_repo could not resolve the Git worktree root: ${cwd}`);
	const root = canonicalPath(output);
	const relative = path.relative(root, start);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`Git reported a worktree root that does not contain the current directory: ${cwd}`);
	}
	return root;
}

export function normalizeGitPaths(repoRoot: string, paths: string[] | undefined): string[] {
	const root = canonicalPath(repoRoot);
	return (paths ?? []).map((entry) => {
		const raw = entry.startsWith("@") ? entry.slice(1) : entry;
		if (raw.startsWith("-")) throw new Error(`Git inspection path may not start with '-': ${entry}`);
		const absolute = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root, raw);
		const relative = path.relative(root, absolute);
		if (!relative) return ".";
		if (relative.startsWith("..") || path.isAbsolute(relative)) {
			throw new Error(`Git inspection path must be below the current Git worktree: ${entry}`);
		}
		return relative.split(path.sep).join("/");
	});
}

export function normalizeGitRef(ref: string | undefined, fallback = "HEAD"): string {
	const value = ref?.trim() || fallback;
	if (value.startsWith("-") || !/^[A-Za-z0-9_./~^{}:+-]+$/.test(value)) {
		throw new Error(`Invalid git revision: ${value}`);
	}
	return value;
}

function logLimit(limit: number | undefined): number {
	const value = limit ?? 20;
	if (!Number.isInteger(value) || value < 1 || value > 100) {
		throw new Error(`Git log limit must be an integer between 1 and 100: ${value}`);
	}
	return value;
}

function range(input: RepoInspectionInput, required: boolean): string[] {
	if (input.staged && (input.base || input.head)) throw new Error("staged inspection cannot be combined with base/head revisions.");
	if (input.head && !input.base) throw new Error("head requires base so the comparison range is unambiguous.");
	if (input.base) return [`${normalizeGitRef(input.base)}...${normalizeGitRef(input.head)}`];
	if (required) throw new Error("base is required for diff-range.");
	return input.staged ? ["--cached"] : [];
}

function blameLines(input: RepoInspectionInput): string[] {
	if (input.lineStart === undefined && input.lineEnd === undefined) return [];
	if (!Number.isInteger(input.lineStart) || input.lineStart! < 1) throw new Error("lineStart must be a positive integer for blame.");
	const end = input.lineEnd ?? input.lineStart!;
	if (!Number.isInteger(end) || end < input.lineStart!) {
		throw new Error("lineEnd must be an integer greater than or equal to lineStart for blame.");
	}
	return ["-L", `${input.lineStart},${end}`];
}

function diffContext(context: number | undefined): string {
	const value = context ?? DEFAULT_DIFF_CONTEXT;
	if (!Number.isInteger(value) || value < 0 || value > MAX_DIFF_CONTEXT) {
		throw new Error(`Diff context must be an integer between 0 and ${MAX_DIFF_CONTEXT}: ${value}`);
	}
	return `--unified=${value}`;
}

function validateFields(input: RepoInspectionInput): void {
	const fields = ["ref", "base", "head", "staged", "limit", "lineStart", "lineEnd", "context"] as const;
	const allowed: Record<RepoInspectionAction, ReadonlySet<(typeof fields)[number]>> = {
		status: new Set(),
		diff: new Set(["context"]),
		"diff-staged": new Set(["context"]),
		"diff-worktree": new Set(["context"]),
		"diff-range": new Set(["base", "head", "context"]),
		"diff-stat": new Set(["base", "head", "staged"]),
		"changed-files": new Set(["base", "head", "staged"]),
		show: new Set(["ref"]),
		log: new Set(["ref", "limit"]),
		blame: new Set(["ref", "lineStart", "lineEnd"]),
	};
	const unsupported = fields.filter((field) => input[field] !== undefined && !allowed[input.action].has(field));
	if (unsupported.length) throw new Error(`${input.action} does not accept: ${unsupported.join(", ")}.`);
}

export function buildHeadVerificationGitArgs(): string[] {
	return ["--no-optional-locks", "--no-pager", "-c", "core.fsmonitor=false", "rev-parse", "--verify", "--quiet", "HEAD"];
}

/** Build a fixed, inspection-only Git invocation. No caller-provided option is
 * passed through and every path is placed after `--`. */
export function buildReadOnlyGitArgs(repoRoot: string, input: RepoInspectionInput): string[] {
	validateFields(input);
	const paths = normalizeGitPaths(repoRoot, input.paths);
	const scope = paths.length ? ["--", ...paths] : [];
	// Avoid optional index writes, pagers, and repository-configured fsmonitor
	// hooks. Each invocation remains a non-interactive inspection subprocess.
	const prefix = ["--no-optional-locks", "--no-pager", "-c", "core.fsmonitor=false"];
	// Disable both external diff drivers and textconv filters: repository Git
	// configuration must not turn this inspection-only tool into command execution.
	const diff = ["--no-ext-diff", "--no-textconv", "--find-renames"];

	switch (input.action) {
		case "status": return [...prefix, "status", "--short", "--branch", ...scope];
		case "diff": return [...prefix, "diff", ...diff, diffContext(input.context), ...scope];
		case "diff-staged": return [...prefix, "diff", "--cached", ...diff, diffContext(input.context), ...scope];
		case "diff-worktree": return [...prefix, "diff", ...diff, diffContext(input.context), "HEAD", ...scope];
		case "diff-range": return [...prefix, "diff", ...diff, diffContext(input.context), ...range(input, true), ...scope];
		case "diff-stat": return [...prefix, "diff", ...diff, "--stat", ...range(input, false), ...scope];
		case "changed-files": return [...prefix, "diff", ...diff, "--name-status", ...range(input, false), ...scope];
		case "show": return [...prefix, "show", ...diff, "--format=fuller", normalizeGitRef(input.ref), ...scope];
		case "log": return [...prefix, "log", "--oneline", "--decorate=no", `-${logLimit(input.limit)}`, normalizeGitRef(input.ref), ...scope];
		case "blame":
			if (paths.length !== 1) throw new Error("blame requires exactly one path.");
			return [...prefix, "blame", "--date=short", ...blameLines(input), normalizeGitRef(input.ref), "--", paths[0]];
	}
}
