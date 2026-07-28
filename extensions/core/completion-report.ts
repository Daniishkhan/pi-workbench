import { packagedWorkflowKind, type PackagedWorkflowKind } from "./packaged-workflow.ts";

export const MAX_COMPLETION_REPORT_MARKDOWN = 16_000;

export type ReviewSeverity = "P0" | "P1" | "P2" | "P3";
export type CompletionVerdict = "READY" | "NOT_READY" | "FAILED";
export type CompletionReportSource = "structured" | "audit-prose" | "root-failure";

export interface CompletionReport {
	runId: string;
	workflow: PackagedWorkflowKind;
	verdict: CompletionVerdict;
	highestSeverity?: ReviewSeverity;
	needsAttention: boolean;
	source: CompletionReportSource;
	markdown: string;
}

interface StructuredFinding extends Record<string, unknown> {
	severity: ReviewSeverity;
}

interface StructuredReceipt extends Record<string, unknown> {
	verdict: "READY" | "NOT_READY";
	summary: string;
	findings: StructuredFinding[];
	validationEvidence: unknown[];
	residualRisks: unknown[];
}

const SEVERITY_ORDER: readonly ReviewSeverity[] = ["P0", "P1", "P2", "P3"];
const EVIDENCE_STATES = new Set(["VERIFIED", "REPORTED", "MISSING", "STALE", "NOT_APPLICABLE"]);
const AUDIT_VERDICT = /^[\t ]*(READY|NOT(?:_|[\t ]+)READY)\b/i;
const FAILURE_STATES = new Set(["failed", "stopped", "timed_out", "timeout", "paused"]);

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function severity(value: unknown): ReviewSeverity | undefined {
	return typeof value === "string" && (SEVERITY_ORDER as readonly string[]).includes(value)
		? value as ReviewSeverity
		: undefined;
}

function validFinding(value: unknown): StructuredFinding | undefined {
	const finding = record(value);
	const findingSeverity = severity(finding?.severity);
	const confidence = finding?.confidence;
	const line = record(finding?.line);
	if (
		!finding
		|| !findingSeverity
		|| typeof confidence !== "number"
		|| !Number.isFinite(confidence)
		|| confidence < 0
		|| confidence > 1
		|| !nonEmptyString(finding.path)
		|| typeof line?.start !== "number"
		|| !Number.isInteger(line.start)
		|| line.start < 1
		|| typeof line.end !== "number"
		|| !Number.isInteger(line.end)
		|| line.end < 1
		|| !nonEmptyString(finding.violatedContract)
		|| !nonEmptyString(finding.scenario)
		|| !nonEmptyString(finding.safeFix)
		|| !nonEmptyString(finding.validation)
	) return undefined;
	return { ...finding, severity: findingSeverity };
}

function validEvidence(value: unknown): boolean {
	const evidence = record(value);
	return Boolean(
		evidence
		&& nonEmptyString(evidence.check)
		&& typeof evidence.status === "string"
		&& EVIDENCE_STATES.has(evidence.status)
		&& nonEmptyString(evidence.evidence),
	);
}

function validLedgerDisposition(value: unknown, verdict: "READY" | "NOT_READY"): boolean {
	if (value === undefined) return true;
	const disposition = record(value);
	return Boolean(
		disposition
		&& nonEmptyString(disposition.artifactPath)
		&& nonEmptyString(disposition.gateId)
		&& disposition.result === verdict
		&& nonEmptyString(disposition.evidenceSummary)
		&& nonEmptyString(disposition.requiredNextState),
	);
}

function structuredReceipt(value: unknown): StructuredReceipt | undefined {
	const candidate = record(value);
	if (!candidate || (candidate.verdict !== "READY" && candidate.verdict !== "NOT_READY")) return undefined;
	const summary = nonEmptyString(candidate.summary);
	if (!summary || !Array.isArray(candidate.findings) || !Array.isArray(candidate.validationEvidence) || !Array.isArray(candidate.residualRisks)) {
		return undefined;
	}
	const findings: StructuredFinding[] = [];
	for (const value of candidate.findings) {
		const finding = validFinding(value);
		if (!finding) return undefined;
		findings.push(finding);
	}
	if ((candidate.verdict === "READY" && findings.length !== 0) || (candidate.verdict === "NOT_READY" && findings.length === 0)) {
		return undefined;
	}
	if (
		!candidate.validationEvidence.every(validEvidence)
		|| !candidate.residualRisks.every((risk) => Boolean(nonEmptyString(risk)))
		|| !validLedgerDisposition(candidate.ledgerDisposition, candidate.verdict)
	) {
		return undefined;
	}
	return {
		...candidate,
		verdict: candidate.verdict,
		summary,
		findings,
		validationEvidence: candidate.validationEvidence,
		residualRisks: candidate.residualRisks,
	};
}

