import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

async function text(file: string): Promise<string> {
	return readFile(path.resolve(file), "utf8");
}

test("the public skill selects proportional playbooks without adding retry orchestration", async () => {
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
	assert.match(skill, /two independent reviewers/i);
	assert.match(skill, /never the whole open backlog/i);
	assert.match(skill, /Implicit assistance may inspect, organize, and recommend/i);
	assert.match(skill, /requires direct user authorization/i);
	assert.match(skill, /natural-language request[\s\S]*authorizes one bounded implementer/i);
	assert.match(skill, /Choose the action before its effort/i);
	assert.match(skill, /assign_engineering` tool always uses `standard/i);
	assert.match(skill, /Deep effort[\s\S]*never adds specialists, phases, persistence, or authority/i);
	assert.match(skill, /never infer absence from incomplete output/i);
	assert.match(skill, /Intermediate reviewer steps use validated structured envelopes/i);
	assert.match(skill, /terminal reviewer returns a human-readable READY or NOT READY/i);
	assert.doesNotMatch(skill, /fresh subagent per task|repeat until approved|five fix rounds/i);
});

test("leaf roles apply causal, evidence-scaled engineering discipline", async () => {
	const [scout, planner, worker, reviewer] = await Promise.all([
		text("agents/core/fast-scout.md"),
		text("agents/core/planner.md"),
		text("agents/core/worker.md"),
		text("agents/core/reviewer.md"),
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

	for (const prompt of [scout, planner, worker, reviewer]) {
		assert.match(prompt, /do not (?:produce an architecture tour or )?launch (?:more )?agents|Do not launch agents/i);
	}
});

test("fixed workflows require current evidence and stop after one correction pass", async () => {
	const deliver = JSON.parse(await text("chains/workbench/deliver.chain.json")) as {
		chain: Array<{ task?: string; parallel?: Array<{ task: string }> }>;
	};
	const audit = JSON.parse(await text("chains/workbench/audit.chain.json")) as {
		chain: Array<{ task?: string; parallel?: Array<{ task: string }> }>;
	};
	const deliveryTasks = deliver.chain.flatMap((step) => step.parallel?.map((task) => task.task) ?? [step.task ?? ""]);
	const auditTasks = audit.chain.flatMap((step) => step.parallel?.map((task) => task.task) ?? [step.task ?? ""]);

	assert.match(deliveryTasks[0], /Classify the work as a feature, bug, refactor, or mechanical change/i);
	assert.match(deliveryTasks[0], /pi-workbench-feature-ledger/i);
	assert.match(deliveryTasks[0], /stable task or milestone ID/i);
	assert.match(deliveryTasks[1], /witness a focused regression or contract test fail/i);
	assert.match(deliveryTasks[1], /status, Evidence, and Handoff/i);
	assert.match(deliveryTasks[2], /Spec baseline/i);
	assert.match(deliveryTasks[2], /acceptance criteria/i);
	assert.match(deliveryTasks[3], /Spec baseline/i);
	assert.match(deliveryTasks[3], /acceptance criteria/i);
	assert.match(deliveryTasks[4], /pre-fix results do not count/i);
	assert.match(deliveryTasks[4], /Do not begin another autonomous fix loop/i);
	assert.match(deliveryTasks[4], /status, Evidence, Handoff, and next ready task/i);
	assert.match(deliveryTasks[5], /first line is READY[\s\S]*otherwise NOT READY/i);
	assert.match(deliveryTasks[5], /status, Evidence, Handoff, and next ready task match reality/i);
	assert.match(auditTasks[0], /Spec baseline/i);
	assert.match(auditTasks[1], /acceptance coverage/i);
	assert.match(auditTasks[2], /named review gate/i);
	assert.match(auditTasks[2], /work-plan disposition/i);
	assert.match(auditTasks[2], /first line is READY[\s\S]*otherwise NOT READY/i);
});
