import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const FINDING_SCHEMA_VERSION = 1;
export const FINDING_ID_PATTERN = /^F-[a-z0-9-]+$/;
export const RUN_ID_PATTERN = /^R-[A-Za-z0-9-]+$/;
export const SNAPSHOT_LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_FINDINGS = 500;

export type FindingSeverity = "blocker" | "high" | "medium" | "low";
export type FindingConfidence = "high" | "medium" | "low";
export type FindingStatus = "proposed" | "verified" | "rejected" | "deferred" | "resolved";

export interface FindingEvidence {
	path: string;
	lineStart?: number;
	lineEnd?: number;
	symbol?: string;
	detail: string;
}

export interface Finding {
	schemaVersion: typeof FINDING_SCHEMA_VERSION;
	id: string;
	revision: number;
	runId: string;
	workflow: string;
	stage: string;
	title: string;
	summary: string;
	severity: FindingSeverity;
	confidence: FindingConfidence;
	status: FindingStatus;
	category: string;
	sourceRole: string;
	evidence: FindingEvidence[];
	failureScenario: string;
	suggestedFix: string;
	validation?: string;
	dispositionReason?: string;
	tags: string[];
	createdAt: string;
	updatedAt: string;
}

export interface AddFindingInput {
	stage: string;
	title: string;
	summary: string;
	severity: FindingSeverity;
	confidence: FindingConfidence;
	category: string;
	sourceRole: string;
	evidence: FindingEvidence[];
	failureScenario: string;
	suggestedFix: string;
	validation?: string;
	tags?: string[];
}

export interface FindingPatch {
	title?: string;
	summary?: string;
	severity?: FindingSeverity;
	confidence?: FindingConfidence;
	status?: FindingStatus;
	category?: string;
	evidence?: FindingEvidence[];
	failureScenario?: string;
	suggestedFix?: string;
	validation?: string;
	dispositionReason?: string;
	tags?: string[];
}

export interface FindingFilter {
	severity?: FindingSeverity;
	confidence?: FindingConfidence;
	status?: FindingStatus;
	category?: string;
	sourceRole?: string;
	stage?: string;
	tag?: string;
}

export interface FindingStats {
	total: number;
	bySeverity: Record<FindingSeverity, number>;
	byStatus: Record<FindingStatus, number>;
	byConfidence: Record<FindingConfidence, number>;
}

export interface StoreManifest {
	schemaVersion: typeof FINDING_SCHEMA_VERSION;
	kind: "pi-shipyard-review-findings";
	runId: string;
	workflow: string;
	createdAt: string;
}

export interface StoreSnapshot {
	schemaVersion: typeof FINDING_SCHEMA_VERSION;
	runId: string;
	workflow: string;
	label: string;
	createdAt: string;
	findings: Array<{ id: string; revision: number; sha256: string }>;
	sha256: string;
}

const SEVERITIES: FindingSeverity[] = ["blocker", "high", "medium", "low"];
const CONFIDENCES: FindingConfidence[] = ["high", "medium", "low"];
const STATUSES: FindingStatus[] = ["proposed", "verified", "rejected", "deferred", "resolved"];
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;
const MAX_SHORT_TEXT = 512;
const MAX_LONG_TEXT = 8_192;
const MAX_EVIDENCE = 24;
const MAX_TAGS = 24;

function cleanPathArgument(value: string): string {
	const trimmed = value.trim();
	return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

export function resolveStorePath(cwd: string, store: string, allowedRoot?: string): string {
	const cleaned = cleanPathArgument(store);
	if (!cleaned) throw new Error("Findings store path must not be empty.");
	const resolved = path.isAbsolute(cleaned) ? path.normalize(cleaned) : path.resolve(cwd, cleaned);
	if (allowedRoot) {
		const root = path.resolve(allowedRoot);
		const relative = path.relative(root, resolved);
		if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
			throw new Error(`Findings store must be a run-specific directory below ${root}.`);
		}
	}
	return resolved;
}

function findingPath(storePath: string, id: string): string {
	if (!FINDING_ID_PATTERN.test(id)) throw new Error(`Invalid finding id: ${id}`);
	return path.join(storePath, `${id}.json`);
}

