import path from "node:path";

export type RepoInspectionAction =
	| "status"
	| "diff"
	| "diff-staged"
	| "diff-range"
	| "diff-stat"
	| "changed-files"
	| "show"
	| "log"
	| "blame";

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
			throw new Error(`Git inspection path must identify a file or directory below the current repository: ${entry}`);
		}
		return relative.split(path.sep).join("/");
	});
}

export function normalizeGitRef(ref: string | undefined, fallback = "HEAD"): string {
	const value = ref?.trim() || fallback;
	if (value.startsWith("-") || !/^[A-Za-z0-9_./~^{}:+-]+$/.test(value)) throw new Error(`Invalid git revision: ${value}`);
	return value;
}

function validateLimit(limit: number | undefined): number {
	const value = limit ?? 20;
	if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error(`Git log limit must be an integer between 1 and 100: ${value}`);
	return value;
}

function rangeSelector(input: RepoInspectionInput, required: boolean): string[] {
	if (input.staged && (input.base || input.head)) throw new Error("staged inspection cannot be combined with base/head revisions.");
	if (input.head && !input.base) throw new Error("head requires base so the comparison range is unambiguous.");
	if (input.base) return [`${normalizeGitRef(input.base)}...${normalizeGitRef(input.head)}`];
	if (required) throw new Error("base is required for diff-range.");
	return input.staged ? ["--cached"] : [];
}

function blameLineArgs(input: RepoInspectionInput): string[] {
	if (input.lineStart === undefined && input.lineEnd === undefined) return [];
	if (!Number.isInteger(input.lineStart) || input.lineStart! < 1) throw new Error("lineStart must be a positive integer for blame.");
	const end = input.lineEnd ?? input.lineStart!;
	if (!Number.isInteger(end) || end < input.lineStart!) throw new Error("lineEnd must be an integer greater than or equal to lineStart for blame.");
	return ["-L", `${input.lineStart},${end}`];
}

function validateActionFields(input: RepoInspectionInput): void {
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
	if (unsupported.length > 0) throw new Error(`${input.action} does not accept: ${unsupported.join(", ")}.`);
}

export function buildReadOnlyGitArgs(cwd: string, input: RepoInspectionInput): string[] {
	validateActionFields(input);
	const paths = normalizeGitPaths(cwd, input.paths);
	const scopedPaths = paths.length ? ["--", ...paths] : [];
	const prefix = ["--no-optional-locks"];
	const diffOptions = ["--no-ext-diff", "--find-renames"];

	switch (input.action) {
		case "status":
			return [...prefix, "status", "--short", "--branch", ...scopedPaths];
		case "diff":
			return [...prefix, "diff", ...diffOptions, "--unified=80", ...scopedPaths];
		case "diff-staged":
			return [...prefix, "diff", "--cached", ...diffOptions, "--unified=80", ...scopedPaths];
		case "diff-range":
			return [...prefix, "diff", ...diffOptions, "--unified=80", ...rangeSelector(input, true), ...scopedPaths];
		case "diff-stat":
			return [...prefix, "diff", ...diffOptions, "--stat", ...rangeSelector(input, false), ...scopedPaths];
		case "changed-files":
			return [...prefix, "diff", ...diffOptions, "--name-status", ...rangeSelector(input, false), ...scopedPaths];
		case "show":
			return [...prefix, "show", ...diffOptions, "--format=fuller", normalizeGitRef(input.ref), ...scopedPaths];
		case "log":
			return [...prefix, "log", "--oneline", "--decorate=no", `-${validateLimit(input.limit)}`, normalizeGitRef(input.ref), ...scopedPaths];
		case "blame": {
			if (paths.length !== 1) throw new Error("blame requires exactly one path.");
			return [...prefix, "blame", "--date=short", ...blameLineArgs(input), normalizeGitRef(input.ref), "--", paths[0]];
		}
	}
}
