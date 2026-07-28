import assert from "node:assert/strict";
import test from "node:test";
import {
	AssignmentBoundary,
	MAX_FRESH_BRIEF_LENGTH,
	requireSelfContainedWorkflowBrief,
} from "../../extensions/core/assignment-boundary.ts";
import {
	PACKAGED_AUDIT_WORKFLOW_AGENT,
	PACKAGED_DELIVER_WORKFLOW_AGENTS,
} from "../../extensions/core/packaged-workflow.ts";

test("accepts either a complete fresh brief or an artifact with a stable work id", () => {
	assert.doesNotThrow(() => requireSelfContainedWorkflowBrief([
		"Objective: prevent duplicate jobs",
		"Scope: scheduler and focused tests",
		"Constraints: preserve the public API",
		"Done when: the regression test and suite pass",
	].join("\n")));
	assert.doesNotThrow(() => requireSelfContainedWorkflowBrief([
		"Artifact: docs/work-plan.md",
		"Gate: release-42",
	].join("\n")));
	assert.doesNotThrow(() => requireSelfContainedWorkflowBrief("Artifact: plans/release.md\nTask ID: release-43"));
	assert.doesNotThrow(() => requireSelfContainedWorkflowBrief(
		"Objective: fix checkout; Scope: checkout module; Constraints: preserve API; Done when: focused tests pass",
	));
	assert.doesNotThrow(() => requireSelfContainedWorkflowBrief("Artifact: plans/release.md; Gate: release-44"));
});

test("rejects deictic or incomplete workflow tasks from the model-facing tool", () => {
	for (const task of [
		"all these above fixes",
		"Objective: fix it\nScope: current code\nDone when: tests pass",
		"Artifact: the plan above\nTask ID: current-task",
		"Objective: above\nScope: current\nConstraints: as before\nDone when: done",
		"Artifact: .\nTask ID: checkout-17",
		"Artifact: ../plans/work.md\nTask ID: checkout-17",
		"Artifact: https://example.com/work.md\nTask ID: checkout-17",
	]) {
		assert.throws(() => requireSelfContainedWorkflowBrief(task), /self-contained brief/);
	}
});

test("caps inline fresh briefs so large specifications move to durable artifacts", () => {
	const task = `Objective: plan work\nScope: module\nConstraints: preserve API\nDone when: handoff is ready\n${"x".repeat(MAX_FRESH_BRIEF_LENGTH)}`;
	assert.throws(() => requireSelfContainedWorkflowBrief(task), /limited to 8192 characters/);
});

test("workflow launch blocks model recovery work while status remains available", () => {
	const boundary = new AssignmentBoundary();
	const attempt = boundary.beginWorkflowAttempt();
	boundary.attachWorkflow(attempt, "run-1");
	assert.doesNotThrow(() => boundary.assertModelAction("status"));
	assert.throws(() => boundary.assertModelAction("implement"), /workflow 'run-1' launched/);
	assert.throws(() => boundary.assertModelAction("audit"), /direct user input/);
});

test("only direct input or an explicit non-status human action clears the gate", () => {
	const boundary = new AssignmentBoundary();
	const first = boundary.beginWorkflowAttempt();
	boundary.attachWorkflow(first, "run-1");
	boundary.observeInput("extension");
	boundary.authorizeHumanAction("status");
	assert.throws(() => boundary.assertModelAction("review"), /paused/);

	boundary.observeInput("interactive");
	assert.doesNotThrow(() => boundary.assertModelAction("review"));
	const second = boundary.beginWorkflowAttempt();
	boundary.attachWorkflow(second, "run-2");
	boundary.authorizeHumanAction("implement");
	assert.doesNotThrow(() => boundary.assertModelAction("review"));

	const third = boundary.beginWorkflowAttempt();
	boundary.attachWorkflow(third, "run-3");
	boundary.authorizeHumanFeedback();
	assert.doesNotThrow(() => boundary.assertModelAction("review"));
});

test("a tracked terminal event re-arms the gate after mid-run user input", () => {
	const boundary = new AssignmentBoundary();
	const attempt = boundary.beginWorkflowAttempt();
	boundary.attachWorkflow(attempt, "run-1");
	boundary.observeInput("rpc");
	assert.doesNotThrow(() => boundary.assertModelAction("review"));
	assert.equal(boundary.completeWorkflow("other-run"), false);
	assert.doesNotThrow(() => boundary.assertModelAction("review"));

	assert.equal(boundary.completeWorkflow("run-1"), true);
	assert.throws(() => boundary.assertModelAction("review"), /workflow 'run-1' completed/);
	boundary.observeInput("interactive");
	assert.doesNotThrow(() => boundary.assertModelAction("review"));
	assert.equal(boundary.completeWorkflow("run-1"), false, "duplicate completion cannot re-arm a cleared gate");
});

test("an attempted workflow remains gated on failure and handles completion before run attachment", () => {
	const boundary = new AssignmentBoundary();
	const failed = boundary.beginWorkflowAttempt();
	boundary.failWorkflowAttempt(failed);
	assert.throws(() => boundary.assertModelAction("review"), /workflow attempt failed/);
	boundary.observeInput("interactive");

	const raced = boundary.beginWorkflowAttempt();
	assert.equal(boundary.completeWorkflow("run-fast"), false);
	boundary.attachWorkflow(raced, "run-fast");
	assert.throws(() => boundary.assertModelAction("review"), /workflow 'run-fast' completed/);
});

test("a packaged workflow completion restores the gate after extension reconstruction", () => {
	const reconstructed = new AssignmentBoundary();
	assert.equal(reconstructed.completeWorkflow("run-restored", {
		mode: "chain",
		agent: PACKAGED_AUDIT_WORKFLOW_AGENT,
	}), true);
	for (const [index, agent] of PACKAGED_DELIVER_WORKFLOW_AGENTS.entries()) {
		assert.equal(new AssignmentBoundary().completeWorkflow(`deliver-restored-${index}`, {
			mode: "chain",
			agent,
		}), true);
	}
	assert.throws(() => reconstructed.assertModelAction("implement"), /workflow 'run-restored' completed/);

	const unrelated = new AssignmentBoundary();
	assert.equal(unrelated.completeWorkflow("run-other", { mode: "chain", agent: "chain:other.agent->other.agent" }), false);
	assert.doesNotThrow(() => unrelated.assertModelAction("implement"));
});
