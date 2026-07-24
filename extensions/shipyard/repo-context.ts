import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	withFileMutationQueue,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { legacyShipyardContextRoot, shipyardContextRoot } from "../core/paths.ts";
import { textResult } from "../core/result.ts";
import { isRepositoryContextFresh, repositoryContextPath } from "./repo-context-key.ts";
import { inspectRepositoryState } from "./repo-context-state.ts";

const CONTEXT_SCHEMA_VERSION = 1;
const MAX_CONTEXT_CHARS = 50_000;

interface CachedRepositoryContext {
	schemaVersion: number;
	repositoryRoot: string;
	head: string | null;
	updatedAt: string;
	content: string;
}

const ContextUpdateParams = Type.Object({
	content: Type.String({
		minLength: 1,
		maxLength: MAX_CONTEXT_CHARS,
		description: "Concise reusable repository map with verified paths, entry points, module responsibilities, flows, and test commands",
	}),
}, { additionalProperties: false });

async function currentRepositoryState(pi: ExtensionAPI, cwd: string, signal?: AbortSignal) {
	return inspectRepositoryState(cwd, (args) => pi.exec("git", args, {
		cwd,
		signal,
		timeout: 10_000,
	}));
}

async function readContext(file: string): Promise<CachedRepositoryContext | undefined> {
	try {
		const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<CachedRepositoryContext>;
		if (parsed.schemaVersion !== CONTEXT_SCHEMA_VERSION || typeof parsed.repositoryRoot !== "string"
			|| !(typeof parsed.head === "string" || parsed.head === null) || typeof parsed.updatedAt !== "string"
			|| typeof parsed.content !== "string") return undefined;
		return parsed as CachedRepositoryContext;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export default function registerRepoContext(pi: ExtensionAPI) {
	pi.registerTool({
		name: "shipyard_context",
		label: "Shipyard Context",
		description: `Read the local reusable repository map for the current checkout. The result states whether it matches HEAD. Treat stale maps as orientation only and verify claims in source. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Read the cached Shipyard repository map for this checkout",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("shipyard_context cancelled");
			const state = await currentRepositoryState(pi, ctx.cwd, signal);
			const contextRoot = shipyardContextRoot();
			const file = repositoryContextPath(contextRoot, state.root);
			const cached = await readContext(file)
				?? await readContext(repositoryContextPath(legacyShipyardContextRoot(), state.root));
			if (!cached) {
				return textResult(`No reusable Shipyard context is cached for ${state.root}.\nCurrent revision: ${state.head ?? "unversioned"}.`, {
					repositoryRoot: state.root,
					head: state.head,
					fresh: false,
					cached: false,
				});
			}
			const fresh = isRepositoryContextFresh(cached.head, state.head);
			const header = [
				`Shipyard repository context: ${fresh ? "fresh" : "stale"}`,
				`Repository: ${state.root}`,
				`Cached revision: ${cached.head ?? "unversioned"}`,
				`Current revision: ${state.head ?? "unversioned"}`,
				`Updated: ${cached.updatedAt}`,
				...(fresh ? [] : ["Verify every relevant claim in current source before relying on this map."]),
				"",
			].join("\n");
			const truncated = truncateHead(`${header}${cached.content}`, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			return textResult(truncated.content, {
				repositoryRoot: state.root,
				head: state.head,
				cachedHead: cached.head,
				updatedAt: cached.updatedAt,
				fresh,
				cached: true,
				truncated: truncated.truncated,
			});
		},
	});

	pi.registerTool({
		name: "shipyard_context_update",
		label: "Update Shipyard Context",
		description: "Persist a concise reusable repository map outside the worktree, bound to the current repository root and HEAD. Use only after verifying the map against source.",
		promptSnippet: "Persist a verified reusable repository map",
		parameters: ContextUpdateParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("shipyard_context_update cancelled");
			const content = params.content.trim();
			if (!content) throw new Error("Repository context content cannot be empty.");
			const state = await currentRepositoryState(pi, ctx.cwd, signal);
			const contextRoot = shipyardContextRoot();
			const file = repositoryContextPath(contextRoot, state.root);
			const record: CachedRepositoryContext = {
				schemaVersion: CONTEXT_SCHEMA_VERSION,
				repositoryRoot: state.root,
				head: state.head,
				updatedAt: new Date().toISOString(),
				content,
			};
			await mkdir(contextRoot, { recursive: true, mode: 0o700 });
			await withFileMutationQueue(file, async () => {
				const temporary = `${file}.${randomUUID()}.tmp`;
				await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
				await rename(temporary, file);
			});
			return textResult(`Updated reusable Shipyard context for ${state.root} at ${state.head ?? "an unversioned checkout"}.`, {
				repositoryRoot: state.root,
				head: state.head,
				file,
				characters: content.length,
			});
		},
	});
}
