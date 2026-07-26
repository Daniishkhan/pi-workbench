import path from "node:path";

export const REPO_INSPECTION_ACTIONS = [
	"status",
	"diff",
	"diff-staged",
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
}

export function normalizeGitPaths(cwd: string, paths: string[] | undefined): string[] {
	const root = path.resolve(cwd);
	return (paths ?? []).map((entry) => {
		const raw = entry.startsWith("@") ? entry.slice(1) : entry;
		if (raw.startsWith("-")) throw new Error(`Git inspection path may not start with '-': ${entry}`);
		const absolute = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root, raw);
		const relative = path.relative(root, absolute);
		if (!relative) return ".";
		if (relative.startsWith("..") || path.isAbsolute(relative)) {
			throw new Error(`Git inspection path must be below the current repository: ${entry}`);
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

function validateFields(input: RepoInspectionInput): void {
	const fields = ["ref", "base", "head", "staged", "limit", "lineStart", "lineEnd"] as const;
	const allowed: Record<RepoInspectionAction, ReadonlySet<(typeof fields)[number]>> = {
		status: new Set(),
		diff: new Set(),
		"diff-staged": new Set(),
		"diff-range": new Set(["base", "head"]),
		"diff-stat": new Set(["base", "head", "staged"]),
		"changed-files": new Set(["base", "head", "staged"]),
		show: new Set(["ref"]),
		log: new Set(["ref", "limit"]),
		blame: new Set(["ref", "lineStart", "lineEnd"]),
	};
	const unsupported = fields.filter((field) => input[field] !== undefined && !allowed[input.action].has(field));
	if (unsupported.length) throw new Error(`${input.action} does not accept: ${unsupported.join(", ")}.`);
}

/** Build a fixed, inspection-only Git invocation. No caller-provided option is
 * passed through and every path is placed after `--`. */
export function buildReadOnlyGitArgs(cwd: string, input: RepoInspectionInput): string[] {
	validateFields(input);
	const paths = normalizeGitPaths(cwd, input.paths);
	const scope = paths.length ? ["--", ...paths] : [];
	// Avoid optional index writes, pagers, and repository-configured fsmonitor
	// hooks. Each invocation remains a non-interactive inspection subprocess.
	const prefix = ["--no-optional-locks", "--no-pager", "-c", "core.fsmonitor=false"];
	// Disable both external diff drivers and textconv filters: repository Git
	// configuration must not turn this inspection-only tool into command execution.
	const diff = ["--no-ext-diff", "--no-textconv", "--find-renames"];

	switch (input.action) {
		case "status": return [...prefix, "status", "--short", "--branch", ...scope];
		case "diff": return [...prefix, "diff", ...diff, "--unified=80", ...scope];
		case "diff-staged": return [...prefix, "diff", "--cached", ...diff, "--unified=80", ...scope];
		case "diff-range": return [...prefix, "diff", ...diff, "--unified=80", ...range(input, true), ...scope];
		case "diff-stat": return [...prefix, "diff", ...diff, "--stat", ...range(input, false), ...scope];
		case "changed-files": return [...prefix, "diff", ...diff, "--name-status", ...range(input, false), ...scope];
		case "show": return [...prefix, "show", ...diff, "--format=fuller", normalizeGitRef(input.ref), ...scope];
		case "log": return [...prefix, "log", "--oneline", "--decorate=no", `-${logLimit(input.limit)}`, normalizeGitRef(input.ref), ...scope];
		case "blame":
			if (paths.length !== 1) throw new Error("blame requires exactly one path.");
			return [...prefix, "blame", "--date=short", ...blameLines(input), normalizeGitRef(input.ref), "--", paths[0]];
	}
}