function boundedText(value: string, label: string, maxLength = MAX_SHORT_TEXT): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${label} must not be empty.`);
	if (trimmed.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters.`);
	return trimmed;
}

function normalizeTags(tags: string[] | undefined): string[] {
	if ((tags?.length ?? 0) > MAX_TAGS) throw new Error(`A finding may have at most ${MAX_TAGS} tags.`);
	return [...new Set((tags ?? []).map((tag) => boundedText(tag, "Finding tag", 64).toLowerCase()))].sort();
}

function validateEvidence(evidence: FindingEvidence[]): FindingEvidence[] {
	if (!Array.isArray(evidence) || evidence.length === 0) throw new Error("A finding requires at least one evidence entry.");
	if (evidence.length > MAX_EVIDENCE) throw new Error(`A finding may have at most ${MAX_EVIDENCE} evidence entries.`);
	return evidence.map((entry, index) => {
		const lineStart = entry.lineStart;
		const lineEnd = entry.lineEnd;
		if (lineStart !== undefined && (!Number.isInteger(lineStart) || lineStart < 1)) {
			throw new Error(`Evidence ${index + 1} lineStart must be a positive integer.`);
		}
		if (lineEnd !== undefined && (!Number.isInteger(lineEnd) || lineEnd < 1)) {
			throw new Error(`Evidence ${index + 1} lineEnd must be a positive integer.`);
		}
		if (lineStart !== undefined && lineEnd !== undefined && lineEnd < lineStart) {
			throw new Error(`Evidence ${index + 1} lineEnd must be greater than or equal to lineStart.`);
		}
		return {
			path: boundedText(entry.path, `Evidence ${index + 1} path`, 1_024),
			...(lineStart !== undefined ? { lineStart } : {}),
			...(lineEnd !== undefined ? { lineEnd } : {}),
			...(entry.symbol?.trim() ? { symbol: boundedText(entry.symbol, `Evidence ${index + 1} symbol`, 256) } : {}),
			detail: boundedText(entry.detail, `Evidence ${index + 1} detail`, 2_048),
		};
	});
}

function validateEnum<T extends string>(value: T, allowed: readonly T[], label: string): T {
	if (!allowed.includes(value)) throw new Error(`${label} must be one of: ${allowed.join(", ")}.`);
	return value;
}

function validateFinding(finding: Finding): Finding {
	if (finding.schemaVersion !== FINDING_SCHEMA_VERSION) {
		throw new Error(`Unsupported finding schema version in ${finding.id}: ${finding.schemaVersion}`);
	}
	if (!FINDING_ID_PATTERN.test(finding.id)) throw new Error(`Invalid finding id: ${finding.id}`);
	if (!RUN_ID_PATTERN.test(finding.runId)) throw new Error(`Invalid finding runId: ${finding.runId}`);
	if (!Number.isInteger(finding.revision) || finding.revision < 1) throw new Error(`Invalid revision for ${finding.id}.`);
	return {
		...finding,
		workflow: boundedText(finding.workflow, "Finding workflow", 128),
		stage: boundedText(finding.stage, "Finding stage", 128),
		title: boundedText(finding.title, "Finding title"),
		summary: boundedText(finding.summary, "Finding summary", MAX_LONG_TEXT),
		severity: validateEnum(finding.severity, SEVERITIES, "Finding severity"),
		confidence: validateEnum(finding.confidence, CONFIDENCES, "Finding confidence"),
		status: validateEnum(finding.status, STATUSES, "Finding status"),
		category: boundedText(finding.category, "Finding category", 128),
		sourceRole: boundedText(finding.sourceRole, "Finding sourceRole", 128),
		evidence: validateEvidence(finding.evidence),
		failureScenario: boundedText(finding.failureScenario, "Finding failureScenario", MAX_LONG_TEXT),
		suggestedFix: boundedText(finding.suggestedFix, "Finding suggestedFix", MAX_LONG_TEXT),
		...(finding.validation?.trim() ? { validation: boundedText(finding.validation, "Finding validation", MAX_LONG_TEXT) } : {}),
		...(finding.dispositionReason?.trim()
			? { dispositionReason: boundedText(finding.dispositionReason, "Finding dispositionReason", MAX_LONG_TEXT) }
			: {}),
		tags: normalizeTags(finding.tags),
	};
}

