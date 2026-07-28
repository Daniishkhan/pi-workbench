import assert from "node:assert/strict";
import test from "node:test";
import { AssignmentBoundary } from "../../extensions/core/assignment-boundary.ts";
import {
	MAX_PLANNOTATOR_FEEDBACK_LENGTH,
	MAX_PRESENTED_RUN_IDS,
	PLANNOTATOR_REQUEST_CHANNEL,
	PlannotatorPresenter,
} from "../../extensions/core/plannotator-presenter.ts";
import { PACKAGED_DELIVER_WORKFLOW_AGENTS } from "../../extensions/core/packaged-workflow.ts";

function payload(runId: string, verdict: "READY" | "NOT_READY") {
	return {
		runId,
		mode: "chain",
		agent: PACKAGED_DELIVER_WORKFLOW_AGENTS[0],
		results: [{
			structuredOutput: {
				verdict,
				summary: `${verdict} report`,
				findings: verdict === "READY" ? [] : [{
					severity: "P1",
					confidence: 0.95,
					path: "src/service.ts",
					line: { start: 4, end: 4 },
					violatedContract: "The request is authorized.",
					scenario: "An unauthorized request mutates state.",
					safeFix: "Restore the authorization check.",
					validation: "Run the denied-request regression.",
				}],
				validationEvidence: [],
				residualRisks: [],
			},
		}],
	};
}

type Request = {
	requestId: string;
	action: string;
	payload: { filePath: string; markdown: string; mode: string; gate: boolean };
	respond: (response: unknown) => void;
};

test("emits one annotate-last request per run with verdict-aware gating", () => {
	const requests: Array<{ channel: string; request: Request }> = [];
	const presenter = new PlannotatorPresenter({
		events: { emit(channel, request) { requests.push({ channel, request: request as Request }); } },
		assignmentBoundary: new AssignmentBoundary(),
		sendUserMessage() {},
	});
	assert.equal(presenter.present(payload("ready", "READY")), true);
	assert.equal(presenter.present(payload("ready", "READY")), false);
	assert.equal(presenter.present(payload("attention", "NOT_READY")), true);
	assert.equal(requests.length, 2);
	assert.equal(requests[0]!.channel, PLANNOTATOR_REQUEST_CHANNEL);
	assert.equal(requests[0]!.request.action, "annotate-last");
	assert.equal(requests[0]!.request.payload.filePath, "last-message");
	assert.equal(requests[0]!.request.payload.mode, "annotate-last");
	assert.equal(requests[0]!.request.payload.gate, false);
	assert.match(requests[0]!.request.payload.markdown, /READY/);
	assert.equal(requests[1]!.request.payload.gate, true);
});

test("routes bounded non-empty annotation feedback as explicit human input", () => {
	let request: Request | undefined;
	const sent: Array<{ content: string; deliverAs?: string }> = [];
	const boundary = new AssignmentBoundary();
	const attempt = boundary.beginWorkflowAttempt();
	boundary.attachWorkflow(attempt, "feedback-run");
	const presenter = new PlannotatorPresenter({
		events: { emit(_channel, value) { request = value as Request; } },
		assignmentBoundary: boundary,
		sendUserMessage(content, options) {
			assert.throws(() => boundary.assertModelAction("implement"), /paused/);
			sent.push({ content, deliverAs: options?.deliverAs });
		},
	});
	presenter.present(payload("feedback-run", "NOT_READY"));
	assert.ok(request);
	request.respond({
		status: "handled",
		result: { feedback: `Please repair this. ${"x".repeat(MAX_PLANNOTATOR_FEEDBACK_LENGTH * 2)}` },
	});
	assert.doesNotThrow(() => boundary.assertModelAction("implement"));
	assert.equal(sent.length, 1);
	assert.equal(sent[0]!.deliverAs, "followUp");
	assert.match(sent[0]!.content, /Human feedback on completed Pi Engineering deliver run 'feedback-run'/);
	assert.match(sent[0]!.content, /Feedback truncated/);
});

test("a throwing feedback delivery leaves the assignment boundary gated", () => {
	let request: Request | undefined;
	const boundary = new AssignmentBoundary();
	const attempt = boundary.beginWorkflowAttempt();
	boundary.attachWorkflow(attempt, "failed-feedback-run");
	const presenter = new PlannotatorPresenter({
		events: { emit(_channel, value) { request = value as Request; } },
		assignmentBoundary: boundary,
		sendUserMessage() { throw new Error("delivery failed"); },
	});
	presenter.present(payload("failed-feedback-run", "NOT_READY"));
	const feedbackRequest = request;
	assert.ok(feedbackRequest);
	assert.doesNotThrow(() => feedbackRequest.respond({
		status: "handled",
		result: { feedback: "Please repair this." },
	}));
	assert.throws(() => boundary.assertModelAction("implement"), /paused/);
});

test("approval, close, unavailable integration, and emitter failures never authorize work", () => {
	let request: Request | undefined;
	const boundary = new AssignmentBoundary();
	const attempt = boundary.beginWorkflowAttempt();
	boundary.attachWorkflow(attempt, "ack-run");
	let sends = 0;
	const presenter = new PlannotatorPresenter({
		events: { emit(_channel, value) { request = value as Request; } },
		assignmentBoundary: boundary,
		sendUserMessage() { sends += 1; },
	});
	presenter.present(payload("ack-run", "NOT_READY"));
	request?.respond({ status: "handled", result: { approved: true, feedback: "" } });
	assert.throws(() => boundary.assertModelAction("implement"), /paused/);
	assert.equal(sends, 0);

	const unavailable = new PlannotatorPresenter({
		events: { emit(_channel, value) { (value as Request).respond({ status: "unavailable" }); } },
		assignmentBoundary: boundary,
		sendUserMessage() { sends += 1; },
	});
	assert.equal(unavailable.present(payload("unavailable", "READY")), true);
	assert.equal(sends, 0);

	const broken = new PlannotatorPresenter({
		events: { emit() { throw new Error("listener failed"); } },
		assignmentBoundary: boundary,
		sendUserMessage() { sends += 1; },
	});
	assert.doesNotThrow(() => broken.present(payload("broken", "READY")));
	assert.equal(broken.present(payload("broken", "READY")), false);
});

test("bounds remembered run ids while retaining recent deduplication", () => {
	let emits = 0;
	const presenter = new PlannotatorPresenter({
		events: { emit() { emits += 1; } },
		assignmentBoundary: new AssignmentBoundary(),
		sendUserMessage() {},
	});
	for (let index = 0; index <= MAX_PRESENTED_RUN_IDS; index += 1) {
		assert.equal(presenter.present(payload(`run-${index}`, "READY")), true);
	}
	assert.equal(presenter.present(payload(`run-${MAX_PRESENTED_RUN_IDS}`, "READY")), false);
	assert.equal(presenter.present(payload("run-0", "READY")), true, "the oldest id is evicted");
	assert.equal(emits, MAX_PRESENTED_RUN_IDS + 2);
});
