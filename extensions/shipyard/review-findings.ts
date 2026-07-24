import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	getAgentDir,
	truncateHead,
	withFileMutationQueue,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	addFinding,
	exportFindings,
	getFinding,
	initializeStore,
	listFindings,
	snapshotFindings,
	summarizeFindings,
	updateFinding,
	type FindingConfidence,
	type FindingEvidence,
	type FindingFilter,
	type FindingPatch,
	type FindingSeverity,
	type FindingStatus,
} from "./findings-store.ts";
import { authorizeFindingAction, createCapabilityRegistry, type FindingUpdateField } from "./findings-capabilities.ts";
import { resolveSafeExportPath, resolveSafeStorePath } from "./path-safety.ts";
import { buildReadOnlyGitArgs } from "./repo-inspection.ts";

const SHIPYARD_RUNS_ROOT = path.join(getAgentDir(), "shipyard-runs");

const EvidenceSchema = Type.Object({
	path: Type.String({ minLength: 1, maxLength: 1_024, description: "Path inside the reviewed repository" }),
	lineStart: Type.Optional(Type.Integer({ minimum: 1 })),
	lineEnd: Type.Optional(Type.Integer({ minimum: 1 })),
	symbol: Type.Optional(Type.String({ maxLength: 256 })),
	detail: Type.String({ minLength: 1, maxLength: 2_048, description: "What this evidence proves" }),
}, { additionalProperties: false });

const SeveritySchema = StringEnum(["blocker", "high", "medium", "low"] as const);
const ConfidenceSchema = StringEnum(["high", "medium", "low"] as const);
const StatusSchema = StringEnum(["proposed", "verified", "rejected", "deferred", "resolved"] as const);

const FindingsParams = Type.Object({
	action: StringEnum(["init", "add", "get", "list", "update", "stats", "snapshot", "export"] as const),
	store: Type.String({ minLength: 1, maxLength: 4_096, description: "Exact run-scoped findings directory supplied by Shipyard" }),
	capability: Type.Optional(Type.String({ minLength: 32, maxLength: 256, description: "Exact run/stage capability supplied in the Shipyard task" })),
	id: Type.Optional(Type.String({ maxLength: 128, description: "Finding id for get/update" })),
	stage: Type.Optional(Type.String({ maxLength: 128, description: "Immutable creation stage for add; snapshot label for snapshot" })),
	title: Type.Optional(Type.String({ maxLength: 512 })),
	summary: Type.Optional(Type.String({ maxLength: 8_192 })),
	severity: Type.Optional(SeveritySchema),
	confidence: Type.Optional(ConfidenceSchema),
	status: Type.Optional(StatusSchema),
	category: Type.Optional(Type.String({ maxLength: 128 })),
	sourceRole: Type.Optional(Type.String({ maxLength: 128 })),
	evidence: Type.Optional(Type.Array(EvidenceSchema, { maxItems: 24 })),
	failureScenario: Type.Optional(Type.String({ maxLength: 8_192 })),
	suggestedFix: Type.Optional(Type.String({ maxLength: 8_192 })),
	validation: Type.Optional(Type.String({ maxLength: 8_192 })),
	dispositionReason: Type.Optional(Type.String({ maxLength: 8_192 })),
	tags: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 24 })),
	filterSeverity: Type.Optional(SeveritySchema),
	filterConfidence: Type.Optional(ConfidenceSchema),
	filterStatus: Type.Optional(StatusSchema),
	filterCategory: Type.Optional(Type.String({ maxLength: 128 })),
	filterSourceRole: Type.Optional(Type.String({ maxLength: 128 })),
	filterStage: Type.Optional(Type.String({ maxLength: 128 })),
	filterTag: Type.Optional(Type.String({ maxLength: 64 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
	expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
	output: Type.Optional(Type.String({ maxLength: 4_096, description: "Run-directory Markdown path for export" })),
}, { additionalProperties: false });

const RepoParams = Type.Object({
	action: StringEnum(["status", "diff", "diff-staged", "diff-range", "diff-stat", "changed-files", "show", "log", "blame"] as const),
	ref: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Git revision for show, log, or blame (defaults to HEAD)" })),
	base: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Base revision for a merge-base comparison" })),
	head: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Head revision paired with base (defaults to HEAD)" })),
	staged: Type.Optional(Type.Boolean({ description: "Inspect staged changes for diff-stat or changed-files" })),
	paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), { maxItems: 32 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Maximum commits returned by log" })),
	lineStart: Type.Optional(Type.Integer({ minimum: 1, description: "First line for blame" })),
	lineEnd: Type.Optional(Type.Integer({ minimum: 1, description: "Last line for blame" })),
}, { additionalProperties: false });

function requiredText(value: string | undefined, label: string): string {
	const trimmed = value?.trim();
	if (!trimmed) throw new Error(`${label} is required for this action.`);
	return trimmed;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function normalizeEvidence(cwd: string, evidence: FindingEvidence[]): FindingEvidence[] {
	const root = path.resolve(cwd);
	return evidence.map((entry) => {
		const raw = entry.path.startsWith("@") ? entry.path.slice(1) : entry.path;
		const absolute = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root, raw);
		const relative = path.relative(root, absolute);
		if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
			throw new Error(`Evidence path must identify a file below the reviewed cwd: ${entry.path}`);
		}
		return { ...entry, path: relative.split(path.sep).join("/") };
	});
}