async function writeJsonAtomic(targetPath: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
	const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(temporaryPath, "wx", 0o600);
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporaryPath, targetPath);
	} finally {
		await handle?.close().catch(() => undefined);
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

async function writeJsonExclusive(targetPath: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
	const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(temporaryPath, "wx", 0o600);
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await link(temporaryPath, targetPath);
	} finally {
		await handle?.close().catch(() => undefined);
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

async function acquireLock(targetPath: string): Promise<() => Promise<void>> {
	await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
	const lockPath = `${targetPath}.lock`;
	const startedAt = Date.now();
	while (true) {
		if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
			let stale = false;
			try {
				stale = Date.now() - (await stat(lockPath)).mtimeMs > STALE_LOCK_MS;
			} catch (error) {
				const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
				if (code === "ENOENT") continue;
				throw error;
			}
			throw new Error(`${stale ? "Stale" : "Timed out waiting for"} findings lock: ${lockPath}. Locks fail closed; remove a stale lock only after confirming no writer is active.`);
		}
		try {
			const handle = await open(lockPath, "wx", 0o600);
			const lockToken = randomUUID();
			try {
				await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n${lockToken}\n`, "utf8");
			} catch (error) {
				await handle.close().catch(() => undefined);
				await rm(lockPath, { force: true }).catch(() => undefined);
				throw error;
			}
			return async () => {
				await handle.close().catch(() => undefined);
				try {
					const current = await readFile(lockPath, "utf8");
					if (current.split("\n")[2] === lockToken) await rm(lockPath, { force: true });
				} catch {
					// The lock was already removed or replaced. Never delete a lock we cannot prove we own.
				}
			};
		} catch (error) {
			const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
			if (code !== "EEXIST") throw error;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
}

async function withLock<T>(targetPath: string, operation: () => Promise<T>): Promise<T> {
	const release = await acquireLock(targetPath);
	try {
		return await operation();
	} finally {
		await release();
	}
}

export async function initializeStore(
	storePath: string,
	options: { runId?: string; workflow?: string; now?: Date } = {},
): Promise<StoreManifest> {
	await mkdir(storePath, { recursive: true, mode: 0o700 });
	const manifestPath = path.join(storePath, "manifest.json");
	const runId = options.runId ?? path.basename(path.dirname(storePath));
	const workflow = options.workflow ?? "manual";
	if (!RUN_ID_PATTERN.test(runId)) throw new Error(`Invalid findings run id: ${runId}`);
	const manifest: StoreManifest = {
		schemaVersion: FINDING_SCHEMA_VERSION,
		kind: "pi-shipyard-review-findings",
		runId,
		workflow: boundedText(workflow, "Store workflow", 128),
		createdAt: (options.now ?? new Date()).toISOString(),
	};
	try {
		await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
		return manifest;
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
		if (code !== "EEXIST") throw error;
		const current = JSON.parse(await readFile(manifestPath, "utf8")) as StoreManifest;
		if (
			current.schemaVersion !== FINDING_SCHEMA_VERSION
			|| current.kind !== manifest.kind
			|| !RUN_ID_PATTERN.test(current.runId)
		) {
			throw new Error(`Invalid findings store manifest: ${manifestPath}`);
		}
		if (current.runId !== runId) throw new Error(`Findings store run mismatch: manifest ${current.runId}, directory ${runId}`);
		if (options.workflow && current.workflow !== options.workflow) throw new Error(`Findings store workflow mismatch: ${current.workflow}`);
		return current;
	}
}

function collectionLockTarget(storePath: string): string {
	return path.join(storePath, ".collection");
}

export async function addFinding(storePath: string, input: AddFindingInput, now = new Date()): Promise<Finding> {
	const manifest = await initializeStore(storePath);
	return withLock(collectionLockTarget(storePath), async () => {
		const current = await listFindings(storePath);
		if (current.length >= MAX_FINDINGS) throw new Error(`Findings store reached its ${MAX_FINDINGS}-finding limit.`);
		const timestamp = now.toISOString();
		const id = `F-${now.getTime().toString(36)}-${randomUUID().slice(0, 8).toLowerCase()}`;
		const finding = validateFinding({
			schemaVersion: FINDING_SCHEMA_VERSION,
			id,
			revision: 1,
			runId: manifest.runId,
			workflow: manifest.workflow,
			stage: input.stage,
			title: input.title,
			summary: input.summary,
			severity: input.severity,
			confidence: input.confidence,
			status: "proposed",
			category: input.category,
			sourceRole: input.sourceRole,
			evidence: input.evidence,
			failureScenario: input.failureScenario,
			suggestedFix: input.suggestedFix,
			...(input.validation?.trim() ? { validation: input.validation.trim() } : {}),
			tags: input.tags ?? [],
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		await writeJsonExclusive(findingPath(storePath, id), finding);
		return finding;
	});
}

function assertFindingIdentity(finding: Finding, manifest: StoreManifest): Finding {
	if (finding.runId !== manifest.runId || finding.workflow !== manifest.workflow) {
		throw new Error(`Finding ${finding.id} identity mismatch: record ${finding.runId}/${finding.workflow}, store ${manifest.runId}/${manifest.workflow}.`);
	}
	return finding;
}

async function readFindingForManifest(storePath: string, id: string, manifest: StoreManifest): Promise<Finding> {
	const raw = await readFile(findingPath(storePath, id), "utf8");
	return assertFindingIdentity(validateFinding(JSON.parse(raw) as Finding), manifest);
}

export async function getFinding(storePath: string, id: string): Promise<Finding> {
	const manifest = await initializeStore(storePath);
	return readFindingForManifest(storePath, id, manifest);
}

export async function listFindings(storePath: string, filter: FindingFilter = {}): Promise<Finding[]> {
	const manifest = await initializeStore(storePath);
	const entries = await readdir(storePath, { withFileTypes: true });
	const findings: Finding[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.startsWith("F-") || !entry.name.endsWith(".json")) continue;
		const raw = await readFile(path.join(storePath, entry.name), "utf8");
		findings.push(assertFindingIdentity(validateFinding(JSON.parse(raw) as Finding), manifest));
	}
	const severityRank = new Map(SEVERITIES.map((severity, index) => [severity, index]));
	return findings
		.filter((finding) => filter.severity === undefined || finding.severity === filter.severity)
		.filter((finding) => filter.confidence === undefined || finding.confidence === filter.confidence)
		.filter((finding) => filter.status === undefined || finding.status === filter.status)
		.filter((finding) => filter.category === undefined || finding.category === filter.category)
		.filter((finding) => filter.sourceRole === undefined || finding.sourceRole === filter.sourceRole)
		.filter((finding) => filter.stage === undefined || finding.stage === filter.stage)
		.filter((finding) => filter.tag === undefined || finding.tags.includes(filter.tag.toLowerCase()))
		.sort((left, right) => {
			const severityDifference = (severityRank.get(left.severity) ?? 99) - (severityRank.get(right.severity) ?? 99);
			return severityDifference || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
		});
}

export async function updateFinding(
	storePath: string,
	id: string,
	patch: FindingPatch,
	expectedRevision: number,
	now = new Date(),
): Promise<Finding> {
	await initializeStore(storePath);
	const targetPath = findingPath(storePath, id);
	return withLock(collectionLockTarget(storePath), () => withLock(targetPath, async () => {
		const current = await getFinding(storePath, id);
		if (current.revision !== expectedRevision) {
			throw new Error(`Revision conflict for ${id}: expected ${expectedRevision}, found ${current.revision}. Re-read before updating.`);
		}
		const updated = validateFinding({
			...current,
			...patch,
			id: current.id,
			runId: current.runId,
			workflow: current.workflow,
			stage: current.stage,
			sourceRole: current.sourceRole,
			schemaVersion: FINDING_SCHEMA_VERSION,
			revision: current.revision + 1,
			createdAt: current.createdAt,
			updatedAt: now.toISOString(),
		});
		await writeJsonAtomic(targetPath, updated);
		return updated;
	}));
}

export function summarizeFindings(findings: Finding[]): FindingStats {
	const stats: FindingStats = {
		total: findings.length,
		bySeverity: { blocker: 0, high: 0, medium: 0, low: 0 },
		byStatus: { proposed: 0, verified: 0, rejected: 0, deferred: 0, resolved: 0 },
		byConfidence: { high: 0, medium: 0, low: 0 },
	};
	for (const finding of findings) {
		stats.bySeverity[finding.severity]++;
		stats.byStatus[finding.status]++;
		stats.byConfidence[finding.confidence]++;
	}
	return stats;
}

export async function snapshotFindings(storePath: string, label: string, now = new Date()): Promise<StoreSnapshot> {
	if (!SNAPSHOT_LABEL_PATTERN.test(label)) throw new Error(`Invalid snapshot label: ${label}`);
	return withLock(collectionLockTarget(storePath), async () => {
		const manifest = await initializeStore(storePath);
		const findings = await listFindings(storePath);
		const records = findings.map((finding) => {
			const serialized = JSON.stringify(finding);
			return { id: finding.id, revision: finding.revision, sha256: createHash("sha256").update(serialized).digest("hex") };
		});
		const snapshot: StoreSnapshot = {
			schemaVersion: FINDING_SCHEMA_VERSION,
			runId: manifest.runId,
			workflow: manifest.workflow,
			label,
			createdAt: now.toISOString(),
			findings: records,
			sha256: createHash("sha256").update(JSON.stringify(records)).digest("hex"),
		};
		const targetPath = path.join(storePath, "snapshots", `${label}.json`);
		await writeJsonAtomic(targetPath, snapshot);
		return snapshot;
	});
}

function evidenceLocation(evidence: FindingEvidence): string {
	if (evidence.lineStart === undefined) return evidence.path;
	const range = evidence.lineEnd !== undefined && evidence.lineEnd !== evidence.lineStart
		? `${evidence.lineStart}-${evidence.lineEnd}`
		: String(evidence.lineStart);
	return `${evidence.path}:${range}`;
}

export function findingsToMarkdown(findings: Finding[], title = "Review findings"): string {
	const stats = summarizeFindings(findings);
	const lines = [
		`# ${title}`,
		"",
		`Total: ${stats.total} · Verified: ${stats.byStatus.verified} · Proposed: ${stats.byStatus.proposed} · Rejected: ${stats.byStatus.rejected} · Deferred: ${stats.byStatus.deferred} · Resolved: ${stats.byStatus.resolved}`,
		"",
	];
	if (findings.length === 0) return `${lines.join("\n")}No findings recorded.\n`;
	for (const finding of findings) {
		lines.push(`## ${finding.id}: ${finding.title}`, "");
		lines.push(`- Run: ${finding.runId}`);
		lines.push(`- Stage: ${finding.stage}`);
		lines.push(`- Status: ${finding.status}`);
		lines.push(`- Severity: ${finding.severity}`);
		lines.push(`- Confidence: ${finding.confidence}`);
		lines.push(`- Category: ${finding.category}`);
		lines.push(`- Source: ${finding.sourceRole}`);
		lines.push(`- Revision: ${finding.revision}`);
		if (finding.tags.length > 0) lines.push(`- Tags: ${finding.tags.join(", ")}`);
		lines.push("", finding.summary, "", "### Failure scenario", "", finding.failureScenario, "", "### Evidence", "");
		for (const evidence of finding.evidence) {
			const symbol = evidence.symbol ? ` (${evidence.symbol})` : "";
			lines.push(`- \`${evidenceLocation(evidence)}\`${symbol}: ${evidence.detail}`);
		}
		lines.push("", "### Smallest safe fix", "", finding.suggestedFix, "");
		if (finding.validation) lines.push("### Validation", "", finding.validation, "");
		if (finding.dispositionReason) lines.push("### Disposition", "", finding.dispositionReason, "");
	}
	return lines.join("\n");
}

async function writeTextAtomic(targetPath: string, content: string): Promise<void> {
	await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
	const release = await acquireLock(targetPath);
	const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(temporaryPath, "wx", 0o600);
		await handle.writeFile(content.endsWith("\n") ? content : `${content}\n`, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporaryPath, targetPath);
	} finally {
		await handle?.close().catch(() => undefined);
		await rm(temporaryPath, { force: true }).catch(() => undefined);
		await release();
	}
}

export async function exportFindings(storePath: string, outputPath: string, title?: string): Promise<{ path: string; count: number }> {
	return withLock(collectionLockTarget(storePath), async () => {
		const findings = await listFindings(storePath);
		await writeTextAtomic(outputPath, findingsToMarkdown(findings, title));
		return { path: outputPath, count: findings.length };
	});
}
