import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RECOVERY_TEXT = "Submitting the final structured result after completing the task.";
const MAX_RECEIPT_FINDINGS = 10;
const MAX_RECEIPT_CHARS = 6_000;

interface MessageLike {
	role?: unknown;
	content?: unknown;
}

interface ContentLike {
	type?: unknown;
	name?: unknown;
	text?: unknown;
	arguments?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function compactText(value: unknown, limit = 500): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
	if (!text) return undefined;
	return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/** Render the validated receipt fields that must survive into the async
 * completion summary. Keep it bounded; the full JSON remains run-scoped. */
export function renderStructuredReceipt(value: unknown): string | undefined {
	const receipt = record(value);
	const verdict = receipt?.verdict === "READY" || receipt?.verdict === "NOT_READY" ? receipt.verdict : undefined;
	const summary = compactText(receipt?.summary, 800);
	if (!receipt || (!verdict && !summary)) return undefined;
	const lines = [`${verdict ?? "RESULT"}: ${summary ?? "Structured review completed."}`];

	const findings = Array.isArray(receipt.findings) ? receipt.findings : [];
	for (const findingValue of findings.slice(0, MAX_RECEIPT_FINDINGS)) {
		const finding = record(findingValue);
		if (!finding) continue;
		const line = record(finding.line);
		const start = typeof line?.start === "number" ? `:${line.start}` : "";
		const severity = compactText(finding.severity, 20) ?? "finding";
		const location = `${compactText(finding.path, 240) ?? "unknown path"}${start}`;
		const contract = compactText(finding.violatedContract, 320);
		const scenario = compactText(finding.scenario, 500);
		const safeFix = compactText(finding.safeFix, 500);
		lines.push(`- [${severity}] ${location}${contract ? ` — ${contract}` : ""}${scenario ? `; ${scenario}` : ""}${safeFix ? `; fix: ${safeFix}` : ""}`);
	}
	if (findings.length > MAX_RECEIPT_FINDINGS) lines.push(`- … ${findings.length - MAX_RECEIPT_FINDINGS} additional findings remain in the structured receipt.`);

	const evidence = Array.isArray(receipt.validationEvidence) ? receipt.validationEvidence : [];
	if (evidence.length > 0) {
		const summaryText = evidence.slice(0, 8).flatMap((entryValue) => {
			const entry = record(entryValue);
			if (!entry) return [];
			const check = compactText(entry.check, 160);
			const status = compactText(entry.status, 40);
			return check && status ? [`${check}=${status}`] : [];
		}).join(", ");
		if (summaryText) lines.push(`Validation: ${summaryText}${evidence.length > 8 ? `, +${evidence.length - 8} more` : ""}.`);
	}

	const risks = Array.isArray(receipt.residualRisks)
		? receipt.residualRisks.flatMap((risk) => compactText(risk, 300) ?? []).slice(0, 5)
		: [];
	if (risks.length > 0) lines.push(`Residual risks: ${risks.join("; ")}.`);
	const rendered = lines.join("\n");
	return rendered.length <= MAX_RECEIPT_CHARS ? rendered : `${rendered.slice(0, MAX_RECEIPT_CHARS - 1)}…`;
}

/**
 * A terminating `structured_output` call can be the final assistant message.
 * Give that otherwise tool-only message a small text block so the upstream
 * runtime recognizes earlier, corrected tool errors as recovered.
 */
export function recoverStructuredOutputFinalization(message: unknown): unknown | undefined {
	if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
	const value = message as MessageLike;
	if (value.role !== "assistant" || !Array.isArray(value.content)) return undefined;
	const content = value.content as ContentLike[];
	const structuredCall = content.find((part) => part?.type === "toolCall" && part.name === "structured_output");
	if (!structuredCall) return undefined;
	const hasText = content.some((part) => part?.type === "text" && typeof part.text === "string" && part.text.trim().length > 0);
	const args = record(structuredCall.arguments);
	const receipt = renderStructuredReceipt(args?.value);
	if (!receipt && hasText) return undefined;
	return {
		...(message as Record<string, unknown>),
		content: [{ type: "text", text: receipt ?? RECOVERY_TEXT }, ...content],
	};
}

export default function registerStructuredOutputRecovery(pi: ExtensionAPI): void {
	pi.on("message_end", (event) => {
		const message = recoverStructuredOutputFinalization(event.message);
		return message ? { message: message as never } : undefined;
	});
}
