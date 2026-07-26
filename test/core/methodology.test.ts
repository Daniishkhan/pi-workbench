import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

async function text(file: string): Promise<string> {
	return readFile(path.resolve(file), "utf8");
}

test("the public skill selects proportional playbooks without adding retry orchestration", async () => {
	const skill = await text("skills/pi-workbench/SKILL.md");

	assert.match(skill, /Select the smallest playbook/i);
	for (const route of ["inspect", "plan", "implement", "review", "deliver", "audit"]) {
		assert.match(skill, new RegExp("`" + route + "`"));
	}
	assert.match(skill, /trace to the first bad state/i);
	assert.match(skill, /regression or contract test that fails for the intended reason/i);
	assert.match(skill, /characterization coverage/i);
	assert.match(skill, /do not manufacture a test/i);
	assert.match(skill, /after the last mutation/i);
	assert.match(skill, /one bounded pass/i);
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

	assert.match(planner, /global constraints/i);
	assert.match(planner, /causal seam/i);
	assert.match(planner, /behavior that must remain invariant/i);
	assert.match(planner, /Do not add synthetic tests/i);

	assert.match(worker, /Fix the first bad state/i);
	assert.match(worker, /regression or contract test first/i);
	assert.match(worker, /characterization coverage/i);
	assert.match(worker, /do not manufacture tests/i);
	assert.match(worker, /After the last mutation/i);
	assert.match(worker, /Never weaken an assertion/i);

	assert.match(reviewer, /claims, not proof/i);
	assert.match(reviewer, /addresses the causal seam/i);
	assert.match(reviewer, /after the last mutation/i);
	assert.match(reviewer, /READY[\s\S]*NOT READY/i);

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

	assert.match(deliveryTasks[0], /Classify the work as a feature, bug, refactor, or mechanical change/i);
	assert.match(deliveryTasks[1], /witness a focused regression or contract test fail/i);
	assert.match(deliveryTasks[4], /pre-fix results do not count/i);
	assert.match(deliveryTasks[4], /Do not begin another autonomous fix loop/i);
	assert.match(deliveryTasks[5], /Missing required post-fix evidence is NOT READY/i);
	assert.match(audit.chain.at(-1)?.task ?? "", /return READY or NOT READY/i);
});
