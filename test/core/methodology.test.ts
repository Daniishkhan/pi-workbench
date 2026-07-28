import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

async function text(file: string): Promise<string> {
	return readFile(path.resolve(file), "utf8");
}

test("the public skill selects proportional playbooks with only one bounded critical convergence pass", async () => {
	const skill = await text("skills/pi-engineering/SKILL.md");

	assert.match(skill, /Select the smallest action/i);
	for (const route of ["inspect", "plan", "implement", "review", "deliver", "audit"]) {
		assert.match(skill, new RegExp("`" + route + "`"));
	}
	assert.match(skill, /trace to the first bad state/i);
	assert.match(skill, /regression or contract test that fails for the intended reason/i);
	assert.match(skill, /characterization coverage/i);
	assert.match(skill, /do not manufacture a test/i);
	assert.match(skill, /after the last mutation/i);
	assert.match(skill, /one bounded pass/i);
	assert.match(skill, /artifact: pi-workbench-feature-ledger/i);
	assert.match(skill, /stable task or milestone ID/i);
	assert.match(skill, /one `ready` task or coherent milestone/i);
	assert.match(skill, /two model-independent reviewers/i);
	assert.match(skill, /never the whole open backlog/i);
	assert.match(skill, /Implicit assistance may inspect, organize, and recommend/i);
	assert.match(skill, /requires direct user authorization/i);
	assert.match(skill, /natural-language request[\s\S]*authorizes one bounded implementer/i);
	assert.match(skill, /assignment to a fresh context must be self-contained/i);
	assert.match(skill, /Objective:[\s\S]*Scope:[\s\S]*Constraints:[\s\S]*Done when:/i);
	assert.match(skill, /never pass deictic text/i);
	assert.match(skill, /Treat async completion as a handoff boundary/i);
	assert.match(skill, /failed run[\s\S]*final `NOT READY` verdict[\s\S]*never authorizes an improvised follow-up action/i);
	assert.match(skill, /Choose the action before its effort/i);
	assert.match(skill, /assign_engineering` tool always uses `standard/i);
	assert.match(skill, /Deep effort[\s\S]*never adds specialists, phases, persistence, or authority/i);
	assert.match(skill, /never infer absence from incomplete output/i);
	assert.match(skill, /Independent reviews, synthesis, and the optional terminal re-review use validated structured envelopes/i);
	assert.match(skill, /completion renderer preserves a human-readable READY or NOT READY/i);
	assert.match(skill, /at most one repair batch only for validated P0\/P1 findings/i);
	assert.match(skill, /workflow stops after that review/i);
	assert.doesNotMatch(skill, /fresh subagent per task|repeat until approved|five fix rounds/i);
});

