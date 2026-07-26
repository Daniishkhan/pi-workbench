import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
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

	const terminal = clone(await packagedWorkflow("audit")) as WorkflowDefinition & { chain: Array<Record<string, unknown>> };
	terminal.chain.at(-1)!.outputSchema = { type: "object" };
	assert.match(workflowDefinitionErrors("audit", terminal).join("\n"), /only independent review steps may define outputSchema/);
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
	const reviewGroup = invalid.chain[2]!.parallel as Array<Record<string, unknown>>;
	reviewGroup[0]!.outputSchema = { type: "string", pattern: "[" };
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
			label: "terminal structured output",
			expected: /only independent review steps may define outputSchema/,
			mutate(workflow) {
				workflow.chain.at(-1)!.outputSchema = { type: "object" };
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