function formatFindingLine(finding: Awaited<ReturnType<typeof getFinding>>): string {
	const firstEvidence = finding.evidence[0];
	const location = firstEvidence ? `${firstEvidence.path}${firstEvidence.lineStart ? `:${firstEvidence.lineStart}` : ""}` : "no-evidence";
	return `${finding.id} [${finding.status}/${finding.severity}/${finding.confidence}] ${finding.title} — ${location}`;
}

export default function registerReviewFindings(pi: ExtensionAPI) {
	pi.registerTool({
		name: "review_findings",
		label: "Review Findings",
		description: `Maintain Shipyard's run-scoped structured review ledger. Findings are atomic evidence records with immutable provenance and optimistic revisions. Use the exact store path from the task. List/get output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		parameters: FindingsParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("review_findings cancelled");
			const storePath = await resolveSafeStorePath(ctx.cwd, params.store, SHIPYARD_RUNS_ROOT);
			if (params.action === "init" && !params.capability?.trim()) {
				const runId = path.basename(path.dirname(storePath));
				const manifest = await withFileMutationQueue(storePath, () => initializeStore(storePath, { runId }));
				if (manifest.workflow !== "manual") throw new Error("Workflow findings stores require the exact step capability even for init.");
				const [grant] = await createCapabilityRegistry(storePath, manifest.runId, manifest.workflow, [{
					stage: "manual",
					sourceRole: "manual",
					actions: ["init", "add", "get", "list", "update", "stats", "snapshot", "export"],
					updateFields: ["title", "summary", "severity", "confidence", "status", "category", "evidence", "failureScenario", "suggestedFix", "validation", "dispositionReason", "tags"],
					updateStatuses: ["verified", "rejected", "deferred", "resolved"],
				}]);
				return textResult(`Initialized manual findings store: ${storePath}\nCapability: ${grant.token}\nPass this capability on every later call.`, { storePath, manifest, capability: grant.token });
			}
			const authorization = await authorizeFindingAction(storePath, params.capability, params.action);
			switch (params.action) {
				case "init": {
					const runId = path.basename(path.dirname(storePath));
					const manifest = await withFileMutationQueue(storePath, () => initializeStore(storePath, { runId }));
					return textResult(`Initialized findings store: ${storePath}`, { storePath, manifest });
				}
				case "add": {
					if (!authorization.manual) {
						if (params.stage?.trim() && params.stage.trim() !== authorization.stage) {
							throw new Error(`Finding stage is bound to ${authorization.stage} by the supplied capability.`);
						}
						if (params.sourceRole?.trim() && params.sourceRole.trim() !== authorization.sourceRole) {
							throw new Error(`Finding sourceRole is bound to ${authorization.sourceRole} by the supplied capability.`);
						}
					}
					const evidence = normalizeEvidence(ctx.cwd, (params.evidence ?? []) as FindingEvidence[]);
					const finding = await withFileMutationQueue(storePath, () => addFinding(storePath, {
						stage: authorization.manual ? requiredText(params.stage, "stage") : authorization.stage,
						title: requiredText(params.title, "title"),
						summary: requiredText(params.summary, "summary"),
						severity: (params.severity ?? "medium") as FindingSeverity,
						confidence: (params.confidence ?? "medium") as FindingConfidence,
						category: requiredText(params.category, "category"),
						sourceRole: authorization.manual ? requiredText(params.sourceRole, "sourceRole") : authorization.sourceRole,
						evidence,
						failureScenario: requiredText(params.failureScenario, "failureScenario"),
						suggestedFix: requiredText(params.suggestedFix, "suggestedFix"),
						...(params.validation?.trim() ? { validation: params.validation.trim() } : {}),
						tags: params.tags ?? [],
					}));
					return textResult(`Added ${formatFindingLine(finding)}`, { storePath, finding });
				}
				case "get": {
					const finding = await getFinding(storePath, requiredText(params.id, "id"));
					const serialized = JSON.stringify(finding, null, 2);
					const truncated = truncateHead(serialized, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
					return textResult(truncated.content, { storePath, finding, truncated: truncated.truncated });
				}
				case "list": {
					const filter: FindingFilter = {
						...(params.filterSeverity ? { severity: params.filterSeverity as FindingSeverity } : {}),
						...(params.filterConfidence ? { confidence: params.filterConfidence as FindingConfidence } : {}),
						...(params.filterStatus ? { status: params.filterStatus as FindingStatus } : {}),
						...(params.filterCategory?.trim() ? { category: params.filterCategory.trim() } : {}),
						...(params.filterSourceRole?.trim() ? { sourceRole: params.filterSourceRole.trim() } : {}),
						...(params.filterStage?.trim() ? { stage: params.filterStage.trim() } : {}),
						...(params.filterTag?.trim() ? { tag: params.filterTag.trim() } : {}),
					};
					const all = await listFindings(storePath, filter);
					const limit = params.limit ?? 100;
					const selected = all.slice(0, limit);
					const text = selected.length > 0 ? selected.map(formatFindingLine).join("\n") : "No findings matched.";
					return textResult(all.length > limit ? `${text}\n… ${all.length - limit} more` : text, {
						storePath,
						findings: selected,
						total: all.length,
						limited: all.length > limit,
					});
				}
				case "update": {
					if (params.expectedRevision === undefined) throw new Error("expectedRevision is required for update.");
					const patch: FindingPatch = {
						...(params.title !== undefined ? { title: params.title } : {}),
						...(params.summary !== undefined ? { summary: params.summary } : {}),
						...(params.severity !== undefined ? { severity: params.severity as FindingSeverity } : {}),
						...(params.confidence !== undefined ? { confidence: params.confidence as FindingConfidence } : {}),
						...(params.status !== undefined ? { status: params.status as FindingStatus } : {}),
						...(params.category !== undefined ? { category: params.category } : {}),
						...(params.evidence !== undefined ? { evidence: normalizeEvidence(ctx.cwd, params.evidence as FindingEvidence[]) } : {}),
						...(params.failureScenario !== undefined ? { failureScenario: params.failureScenario } : {}),
						...(params.suggestedFix !== undefined ? { suggestedFix: params.suggestedFix } : {}),
						...(params.validation !== undefined ? { validation: params.validation } : {}),
						...(params.dispositionReason !== undefined ? { dispositionReason: params.dispositionReason } : {}),
						...(params.tags !== undefined ? { tags: params.tags } : {}),
					};
					if (Object.keys(patch).length === 0) throw new Error("update requires at least one patch field.");
					if (!authorization.manual) {
						const allowedFields = new Set(authorization.updateFields ?? []);
						const denied = Object.keys(patch).filter((field) => !allowedFields.has(field as FindingUpdateField));
						if (denied.length > 0) throw new Error(`Findings capability for ${authorization.sourceRole} cannot update: ${denied.join(", ")}.`);
						if (patch.status && !(authorization.updateStatuses ?? []).includes(patch.status)) {
							throw new Error(`Findings capability for ${authorization.sourceRole} cannot set status ${patch.status}.`);
						}
					}
					const id = requiredText(params.id, "id");
					const finding = await withFileMutationQueue(path.join(storePath, `${id}.json`), () => updateFinding(
						storePath,
						id,
						patch,
						params.expectedRevision!,
					));
					return textResult(`Updated ${formatFindingLine(finding)} (revision ${finding.revision})`, { storePath, finding });
				}
				case "stats": {
					const stats = summarizeFindings(await listFindings(storePath));
					return textResult(JSON.stringify(stats, null, 2), { storePath, stats });
				}
				case "snapshot": {
					const label = requiredText(params.stage, "stage snapshot label");
					const snapshot = await withFileMutationQueue(path.join(storePath, "snapshots", `${label}.json`), () => snapshotFindings(storePath, label));
					return textResult(`Snapshot ${label}: ${snapshot.findings.length} findings (${snapshot.sha256})`, { storePath, snapshot });
				}
				case "export": {
					const outputPath = await resolveSafeExportPath(storePath, requiredText(params.output, "output"));
					const exported = await withFileMutationQueue(outputPath, () => exportFindings(storePath, outputPath, params.title?.trim()));
					return textResult(`Exported ${exported.count} findings to ${exported.path}`, { storePath, ...exported });
				}
			}
		},
	});

	pi.registerTool({
		name: "shipyard_repo",
		label: "Shipyard Repo",
		description: `Read-only Git inspection for Shipyard roles. Supports status, unstaged/staged/range diffs, diff summaries, changed-file lists, commit patches, ref-aware log, and line-scoped blame. Range comparisons use merge-base semantics (base...head). It accepts no arbitrary shell command and truncates output to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		parameters: RepoParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("shipyard_repo cancelled");
			const args = buildReadOnlyGitArgs(ctx.cwd, {
				action: params.action,
				...(params.ref ? { ref: params.ref } : {}),
				...(params.base ? { base: params.base } : {}),
				...(params.head ? { head: params.head } : {}),
				...(params.staged !== undefined ? { staged: params.staged } : {}),
				...(params.paths ? { paths: params.paths } : {}),
				...(params.limit ? { limit: params.limit } : {}),
				...(params.lineStart ? { lineStart: params.lineStart } : {}),
				...(params.lineEnd ? { lineEnd: params.lineEnd } : {}),
			});
			const result = await pi.exec("git", args, { cwd: ctx.cwd, signal, timeout: 30_000 });
			if (result.code !== 0) throw new Error(`git ${params.action} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
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