function highestSeverity(values: Iterable<ReviewSeverity>): ReviewSeverity | undefined {
	const found = new Set(values);
	return SEVERITY_ORDER.find((value) => found.has(value));
}

function severityFromText(text: string): ReviewSeverity | undefined {
	const found = SEVERITY_ORDER.filter((value) => new RegExp(`\\b${value}\\b`, "i").test(text));
	return highestSeverity(found);
}

function text(value: unknown): string | undefined {
	return nonEmptyString(value);
}

function boundedMarkdown(markdown: string): string {
	if (markdown.length <= MAX_COMPLETION_REPORT_MARKDOWN) return markdown;
	const suffix = "\n\n_The report was truncated for safe presentation. Use the normal inline completion receipt for the full output._";
	return `${markdown.slice(0, MAX_COMPLETION_REPORT_MARKDOWN - suffix.length).trimEnd()}${suffix}`;
}

function heading(workflow: PackagedWorkflowKind, runId: string, verdict: CompletionVerdict, severityValue?: ReviewSeverity): string[] {
	const title = workflow === "deliver" ? "Delivery report" : "Audit report";
	return [
		`# Pi Engineering ${title}`,
		"",
		`- Run: \`${runId}\``,
		`- Outcome: **${verdict.replace("_", " ")}**`,
		...(severityValue ? [`- Highest severity: **${severityValue}**`] : []),
	];
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.flatMap((item) => nonEmptyString(item) ?? []) : [];
}

function lineLocation(finding: Record<string, unknown>): string {
	const path = nonEmptyString(finding.path) ?? "Unknown location";
	const line = record(finding.line);
	const start = typeof line?.start === "number" && Number.isInteger(line.start) ? line.start : undefined;
	const end = typeof line?.end === "number" && Number.isInteger(line.end) ? line.end : undefined;
	if (!start) return path;
	return end && end !== start ? `${path}:${start}-${end}` : `${path}:${start}`;
}

function structuredMarkdown(workflow: PackagedWorkflowKind, runId: string, receipt: StructuredReceipt): string {
	const highest = highestSeverity(receipt.findings.map((finding) => finding.severity));
	const lines = [
		...heading(workflow, runId, receipt.verdict, highest),
		"",
		"## Summary",
		"",
		receipt.summary,
	];
	if (receipt.findings.length) {
		lines.push("", "## Findings", "");
		for (const [index, finding] of receipt.findings.entries()) {
			const confidence = typeof finding.confidence === "number" && Number.isFinite(finding.confidence)
				? ` · ${Math.round(finding.confidence * 100)}% confidence`
				: "";
			lines.push(`### ${index + 1}. ${finding.severity} · ${lineLocation(finding)}${confidence}`);
			for (const [label, key] of [
				["Contract", "violatedContract"],
				["Scenario", "scenario"],
				["Safe fix", "safeFix"],
				["Validation", "validation"],
			] as const) {
				const value = nonEmptyString(finding[key]);
				if (value) lines.push("", `**${label}:** ${value}`);
			}
			lines.push("");
		}
	}
	if (receipt.validationEvidence.length) {
		lines.push("", "## Validation evidence", "");
		for (const item of receipt.validationEvidence) {
			const evidence = record(item);
			if (!evidence) continue;
			const check = nonEmptyString(evidence.check);
			const status = nonEmptyString(evidence.status);
			const detail = nonEmptyString(evidence.evidence);
			if (check || detail) lines.push(`- ${status ? `**${status}** · ` : ""}${check ?? "Check"}${detail ? ` — ${detail}` : ""}`);
		}
	}
	const risks = stringList(receipt.residualRisks);
	if (risks.length) lines.push("", "## Residual risks", "", ...risks.map((risk) => `- ${risk}`));
	return boundedMarkdown(lines.join("\n").trimEnd());
}

function resultRecords(payload: Record<string, unknown>): Record<string, unknown>[] {
	if (!Array.isArray(payload.results)) return [];
	const results: Record<string, unknown>[] = [];
	for (const value of payload.results) {
		const result = record(value);
		if (result) results.push(result);
	}
	return results;
}