test("leaf roles apply causal, evidence-scaled engineering discipline", async () => {
	const [scout, planner, worker, reviewer, riskReviewer] = await Promise.all([
		text("agents/core/fast-scout.md"),
		text("agents/core/planner.md"),
		text("agents/core/worker.md"),
		text("agents/core/reviewer.md"),
		text("agents/core/risk-reviewer.md"),
	]);

	assert.match(scout, /first bad state/i);
	assert.match(scout, /confirmed root cause from a leading hypothesis/i);
	assert.match(scout, /truncated[\s\S]*narrow and rerun/i);

	assert.match(planner, /global constraints/i);
	assert.match(planner, /causal seam/i);
	assert.match(planner, /behavior that must remain invariant/i);
	assert.match(planner, /Do not add synthetic tests/i);
	assert.match(planner, /pi-workbench-feature-ledger/i);
	assert.match(planner, /stable task or milestone ID/i);
	assert.match(planner, /never the remaining backlog/i);
	assert.match(planner, /prewalk the plan/i);
	assert.match(planner, /consumer or dispatcher and owning test/i);
	assert.match(planner, /Remove unnecessary files or duplicate steps/i);
	assert.match(planner, /roughly 100 lines/i);
	assert.match(planner, /TOO_BROAD/i);

	assert.match(worker, /Fix the first bad state/i);
	assert.match(worker, /regression or contract test first/i);
	assert.match(worker, /characterization coverage/i);
	assert.match(worker, /do not manufacture tests/i);
	assert.match(worker, /After the last mutation/i);
	assert.match(worker, /Never weaken an assertion/i);
	assert.match(worker, /pi-workbench-feature-ledger/i);
	assert.match(worker, /status, Evidence, and Handoff/i);
	assert.match(worker, /Do not mark work `done` without fresh verification/i);
	assert.match(worker, /prewalk the plan/i);
	assert.match(worker, /real consumers or dispatchers, and owning tests/i);
	assert.match(worker, /LINE#HASH/i);
	assert.match(worker, /per-command timeout/i);

	assert.match(reviewer, /claims, not proof/i);
	assert.match(reviewer, /addresses the causal seam/i);
	assert.match(reviewer, /after the last mutation/i);
	assert.match(reviewer, /READY[\s\S]*NOT READY/i);
	assert.match(reviewer, /Spec baseline/i);
	assert.match(reviewer, /named acceptance criteria/i);
	assert.match(reviewer, /status, Evidence, and Handoff match the repository/i);
	assert.match(reviewer, /crosses a boundary/i);
	assert.match(reviewer, /actual consumer or dispatcher/i);
	assert.match(reviewer, /Check the owning test/i);
	assert.match(reviewer, /confidence, precise location/i);
	assert.match(reviewer, /Reject unrelated pre-existing issues/i);
	assert.match(reviewer, /optional hardening/i);
	assert.match(reviewer, /literal: true/i);
	assert.match(reviewer, /reserve regular expressions for intentional patterns/i);
	assert.match(reviewer, /same final assistant message as that tool call/i);
	assert.match(reviewer, /three explicit lenses/i);
	assert.match(reviewer, /Functional review/i);
	assert.match(reviewer, /Non-functional review/i);
	assert.match(reviewer, /Security review/i);

	assert.match(riskReviewer, /non-functional and security reviewer/i);
	assert.match(riskReviewer, /applicable trust boundaries/i);
	assert.match(riskReviewer, /failure safety and recovery/i);
	assert.match(riskReviewer, /resource limits and material performance regressions/i);
	assert.match(riskReviewer, /comprehensive terminal re-review[\s\S]*pure functional or specification defects/i);
	assert.match(riskReviewer, /accessibility when user-facing behavior applies/i);
	assert.match(riskReviewer, /validationEvidence[\s\S]*Security[\s\S]*NOT_APPLICABLE[\s\S]*concrete reason/i);
	assert.match(riskReviewer, /do not launch more agents/i);

	for (const prompt of [scout, planner, worker, reviewer, riskReviewer]) {
		assert.match(prompt, /do not (?:produce an architecture tour or )?launch (?:more )?agents|Do not launch agents/i);
	}
});

test("fixed workflows require current evidence and permit only one conditional critical correction", async () => {
	const deliver = JSON.parse(await text("chains/workbench/deliver.chain.json")) as {
		chain: Array<{ task?: string; expand?: unknown; parallel?: { task: string } | Array<{ task: string }> }>;
	};
	const audit = JSON.parse(await text("chains/workbench/audit.chain.json")) as {
		chain: Array<{ task?: string; parallel?: Array<{ task: string }> }>;
	};
	const deliveryTasks = deliver.chain.flatMap((step) => (
		Array.isArray(step.parallel)
			? step.parallel.map((task) => task.task)
			: step.expand && step.parallel
				? [step.parallel.task]
				: [step.task ?? ""]
	));
	const auditTasks = audit.chain.flatMap((step) => step.parallel?.map((task) => task.task) ?? [step.task ?? ""]);

	assert.match(deliveryTasks[0], /Classify the work as a feature, bug, refactor, or mechanical change/i);
	assert.match(deliveryTasks[0], /pi-workbench-feature-ledger/i);
	assert.match(deliveryTasks[0], /stable task or milestone ID/i);
	assert.match(deliveryTasks[1], /witness a focused regression or contract test fail/i);
	assert.match(deliveryTasks[1], /status, Evidence, and Handoff/i);
	assert.match(deliveryTasks[2], /Spec baseline/i);
	assert.match(deliveryTasks[2], /acceptance criteria/i);
	assert.match(deliveryTasks[2], /REPORTED/i);
	assert.match(deliveryTasks[2], /READY requires no findings[\s\S]*NOT_READY requires one or more findings/i);
	assert.match(deliveryTasks[3], /non-functional quality and security/i);
	assert.match(deliveryTasks[3], /real trust boundaries/i);
	assert.match(deliveryTasks[4], /criticalRepairBatches/i);
	assert.match(deliveryTasks[4], /if and only if at least one surviving (?:top-level )?finding is P0 or P1/i);
	assert.match(deliveryTasks[4], /sole authoritative finding set/i);
	assert.match(deliveryTasks[5], /only repair attempt/i);
	assert.match(deliveryTasks[5], /Refuse and stop safely/i);
	assert.match(deliveryTasks[5], /every and only top-level P0\/P1 finding/i);
	assert.match(deliveryTasks[6], /one terminal re-review/i);
	assert.match(deliveryTasks[6], /overrides the risk-reviewer role's normal narrow functional scope/i);
	assert.match(deliveryTasks[6], /functional specification and correctness/i);
	assert.match(deliveryTasks[6], /non-functional reliability/i);
	assert.match(deliveryTasks[6], /security or privacy/i);
	assert.match(deliveryTasks[6], /NOT_APPLICABLE only with a concrete reason/i);
	assert.match(deliveryTasks[6], /Do not edit files, create criticalRepairBatches, launch another worker/i);
	assert.equal(deliveryTasks.length, 7);
	assert.match(auditTasks[0], /Spec baseline/i);
	assert.match(auditTasks[1], /non-functional and security risk/i);
	assert.match(auditTasks[1], /acceptance coverage/i);
	assert.match(auditTasks[2], /named review gate/i);
	assert.match(auditTasks[2], /work-plan disposition/i);
	assert.match(auditTasks[2], /first line is READY[\s\S]*otherwise NOT READY/i);
});
