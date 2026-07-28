import assert from "node:assert/strict";
import test from "node:test";
import {
	buildCompletionReport,
	MAX_COMPLETION_REPORT_MARKDOWN,
} from "../../extensions/core/completion-report.ts";
import {
	PACKAGED_AUDIT_WORKFLOW_AGENT,
	PACKAGED_DELIVER_WORKFLOW_AGENTS,
} from "../../extensions/core/packaged-workflow.ts";

function receipt(verdict: "READY" | "NOT_READY", findings: Array<Record<string, unknown>> = []) {
	return {
		verdict,
		summary: verdict === "READY" ? "The delivered state passed review." : "Critical findings remain.",
		findings,
		validationEvidence: [{ check: "focused tests", status: "VERIFIED", evidence: "passed" }],
		residualRisks: [],
	};
}

function finding(severity: "P0" | "P1" | "P2" | "P3", path = "src/service.ts") {
	return {
		severity,
		confidence: 0.9,
		path,
		line: { start: 7, end: 7 },
		violatedContract: "Requests remain authorized.",
		scenario: "An untrusted request reaches the mutation path.",
		safeFix: "Restore the authorization check.",
		validation: "Add and run a denied-request regression.",
	};
}

test("recognizes only exact packaged workflow completion identities", () => {
	for (const [index, agent] of PACKAGED_DELIVER_WORKFLOW_AGENTS.entries()) {
		const report = buildCompletionReport({
			runId: `deliver-shape-${index}`,
			mode: "chain",
			agent,
			results: [{ structuredOutput: receipt("READY") }],
		});
		assert.equal(report?.verdict, "READY");
	}
	assert.equal(buildCompletionReport({
		runId: "other",
		mode: "chain",
		agent: `${PACKAGED_AUDIT_WORKFLOW_AGENT}->other.agent`,
		results: [],
	}), undefined);
	assert.equal(buildCompletionReport({
		runId: "wrong-mode",
		mode: "single",
		agent: PACKAGED_AUDIT_WORKFLOW_AGENT,
		results: [],
	}), undefined);
	assert.equal(buildCompletionReport({
		runId: "old-no-repair-shape",
		mode: "chain",
		agent: "chain:pi-workbench.planner->pi-workbench.worker->pi-workbench.reviewer->pi-workbench.risk-reviewer->pi-workbench.reviewer",
		results: [{ structuredOutput: receipt("READY") }],
	}), undefined);
});

test("scans results in reverse for the last valid structured receipt", () => {
	const report = buildCompletionReport({
		runId: "deliver-repair",
		mode: "chain",
		agent: PACKAGED_DELIVER_WORKFLOW_AGENTS[2],
		results: [
			{ structuredOutput: receipt("READY") },
			{ structuredOutput: receipt("NOT_READY", [finding("P2"), finding("P0")]) },
			{ skipped: true },
			{ structuredOutput: { verdict: "READY", summary: "invalid because required arrays are absent" } },
		],
	});
	assert.ok(report);
	assert.equal(report.source, "structured");
	assert.equal(report.verdict, "NOT_READY");
	assert.equal(report.highestSeverity, "P0");
	assert.equal(report.needsAttention, true);
	assert.match(report.markdown, /Highest severity: \*\*P0\*\*/);
	assert.match(report.markdown, /src\/service\.ts:7/);
});

test("renders READY receipts without an attention gate and bounds markdown", () => {
	const report = buildCompletionReport({
		runId: "deliver-ready",
		mode: "chain",
		agent: PACKAGED_DELIVER_WORKFLOW_AGENTS[0],
		results: [{ structuredOutput: { ...receipt("READY"), summary: "x".repeat(MAX_COMPLETION_REPORT_MARKDOWN * 2) } }],
	});
	assert.ok(report);
	assert.equal(report.verdict, "READY");
	assert.equal(report.needsAttention, false);
	assert.ok(report.markdown.length <= MAX_COMPLETION_REPORT_MARKDOWN);
	assert.match(report.markdown, /report was truncated/);
});