function findLastStructuredReceipt(results: readonly Record<string, unknown>[]): StructuredReceipt | undefined {
	for (let index = results.length - 1; index >= 0; index -= 1) {
		const result = results[index]!;
		const receipt = structuredReceipt(result.structuredOutput);
		if (receipt) return receipt;
	}
	return undefined;
}

function terminalResult(payload: Record<string, unknown>): Record<string, unknown> | undefined {
	if (!Array.isArray(payload.results) || payload.results.length === 0) return undefined;
	return record(payload.results.at(-1));
}

function auditProse(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	return value.trimEnd();
}

function findAnchoredAuditProse(result: Record<string, unknown> | undefined): { prose: string; verdict: "READY" | "NOT_READY" } | undefined {
	if (!result) return undefined;
	const prose = [result.output, result.finalOutput, result.summary]
		.map(auditProse)
		.find((candidate) => candidate !== undefined);
	if (!prose) return undefined;
	const match = AUDIT_VERDICT.exec(prose);
	if (!match) return undefined;
	return { prose, verdict: /^READY$/i.test(match[1]!) ? "READY" : "NOT_READY" };
}

function isFailedResult(result: Record<string, unknown>): boolean {
	const state = text(result.state)?.toLowerCase() ?? text(result.status)?.toLowerCase();
	return result.success === false
		|| result.timedOut === true
		|| result.stopped === true
		|| (typeof result.exitCode === "number" && result.exitCode !== 0)
		|| Boolean(text(result.error))
		|| Boolean(state && FAILURE_STATES.has(state));
}

function rootFailure(
	payload: Record<string, unknown>,
	results: readonly Record<string, unknown>[],
): string | undefined {
	const state = text(payload.state)?.toLowerCase();
	const failed = payload.success === false || (state ? FAILURE_STATES.has(state) : false);
	if (!failed) return undefined;
	const rootError = text(payload.error);
	if (rootError) return rootError;
	for (let index = results.length - 1; index >= 0; index -= 1) {
		const result = results[index]!;
		if (!isFailedResult(result)) continue;
		const failure = text(result.error) ?? text(result.output) ?? text(result.summary);
		if (failure) return failure;
	}
	return text(payload.summary) ?? "The workflow failed before producing a terminal review receipt.";
}

function failedReport(
	workflow: PackagedWorkflowKind,
	runId: string,
	failure: string,
): CompletionReport {
	const failureSeverity = severityFromText(failure);
	return {
		runId,
		workflow,
		verdict: "FAILED",
		...(failureSeverity ? { highestSeverity: failureSeverity } : {}),
		needsAttention: true,
		source: "root-failure",
		markdown: boundedMarkdown([
			...heading(workflow, runId, "FAILED", failureSeverity),
			"",
			"## What needs attention",
			"",
			failure,
		].join("\n")),
	};
}

/** Build a bounded human report only for an exact packaged terminal workflow. */
export function buildCompletionReport(payload: unknown): CompletionReport | undefined {
	const workflow = packagedWorkflowKind(payload);
	const value = record(payload);
	const runId = nonEmptyString(value?.runId);
	if (!workflow || !value || !runId) return undefined;
	const results = resultRecords(value);
	const failure = rootFailure(value, results);
	if (failure) return failedReport(workflow, runId, failure);

	if (workflow === "audit") {
		const prose = findAnchoredAuditProse(terminalResult(value));
		if (prose) {
			return {
				runId,
				workflow,
				verdict: prose.verdict,
				needsAttention: prose.verdict !== "READY",
				source: "audit-prose",
				markdown: boundedMarkdown([
					...heading(workflow, runId, prose.verdict),
					"",
					"## Review",
					"",
					prose.prose,
				].join("\n")),
			};
		}
		return failedReport(workflow, runId, "The audit completed without an anchored terminal synthesis receipt.");
	}

	const receipt = findLastStructuredReceipt(results);
	if (!receipt) return failedReport(workflow, runId, "The delivery completed without a valid terminal review receipt.");
	const findingSeverity = highestSeverity(receipt.findings.map((finding) => finding.severity));
	return {
		runId,
		workflow,
		verdict: receipt.verdict,
		...(findingSeverity ? { highestSeverity: findingSeverity } : {}),
		needsAttention: receipt.verdict !== "READY",
		source: "structured",
		markdown: structuredMarkdown(workflow, runId, receipt),
	};
}
