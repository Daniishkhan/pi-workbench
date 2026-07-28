import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Compile } from "typebox/compile";
import createWorkflowService from "../../extensions/workflows.ts";
import {
	requireWorkflowDefinition,
	workflowDefinitionErrors,
	type WorkflowDefinition,
} from "../../extensions/core/workflow-validation.ts";

async function packagedWorkflow(name: "audit" | "deliver"): Promise<WorkflowDefinition> {
	const file = new URL(`../../chains/workbench/${name}.chain.json`, import.meta.url);
	return requireWorkflowDefinition(name, JSON.parse(await readFile(file, "utf8")), file.pathname);
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

test("the packaged workflows satisfy the shared runtime contract", async () => {
	await Promise.all([packagedWorkflow("audit"), packagedWorkflow("deliver")]);
});

test("rejects unsupported root, group, and task keys", async () => {
	const audit = await packagedWorkflow("audit");
	const root = { ...clone(audit), surprise: true };
	assert.match(workflowDefinitionErrors("audit", root).join("\n"), /unsupported key surprise/);

	const group = clone(audit) as WorkflowDefinition & { chain: Array<Record<string, unknown>> };
	group.chain[0]!.mailbox = true;
	assert.match(workflowDefinitionErrors("audit", group).join("\n"), /unsupported key mailbox/);

	const task = clone(audit) as WorkflowDefinition & { chain: Array<Record<string, unknown>> };
	(task.chain[0]!.parallel as Array<Record<string, unknown>>)[0]!.recursive = true;
	assert.match(workflowDefinitionErrors("audit", task).join("\n"), /unsupported key recursive/);
});

test("rejects changed topology and parallel writers", async () => {
	const audit = clone(await packagedWorkflow("audit")) as WorkflowDefinition & { chain: Array<Record<string, unknown>> };
	(audit.chain[0]!.parallel as Array<Record<string, unknown>>)[0]!.agent = "pi-workbench.worker";
	const errors = workflowDefinitionErrors("audit", audit).join("\n");
	assert.match(errors, /writers may not run in parallel/);
	assert.match(errors, /audit topology changed/);
});

test("rejects forward, unknown, and implicit artifact references", async () => {
	const deliver = clone(await packagedWorkflow("deliver")) as WorkflowDefinition & { chain: Array<Record<string, unknown>> };
	deliver.chain[0]!.task = "Use {outputs.future} without opening it";
	deliver.chain[1]!.as = "future";
	const errors = workflowDefinitionErrors("deliver", deliver).join("\n");
	assert.match(errors, /forward or unknown output reference future/);
	assert.match(errors, /artifact consumer must explicitly open referenced outputs/);
});

test("rejects malformed output references and artifact paths outside the run directory", async () => {
	const malformed = clone(await packagedWorkflow("deliver")) as WorkflowDefinition & { chain: Array<Record<string, unknown>> };
	malformed.chain[1]!.task = `${String(malformed.chain[1]!.task)}\nOpen and read {outputs.plan-bad}.`;
	assert.match(workflowDefinitionErrors("deliver", malformed).join("\n"), /invalid output reference plan-bad/);

	const traversal = clone(await packagedWorkflow("deliver")) as WorkflowDefinition & { chain: Array<Record<string, unknown>> };
	traversal.chain[0]!.output = "../../../../plan.md";
	assert.match(
		workflowDefinitionErrors("deliver", traversal).join("\n"),
		/output must be a normalized relative path inside run artifacts/,
	);

	const driveRelative = clone(await packagedWorkflow("deliver")) as WorkflowDefinition & { chain: Array<Record<string, unknown>> };
	driveRelative.chain[0]!.output = "C:plan.md";
	assert.match(
		workflowDefinitionErrors("deliver", driveRelative).join("\n"),
		/output must be a normalized relative path inside run artifacts/,
	);
});

test("requires structured receipts only on independent reviewer steps", async () => {
	const missing = clone(await packagedWorkflow("audit")) as WorkflowDefinition & { chain: Array<Record<string, unknown>> };
	delete (missing.chain[0]!.parallel as Array<Record<string, unknown>>)[0]!.outputSchema;
	assert.match(workflowDefinitionErrors("audit", missing).join("\n"), /independent reviewer must define outputSchema/);

	const missingDeliver = clone(await packagedWorkflow("deliver")) as WorkflowDefinition & { chain: Array<Record<string, unknown>> };
	delete (missingDeliver.chain[2]!.parallel as Array<Record<string, unknown>>)[0]!.outputSchema;
	assert.match(workflowDefinitionErrors("deliver", missingDeliver).join("\n"), /independent reviewer must define outputSchema/);
	const missingDecision = clone(await packagedWorkflow("deliver")) as WorkflowDefinition & { chain: Array<Record<string, unknown>> };
	delete missingDecision.chain[3]!.outputSchema;
	assert.match(workflowDefinitionErrors("deliver", missingDecision).join("\n"), /independent reviewer must define outputSchema/);
	const missingRereview = clone(await packagedWorkflow("deliver")) as WorkflowDefinition & { chain: Array<Record<string, unknown>> };
	delete (missingRereview.chain[5]!.parallel as Record<string, unknown>).outputSchema;
	assert.match(workflowDefinitionErrors("deliver", missingRereview).join("\n"), /independent reviewer must define outputSchema/);

	const terminal = clone(await packagedWorkflow("audit")) as WorkflowDefinition & { chain: Array<Record<string, unknown>> };
	terminal.chain.at(-1)!.outputSchema = { type: "object" };
	assert.match(workflowDefinitionErrors("audit", terminal).join("\n"), /only independent review steps may define outputSchema/);
});

test("requires the exact evidence-state contract including REPORTED", async () => {
	const deliver = clone(await packagedWorkflow("deliver")) as WorkflowDefinition & { chain: Array<Record<string, unknown>> };
	const schema = (deliver.chain[2]!.parallel as Array<Record<string, unknown>>)[0]!.outputSchema as Record<string, unknown>;
	const properties = schema.properties as Record<string, Record<string, unknown>>;
	const evidence = properties.validationEvidence;
	const items = evidence.items as Record<string, unknown>;
	const evidenceProperties = items.properties as Record<string, Record<string, unknown>>;
	evidenceProperties.status.enum = ["VERIFIED", "MISSING", "STALE", "NOT_APPLICABLE"];
	assert.match(
		workflowDefinitionErrors("deliver", deliver).join("\n"),
		/validationEvidence status enum must be VERIFIED, REPORTED, MISSING, STALE, NOT_APPLICABLE/,
	);
});

test("requires exact practical bounds on review and decision receipts", async () => {
	const base = await packagedWorkflow("deliver");
	const cases: Array<{ path: string[]; expected: RegExp }> = [
		{ path: ["properties", "summary", "maxLength"], expected: /summary must set maxLength 1200/ },
		{ path: ["properties", "findings", "maxItems"], expected: /findings must set maxItems 12/ },
		{ path: ["properties", "findings", "items", "properties", "path", "maxLength"], expected: /finding path must set maxLength 1024/ },
		{ path: ["properties", "findings", "items", "properties", "violatedContract", "maxLength"], expected: /finding violatedContract must set maxLength 800/ },
		{ path: ["properties", "findings", "items", "properties", "scenario", "maxLength"], expected: /finding scenario must set maxLength 800/ },
		{ path: ["properties", "findings", "items", "properties", "safeFix", "maxLength"], expected: /finding safeFix must set maxLength 800/ },
		{ path: ["properties", "findings", "items", "properties", "validation", "maxLength"], expected: /finding validation must set maxLength 800/ },
		{ path: ["properties", "validationEvidence", "maxItems"], expected: /validationEvidence must set maxItems 16/ },
		{ path: ["properties", "validationEvidence", "items", "properties", "check", "maxLength"], expected: /validationEvidence check must set maxLength 256/ },
		{ path: ["properties", "validationEvidence", "items", "properties", "evidence", "maxLength"], expected: /validationEvidence evidence must set maxLength 800/ },
		{ path: ["properties", "residualRisks", "maxItems"], expected: /residualRisks must set maxItems 12/ },
		{ path: ["properties", "residualRisks", "items", "maxLength"], expected: /residualRisks item must set maxLength 500/ },
		{ path: ["properties", "ledgerDisposition", "properties", "artifactPath", "maxLength"], expected: /ledgerDisposition artifactPath must set maxLength 1024/ },
		{ path: ["properties", "ledgerDisposition", "properties", "gateId", "maxLength"], expected: /ledgerDisposition gateId must set maxLength 160/ },
		{ path: ["properties", "ledgerDisposition", "properties", "evidenceSummary", "maxLength"], expected: /ledgerDisposition evidenceSummary must set maxLength 1200/ },
		{ path: ["properties", "ledgerDisposition", "properties", "requiredNextState", "maxLength"], expected: /ledgerDisposition requiredNextState must set maxLength 800/ },
	];

	for (const target of ["review", "decision"] as const) {
		for (const testCase of cases) {
			const workflow = clone(base) as WorkflowDefinition & { chain: Array<Record<string, unknown>> };
			const schema = target === "review"
				? (workflow.chain[2]!.parallel as Array<Record<string, unknown>>)[0]!.outputSchema as Record<string, unknown>
				: workflow.chain[3]!.outputSchema as Record<string, unknown>;
			let cursor = schema;
			for (const segment of testCase.path.slice(0, -1)) {
				cursor = cursor[segment] as Record<string, unknown>;
			}
			const field = testCase.path.at(-1)!;
			cursor[field] = Number(cursor[field]) + 1;
			assert.match(workflowDefinitionErrors("deliver", workflow).join("\n"), testCase.expected, `${target}: ${testCase.path.join(".")}`);
		}
	}
});

test("compiled review and decision schemas reject every oversized receipt field", async () => {
	const audit = await packagedWorkflow("audit") as WorkflowDefinition & { chain: Array<Record<string, unknown>> };
	const deliver = await packagedWorkflow("deliver") as WorkflowDefinition & { chain: Array<Record<string, unknown>> };
	const auditReviewers = audit.chain[0]!.parallel as Array<Record<string, unknown>>;
	const deliverReviewers = deliver.chain[2]!.parallel as Array<Record<string, unknown>>;
	const schemas = [
		{ label: "audit functional", schema: auditReviewers[0]!.outputSchema as Record<string, unknown>, decision: false },
		{ label: "audit risk", schema: auditReviewers[1]!.outputSchema as Record<string, unknown>, decision: false },
		{ label: "deliver functional", schema: deliverReviewers[0]!.outputSchema as Record<string, unknown>, decision: false },
		{ label: "deliver risk", schema: deliverReviewers[1]!.outputSchema as Record<string, unknown>, decision: false },
		{ label: "deliver decision", schema: deliver.chain[3]!.outputSchema as Record<string, unknown>, decision: true },
		{
			label: "deliver terminal",
			schema: (deliver.chain[5]!.parallel as Record<string, unknown>).outputSchema as Record<string, unknown>,
			decision: false,
		},
	];
	const finding = () => ({
		severity: "P2",
		confidence: 0.95,
		path: "src/example.ts",
		line: { start: 1, end: 1 },
		violatedContract: "The requested behavior must remain correct.",
		scenario: "The changed path violates the contract.",
		safeFix: "Repair the bounded causal seam.",
		validation: "Run the focused contract test.",
	});
	const evidence = () => ({ check: "focused test", status: "VERIFIED", evidence: "passed" });
	const receipt = (decision: boolean) => ({
		verdict: "NOT_READY",
		summary: "One bounded finding remains.",
		findings: [finding()],
		validationEvidence: [evidence()],
		residualRisks: ["One bounded residual risk."],
		ledgerDisposition: {
			artifactPath: "plans/work.md",
			gateId: "gate-1",
			result: "NOT_READY",
			evidenceSummary: "The gate remains blocked.",
			requiredNextState: "Repair the validated defect.",
		},
		...(decision ? { criticalRepairBatches: [] } : {}),
	});
	type Receipt = ReturnType<typeof receipt>;
	const oversizedCases: Array<{ label: string; mutate(value: Receipt): void }> = [
		{ label: "summary", mutate(value) { value.summary = "x".repeat(1_201); } },
		{ label: "findings", mutate(value) { value.findings = Array.from({ length: 13 }, finding); } },
		{ label: "finding path", mutate(value) { value.findings[0]!.path = "x".repeat(1_025); } },
		{ label: "violated contract", mutate(value) { value.findings[0]!.violatedContract = "x".repeat(801); } },
		{ label: "scenario", mutate(value) { value.findings[0]!.scenario = "x".repeat(801); } },
		{ label: "safe fix", mutate(value) { value.findings[0]!.safeFix = "x".repeat(801); } },
		{ label: "finding validation", mutate(value) { value.findings[0]!.validation = "x".repeat(801); } },
		{ label: "validation evidence", mutate(value) { value.validationEvidence = Array.from({ length: 17 }, evidence); } },
		{ label: "evidence check", mutate(value) { value.validationEvidence[0]!.check = "x".repeat(257); } },
		{ label: "evidence detail", mutate(value) { value.validationEvidence[0]!.evidence = "x".repeat(801); } },
		{ label: "residual risks", mutate(value) { value.residualRisks = Array.from({ length: 13 }, () => "risk"); } },
		{ label: "residual risk", mutate(value) { value.residualRisks[0] = "x".repeat(501); } },
		{ label: "ledger artifact path", mutate(value) { value.ledgerDisposition.artifactPath = "x".repeat(1_025); } },
		{ label: "ledger gate id", mutate(value) { value.ledgerDisposition.gateId = "x".repeat(161); } },
		{ label: "ledger evidence summary", mutate(value) { value.ledgerDisposition.evidenceSummary = "x".repeat(1_201); } },
		{ label: "ledger next state", mutate(value) { value.ledgerDisposition.requiredNextState = "x".repeat(801); } },
	];

	for (const entry of schemas) {
		const validator = Compile(entry.schema as never);
		assert.equal(validator.Check(receipt(entry.decision)), true, `${entry.label}: baseline receipt`);
		for (const testCase of oversizedCases) {
			const oversized = receipt(entry.decision);
			testCase.mutate(oversized);
			assert.equal(validator.Check(oversized), false, `${entry.label}: ${testCase.label}`);
		}
	}
});

test("requires the terminal verdict, findings, and ledger coupling contract", async () => {
	const base = await packagedWorkflow("deliver");
	for (const [label, mutate, expected] of [
		[
			"required fields",
			(schema: Record<string, unknown>) => { schema.required = ["summary", "validationEvidence", "residualRisks"]; },
			/required fields must be verdict, summary, findings, validationEvidence, residualRisks/,
		],
		[
			"verdict enum",
			(schema: Record<string, unknown>) => { delete (schema.properties as Record<string, unknown>).verdict; },
			/verdict enum must be READY, NOT_READY/,
		],
		[
			"finding branches",
			(schema: Record<string, unknown>) => { delete schema.oneOf; },
			/READY branch must couple verdict, findings, and ledger disposition/,
		],
		[
			"summary property",
			(schema: Record<string, unknown>) => { delete (schema.properties as Record<string, unknown>).summary; },
			/summary must be a string schema/,
		],
		[
			"residual risks property",
			(schema: Record<string, unknown>) => { delete (schema.properties as Record<string, unknown>).residualRisks; },
			/residualRisks must be an array schema/,
		],
		[
			"duplicate verdict branch",
			(schema: Record<string, unknown>) => {
				const branches = schema.oneOf as unknown[];
				schema.oneOf = [...branches, structuredClone(branches[0])];
			},
			/exactly one READY and one NOT_READY branch/,
		],
	] as const) {
		const workflow = clone(base) as WorkflowDefinition & { chain: Array<Record<string, unknown>> };
		const schema = (workflow.chain[2]!.parallel as Array<Record<string, unknown>>)[0]!.outputSchema as Record<string, unknown>;
		mutate(schema);
		assert.match(workflowDefinitionErrors("deliver", workflow).join("\n"), expected, label);
	}
});

test("synthesis decision fails closed and only emits one P0/P1 repair batch", async () => {
	const deliver = clone(await packagedWorkflow("deliver")) as WorkflowDefinition & { chain: Array<Record<string, unknown>> };
	const schema = deliver.chain[3]!.outputSchema as Record<string, unknown>;
	const validator = Compile(schema as never);
	const finding = (severity: "P0" | "P1" | "P2" | "P3", path = "src/example.ts") => ({
		severity,
		confidence: 0.95,
		path,
		line: { start: 1, end: 1 },
		violatedContract: "The requested behavior must remain correct.",
		scenario: "The changed path violates the contract.",
		safeFix: "Repair the bounded causal seam.",
		validation: "Run the focused contract test.",
	});
	const receipt = (findings: ReturnType<typeof finding>[], criticalRepairBatches: unknown[]) => ({
		verdict: findings.length === 0 ? "READY" : "NOT_READY",
		summary: findings.length === 0 ? "Ready." : "A finding remains.",
		findings,
		validationEvidence: [],
		residualRisks: [],
		criticalRepairBatches,
	});
	const batch = () => ({
		id: "critical-p0-p1",
	});

	assert.equal(validator.Check(receipt([], [])), true);
	assert.equal(validator.Check(receipt([finding("P2")], [])), true);
	assert.equal(validator.Check(receipt([finding("P3")], [])), true);
	assert.equal(validator.Check(receipt([finding("P1")], [])), false, "a P1 cannot silently skip repair");
	assert.equal(validator.Check(receipt([finding("P1")], [batch()])), true);
	assert.equal(validator.Check(receipt([finding("P2")], [batch()])), false, "P2 alone cannot trigger repair");
	assert.equal(validator.Check(receipt([finding("P3")], [batch()])), false, "P3 alone cannot trigger repair");
	assert.equal(
		validator.Check(receipt(
			[finding("P0", "src/critical.ts"), finding("P2", "src/minor.ts")],
			[{ ...batch(), findings: [finding("P1", "src/minor.ts")] }],
		)),
		false,
		"a relabelled or duplicated finding cannot be smuggled through the gate",
	);
	assert.equal(
		validator.Check(receipt([finding("P1")], [{ ...batch(), severity: "P1" }])),
		false,
		"the gate rejects all extra batch content",
	);

	const unguarded = clone(deliver);
	delete (unguarded.chain[3]!.outputSchema as Record<string, unknown>).allOf;
	assert.match(workflowDefinitionErrors("deliver", unguarded).join("\n"), /critical repair gating must fail closed/);
	const widened = clone(deliver);
	const widenedProperties = (widened.chain[3]!.outputSchema as Record<string, unknown>).properties as Record<string, Record<string, unknown>>;
	widenedProperties.criticalRepairBatches.maxItems = 2;
	assert.match(workflowDefinitionErrors("deliver", widened).join("\n"), /capped at one batch/);
	const smugglingSchema = clone(deliver);
	const smugglingProperties = (smugglingSchema.chain[3]!.outputSchema as Record<string, unknown>).properties as Record<string, Record<string, unknown>>;
	const batchItems = smugglingProperties.criticalRepairBatches.items as Record<string, unknown>;
	(batchItems.properties as Record<string, unknown>).findings = { type: "array" };
	assert.match(workflowDefinitionErrors("deliver", smugglingSchema).join("\n"), /closed gate-only object/);
});

test("rejects widened or rebound conditional repair fanout", async () => {
	for (const [label, mutate, expected] of [
		[
			"more repair workers",
			(workflow: WorkflowDefinition & { chain: Array<Record<string, unknown>> }) => {
				(workflow.chain[4]!.expand as Record<string, unknown>).maxItems = 2;
			},
			/maxItems 1/,
		],
		[
			"empty critical list fails",
			(workflow: WorkflowDefinition & { chain: Array<Record<string, unknown>> }) => {
				(workflow.chain[4]!.expand as Record<string, unknown>).onEmpty = "fail";
			},
			/onEmpty skip/,
		],
		[
			"repair source rebound",
			(workflow: WorkflowDefinition & { chain: Array<Record<string, unknown>> }) => {
				((workflow.chain[4]!.expand as Record<string, unknown>).from as Record<string, unknown>).path = "/findings";
			},
			/conditional fanout binding changed/,
		],
		[
			"second repair loop",
			(workflow: WorkflowDefinition & { chain: Array<Record<string, unknown>> }) => {
				workflow.chain.push(structuredClone(workflow.chain[4]!));
			},
			/deliver topology changed/,
		],
	] as const) {
		const workflow = clone(await packagedWorkflow("deliver")) as WorkflowDefinition & { chain: Array<Record<string, unknown>> };
		mutate(workflow);
		assert.match(workflowDefinitionErrors("deliver", workflow).join("\n"), expected, label);
	}
});

test("requires a reason-bearing acceptance disablement on every read-only chain task", async () => {
	const missing = clone(await packagedWorkflow("deliver")) as WorkflowDefinition & { chain: Array<Record<string, unknown>> };
	delete missing.chain[0]!.acceptance;
	assert.match(
		workflowDefinitionErrors("deliver", missing).join("\n"),
		/read-only workflow task must explicitly disable acceptance with a reason/,
	);

	for (const [acceptance, expected] of [
		[false, /explicitly disable acceptance/],
		["none", /explicitly disable acceptance/],
		[{ level: "none" }, /non-empty reason/],
		[{ level: "attested", reason: "review" }, /level must be none/],
		[{ level: "none", reason: "review", extra: true }, /unsupported key extra/],
	] as const) {
		const invalid = clone(await packagedWorkflow("audit")) as WorkflowDefinition & { chain: Array<Record<string, unknown>> };
		(invalid.chain[0]!.parallel as Array<Record<string, unknown>>)[0]!.acceptance = acceptance;
		assert.match(workflowDefinitionErrors("audit", invalid).join("\n"), expected);
	}

	const writer = clone(await packagedWorkflow("deliver")) as WorkflowDefinition & { chain: Array<Record<string, unknown>> };
	writer.chain[1]!.acceptance = { level: "none", reason: "not allowed" };
	assert.match(workflowDefinitionErrors("deliver", writer).join("\n"), /only read-only workflow tasks may disable acceptance/);
});

test("accepts JSON Schema objects but rejects non-object schemas", async () => {
	const audit = clone(await packagedWorkflow("audit")) as WorkflowDefinition & { chain: Array<Record<string, unknown>> };
	const first = (audit.chain[0]!.parallel as Array<Record<string, unknown>>)[0]!;
	first.outputSchema = [];
	assert.match(workflowDefinitionErrors("audit", audit).join("\n"), /outputSchema must be a JSON Schema object/);

	const malformed = clone(await packagedWorkflow("audit")) as WorkflowDefinition & { chain: Array<Record<string, unknown>> };
	const malformedFirst = (malformed.chain[0]!.parallel as Array<Record<string, unknown>>)[0]!;
	malformedFirst.outputSchema = { type: "string", pattern: "[" };
	assert.match(workflowDefinitionErrors("audit", malformed).join("\n"), /invalid outputSchema/);
});

test("rejects duplicate prose files for structured receipts", async () => {
	const audit = clone(await packagedWorkflow("audit")) as WorkflowDefinition & { chain: Array<Record<string, unknown>> };
	const first = (audit.chain[0]!.parallel as Array<Record<string, unknown>>)[0]!;
	first.output = "review.md";
	first.outputMode = "file-only";
	assert.match(
		workflowDefinitionErrors("audit", audit).join("\n"),
		/structured output must flow through its named value/,
	);
});

test("maps only named workflow efforts to their exact declared limits", async () => {
	for (const [effort, expected] of [
		["quick", 15 * 60_000],
		["standard", 20 * 60_000],
		["deep", 3 * 60 * 60_000],
	] as const) {
		const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
		const service = createWorkflowService({
			rpc: {
				async request(method: string, params: Record<string, unknown>) {
					rpcCalls.push({ method, params });
					return method === "spawn"
						? { version: 1, requestId: "test", success: true, data: { details: { runId: `audit-${effort}` } } }
						: { version: 1, requestId: "test", success: true };
				},
			} as never,
			writerCoordinator: {} as never,
		}, { loadWorkflow: () => packagedWorkflow("audit") });

		await service.spawn({ cwd: "/repo" } as never, "audit", "task", effort);
		assert.equal(rpcCalls.at(-1)?.method, "spawn");
		assert.equal(rpcCalls.at(-1)?.params.maxRuntimeMs, expected);
	}
});

test("runtime preflight fails before RPC readiness checks or writer acquisition", async () => {
	const rpcCalls: string[] = [];
	const acquisitions: string[] = [];
	const service = createWorkflowService({
		rpc: {
			async request(method: string) {
				rpcCalls.push(method);
				return { version: 1, requestId: "test", success: true };
			},
		} as never,
		writerCoordinator: {
			acquire(_cwd: string, owner: string) {
				acquisitions.push(owner);
				throw new Error("lease should not be reached");
			},
		} as never,
	}, {
		loadWorkflow: async () => ({
			name: "deliver",
			package: "pi-workbench",
			description: "invalid dynamic chain",
			chain: [{ agent: "pi-workbench.worker", task: "write", outputMode: "inline" }],
		}),
	});

	await assert.rejects(
		() => service.spawn({ cwd: "/repo" } as never, "deliver", "task", "quick"),
		/deliver topology changed/,
	);
	assert.deepEqual(acquisitions, []);
	assert.deepEqual(rpcCalls, []);
});

test("runtime preflight compiles schemas before RPC or writer acquisition", async () => {
	const invalid = clone(await packagedWorkflow("deliver")) as WorkflowDefinition & { chain: Array<Record<string, unknown>> };
	(invalid.chain[2]!.parallel as Array<Record<string, unknown>>)[0]!.outputSchema = { type: "string", pattern: "[" };
	const rpcCalls: string[] = [];
	const acquisitions: string[] = [];
	const service = createWorkflowService({
		rpc: {
			async request(method: string) {
				rpcCalls.push(method);
				return { version: 1, requestId: "test", success: true };
			},
		} as never,
		writerCoordinator: {
			acquire(_cwd: string, owner: string) {
				acquisitions.push(owner);
				throw new Error("lease should not be reached");
			},
		} as never,
	}, { loadWorkflow: async () => invalid });

	await assert.rejects(
		() => service.spawn({ cwd: "/repo" } as never, "deliver", "task", "standard"),
		/invalid outputSchema/,
	);
	assert.deepEqual(acquisitions, []);
	assert.deepEqual(rpcCalls, []);
});

test("runtime preflight rejects receipt contract violations before RPC or writer acquisition", async () => {
	const base = await packagedWorkflow("deliver");
	const cases: Array<{ label: string; expected: RegExp; mutate: (workflow: WorkflowDefinition & { chain: Array<Record<string, unknown>> }) => void }> = [
		{
			label: "planner structured output",
			expected: /only independent review steps may define outputSchema/,
			mutate(workflow) {
				workflow.chain[0]!.outputSchema = { type: "object" };
			},
		},
		{
			label: "missing reviewer schema",
			expected: /independent reviewer must define outputSchema/,
			mutate(workflow) {
				delete (workflow.chain[2]!.parallel as Array<Record<string, unknown>>)[0]!.outputSchema;
			},
		},
		{
			label: "missing read-only acceptance contract",
			expected: /read-only workflow task must explicitly disable acceptance with a reason/,
			mutate(workflow) {
				delete (workflow.chain[2]!.parallel as Array<Record<string, unknown>>)[0]!.acceptance;
			},
		},
		{
			label: "artifact traversal",
			expected: /output must be a normalized relative path inside run artifacts/,
			mutate(workflow) {
				workflow.chain[0]!.output = "../../../../plan.md";
			},
		},
		{
			label: "drive-relative artifact escape",
			expected: /output must be a normalized relative path inside run artifacts/,
			mutate(workflow) {
				workflow.chain[0]!.output = "C:plan.md";
			},
		},
		{
			label: "malformed output reference",
			expected: /invalid output reference plan-bad/,
			mutate(workflow) {
				workflow.chain[1]!.task = `${String(workflow.chain[1]!.task)}\nOpen and read {outputs.plan-bad}.`;
			},
		},
	];

	for (const testCase of cases) {
		const invalid = clone(base) as WorkflowDefinition & { chain: Array<Record<string, unknown>> };
		testCase.mutate(invalid);
		const rpcCalls: string[] = [];
		const acquisitions: string[] = [];
		const service = createWorkflowService({
			rpc: {
				async request(method: string) {
					rpcCalls.push(method);
					return { version: 1, requestId: "test", success: true };
				},
			} as never,
			writerCoordinator: {
				acquire(_cwd: string, owner: string) {
					acquisitions.push(owner);
					throw new Error("lease should not be reached");
				},
			} as never,
		}, { loadWorkflow: async () => invalid });

		await assert.rejects(
			() => service.spawn({ cwd: "/repo" } as never, "deliver", testCase.label, "standard"),
			testCase.expected,
		);
		assert.deepEqual(acquisitions, [], testCase.label);
		assert.deepEqual(rpcCalls, [], testCase.label);
	}
});