test("uses only an anchored audit verdict and otherwise surfaces root failure", () => {
	const audit = buildCompletionReport({
		runId: "audit-1",
		mode: "chain",
		agent: PACKAGED_AUDIT_WORKFLOW_AGENT,
		results: [
			{ structuredOutput: receipt("READY") },
			{ structuredOutput: receipt("NOT_READY", [finding("P0")]) },
			{ output: "NOT READY\n\n- P1: final synthesized runtime failure" },
		],
	});
	assert.ok(audit);
	assert.equal(audit.source, "audit-prose");
	assert.equal(audit.verdict, "NOT_READY");
	assert.equal(audit.highestSeverity, undefined);
	assert.doesNotMatch(audit.markdown, /Highest severity:/);
	assert.doesNotMatch(audit.markdown, /P0/);

	const failed = buildCompletionReport({
		runId: "audit-2",
		mode: "chain",
		agent: PACKAGED_AUDIT_WORKFLOW_AGENT,
		success: false,
		error: "Reviewer process failed before receipt capture.",
		results: [{ output: "Preface: READY is not an anchored verdict." }],
	});
	assert.ok(failed);
	assert.equal(failed.source, "root-failure");
	assert.equal(failed.verdict, "FAILED");
	assert.equal(failed.needsAttention, true);
	assert.match(failed.markdown, /Reviewer process failed/);
});

test("audit trusts only the terminal result and fails closed when its first line is not a verdict", () => {
	const failed = buildCompletionReport({
		runId: "audit-malformed-terminal",
		mode: "chain",
		agent: PACKAGED_AUDIT_WORKFLOW_AGENT,
		results: [
			{ output: "NOT READY\n\nEarlier review prose must not become the audit verdict." },
			{ structuredOutput: receipt("READY") },
			{ output: "Synthesis complete.\nREADY" },
		],
	});
	assert.ok(failed);
	assert.equal(failed.source, "root-failure");
	assert.equal(failed.verdict, "FAILED");
	assert.equal(failed.needsAttention, true);
	assert.match(failed.markdown, /without an anchored terminal synthesis receipt/);
	assert.doesNotMatch(failed.markdown, /Earlier review prose/);

	const blankFirstLine = buildCompletionReport({
		runId: "audit-blank-first-line",
		mode: "chain",
		agent: PACKAGED_AUDIT_WORKFLOW_AGENT,
		results: [{ output: "\nREADY\nThe verdict is not on the first line." }],
	});
	assert.equal(blankFirstLine?.verdict, "FAILED");
});

test("audit prose never infers a highest-severity header from incidental labels", () => {
	const ready = buildCompletionReport({
		runId: "audit-ready-no-critical",
		mode: "chain",
		agent: PACKAGED_AUDIT_WORKFLOW_AGENT,
		results: [{ output: "READY\n\nNo P0 or P1 findings remain." }],
	});
	assert.ok(ready);
	assert.equal(ready.source, "audit-prose");
	assert.equal(ready.verdict, "READY");
	assert.equal(ready.highestSeverity, undefined);
	assert.doesNotMatch(ready.markdown, /Highest severity:/);
});

test("root failure takes precedence over an earlier structured decision", () => {
	const failed = buildCompletionReport({
		runId: "repair-failed",
		mode: "chain",
		agent: PACKAGED_DELIVER_WORKFLOW_AGENTS[1],
		success: false,
		state: "failed",
		error: "The bounded repair worker exited before re-review.",
		results: [
			{ structuredOutput: receipt("NOT_READY", [finding("P1")]) },
			{ error: "repair failed", output: "repair failed" },
		],
	});
	assert.ok(failed);
	assert.equal(failed.source, "root-failure");
	assert.equal(failed.verdict, "FAILED");
	assert.match(failed.markdown, /bounded repair worker exited/);
});

test("root failure prefers the last failed child so long summaries cannot bury the error", () => {
	const failed = buildCompletionReport({
		runId: "long-failure",
		mode: "chain",
		agent: PACKAGED_DELIVER_WORKFLOW_AGENTS[0],
		success: false,
		state: "failed",
		summary: `${"Earlier successful output. ".repeat(MAX_COMPLETION_REPORT_MARKDOWN)}\nBuried aggregate error.`,
		results: [
			{ success: true, structuredOutput: receipt("NOT_READY", [finding("P1")]) },
			{ success: false, exitCode: 1, error: "Terminal worker error that must remain visible.", output: "less precise output" },
		],
	});
	assert.ok(failed);
	assert.equal(failed.source, "root-failure");
	assert.match(failed.markdown, /Terminal worker error that must remain visible/);
	assert.doesNotMatch(failed.markdown, /Buried aggregate error/);
});

test("root error takes precedence over a failed child error", () => {
	const failed = buildCompletionReport({
		runId: "root-error",
		mode: "chain",
		agent: PACKAGED_DELIVER_WORKFLOW_AGENTS[1],
		success: false,
		state: "failed",
		error: "Authoritative root failure.",
		results: [{ success: false, error: "Child failure." }],
	});
	assert.ok(failed);
	assert.match(failed.markdown, /Authoritative root failure/);
	assert.doesNotMatch(failed.markdown, /Child failure/);
});
