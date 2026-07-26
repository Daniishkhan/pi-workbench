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
import { buildReadOnlyGitArgs, REPO_INSPECTION_ACTIONS } from "./repo-inspection.ts";

const Params = Type.Object({
	action: StringEnum(REPO_INSPECTION_ACTIONS),
	ref: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
	base: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
	head: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
	staged: Type.Optional(Type.Boolean()),
	paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), { maxItems: 32 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
	lineStart: Type.Optional(Type.Integer({ minimum: 1 })),
	lineEnd: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });

export default function registerRepoTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "workbench_repo",
		label: "Workbench Repo",
		description: `Inspect Git without arbitrary commands or mutations. Supports status, diffs, changed files, show, log, and blame. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Inspect the current repository with read-only Git commands",
		promptGuidelines: [
			"Use workbench_repo for Git inspection; paths are repository-relative and range diffs use base...head merge-base semantics.",
		],
		parameters: Params,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("workbench_repo cancelled");
			const args = buildReadOnlyGitArgs(ctx.cwd, params);
			const result = await pi.exec("git", args, { cwd: ctx.cwd, signal, timeout: 30_000 });
			if (result.code !== 0) {
				throw new Error(`git ${params.action} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
			}
			const full = result.stdout.trimEnd() || "(no output)";
			const truncated = truncateHead(full, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			const suffix = truncated.truncated
				? `\n\n[Output truncated: ${truncated.outputLines}/${truncated.totalLines} lines, ${formatSize(truncated.outputBytes)}/${formatSize(truncated.totalBytes)}.]`
				: "";
			return textResult(`${truncated.content}${suffix}`, {
				action: params.action,
				args,
				truncated: truncated.truncated,
				exitCode: result.code,
			});
		},
	});
}
