import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { textResult } from "./result.ts";
import {
	buildHeadVerificationGitArgs,
	buildReadOnlyGitArgs,
	canonicalGitWorktreeRoot,
	executeReadOnlyGit,
	MAX_DIFF_CONTEXT,
	REPO_INSPECTION_ACTIONS,
} from "./repo-inspection.ts";

const Params = Type.Object({
	action: StringEnum(REPO_INSPECTION_ACTIONS, {
		description: "status; diff (unstaged); diff-staged; diff-worktree (all tracked changes since HEAD); diff-range; diff-stat; changed-files; show; log; or blame.",
	}),
	ref: Type.Optional(Type.String({
		minLength: 1,
		maxLength: 256,
		description: "Revision for show, log, or blame only; defaults to HEAD.",
	})),
	base: Type.Optional(Type.String({
		minLength: 1,
		maxLength: 256,
		description: "Base revision for diff-range, diff-stat, or changed-files. diff-range requires it.",
	})),
	head: Type.Optional(Type.String({
		minLength: 1,
		maxLength: 256,
		description: "Head revision paired with base for diff-range, diff-stat, or changed-files; defaults to HEAD.",
	})),
	staged: Type.Optional(Type.Boolean({
		description: "Use the staged/index view for diff-stat or changed-files only.",
	})),
	paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), {
		maxItems: 32,
		description: "Optional repository-root-relative paths. Absolute paths must remain inside the current Git worktree.",
	})),
	limit: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 100,
		description: "Commit count for log only; defaults to 20.",
	})),
	lineStart: Type.Optional(Type.Integer({
		minimum: 1,
		description: "First line for blame only.",
	})),
	lineEnd: Type.Optional(Type.Integer({
		minimum: 1,
		description: "Last line for blame only; requires lineStart.",
	})),
	context: Type.Optional(Type.Integer({
		minimum: 0,
		maximum: MAX_DIFF_CONTEXT,
		description: `Context lines for diff, diff-staged, diff-worktree, or diff-range only; defaults to 3 and is capped at ${MAX_DIFF_CONTEXT}.`,
	})),
}, { additionalProperties: false });

export default function registerInspectRepoTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "inspect_repo",
		label: "Inspect Repo",
		description: `Inspect Git without arbitrary commands or mutations. Supports status, focused or combined tracked-worktree diffs, changed files, show, log, and blame. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Inspect the current repository with read-only Git commands",
		promptGuidelines: [
			"Use inspect_repo for Git inspection. Paths are relative to the Git worktree root even when the session starts in a subdirectory.",
			"Use diff-worktree for the combined tracked change since HEAD, diff for unstaged changes, diff-staged for staged changes, and diff-range for base...head merge-base comparisons. Only pass fields documented for that action.",
		],
		parameters: Params,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("inspect_repo cancelled");
			const repoRoot = canonicalGitWorktreeRoot(ctx.cwd);
			const runGit = async (gitArgs: string[]) => {
				const execution = await executeReadOnlyGit(gitArgs, repoRoot, signal, 30_000);
				if (signal?.aborted) throw new Error("inspect_repo cancelled");
				return execution;
			};
			const args = buildReadOnlyGitArgs(repoRoot, params);
			let executedArgs: string[] | string[][] = args;
			const result = await runGit(args);
			let full: string;
			let unbornHeadFallback = false;

			if (params.action === "diff-worktree" && result.code !== 0) {
				const head = await runGit(buildHeadVerificationGitArgs());
				if (head.code !== 0) {
					const stagedArgs = buildReadOnlyGitArgs(repoRoot, {
						action: "diff-staged",
						paths: params.paths,
						context: params.context,
					});
					const unstagedArgs = buildReadOnlyGitArgs(repoRoot, {
						action: "diff",
						paths: params.paths,
						context: params.context,
					});
					const [staged, unstaged] = await Promise.all([
						runGit(stagedArgs),
						runGit(unstagedArgs),
					]);
					if (staged.code !== 0 || unstaged.code !== 0) {
						const failure = staged.code !== 0 ? staged : unstaged;
						throw new Error(`git diff-worktree could not inspect an unborn HEAD (${failure.code}): ${failure.stderr.trim() || failure.stdout.trim() || "fallback diff failed"}`);
					}
					executedArgs = [stagedArgs, unstagedArgs];
					unbornHeadFallback = true;
					full = [
						"[HEAD has no commit; showing staged changes, then unstaged tracked changes.]",
						`Staged changes:\n${staged.stdout.trimEnd() || "(none)"}`,
						`Unstaged tracked changes:\n${unstaged.stdout.trimEnd() || "(none)"}`,
					].join("\n\n");
				} else {
					throw new Error(`git ${params.action} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
				}
			} else {
				if (result.code !== 0) {
					throw new Error(`git ${params.action} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
				}
				full = result.stdout.trimEnd() || "(no output)";
			}

			const truncated = truncateHead(full, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			const suffix = truncated.truncated
				? `\n\n[Output truncated: ${truncated.outputLines}/${truncated.totalLines} lines, ${formatSize(truncated.outputBytes)}/${formatSize(truncated.totalBytes)}.]`
				: "";
			return textResult(`${truncated.content}${suffix}`, {
				action: params.action,
				args: executedArgs,
				repoRoot,
				unbornHeadFallback,
				truncated: truncated.truncated,
				exitCode: 0,
			});
		},
	});
}
