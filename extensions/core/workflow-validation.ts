import path from "node:path";
import { Compile } from "typebox/compile";
import { ROLE_POLICIES } from "./role-policy.ts";
import type { WorkflowAction } from "./routing.ts";

export interface WorkflowTask extends Record<string, unknown> {
	agent: string;
	task: string;
	phase?: string;
	label?: string;
	as?: string;
	output?: string;
	outputMode?: "inline" | "file-only";
	outputSchema?: Record<string, unknown>;
	acceptance?: {
		level: "none";
		reason: string;
	};
	progress?: boolean;
}

export interface WorkflowParallelStep extends Record<string, unknown> {
	phase?: string;
	label?: string;
	parallel: WorkflowTask[];
	concurrency?: number;
	failFast?: boolean;
}

export interface WorkflowDynamicStep extends Record<string, unknown> {
	phase?: string;
	label?: string;
	expand: {
		from: { output: string; path: string };
		item?: string;
		key?: string;
		maxItems: number;
		onEmpty: "skip" | "fail";
	};
	parallel: WorkflowTask;
	collect: {
		as: string;
		outputSchema?: Record<string, unknown>;
	};
	concurrency?: number;
	failFast?: boolean;
}

export type WorkflowStep = WorkflowTask | WorkflowParallelStep | WorkflowDynamicStep;

export interface WorkflowDefinition {
	name: WorkflowAction;
	package: "pi-workbench";
	description: string;
	chain: WorkflowStep[];
}

const ROOT_KEYS = new Set(["name", "package", "description", "chain"]);
const TASK_KEYS = new Set([
	"agent",
	"task",
	"phase",
	"label",
	"as",
	"output",
	"outputMode",
	"outputSchema",
	"acceptance",
	"progress",
]);
const GROUP_KEYS = new Set(["phase", "label", "parallel", "concurrency", "failFast"]);
const DYNAMIC_KEYS = new Set(["phase", "label", "expand", "parallel", "collect", "concurrency", "failFast"]);
const EXPAND_KEYS = new Set(["from", "item", "key", "maxItems", "onEmpty"]);
const EXPAND_FROM_KEYS = new Set(["output", "path"]);
const COLLECT_KEYS = new Set(["as"]);
const OUTPUT_REFERENCE = /\{outputs\.([^}]*)\}/g;
const OUTPUT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ITEM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REVIEW_EVIDENCE_STATES = ["VERIFIED", "REPORTED", "MISSING", "STALE", "NOT_APPLICABLE"];
const REVIEW_REQUIRED_FIELDS = ["verdict", "summary", "findings", "validationEvidence", "residualRisks"];
const DECISION_REQUIRED_FIELDS = [...REVIEW_REQUIRED_FIELDS, "criticalRepairBatches"];
const REVIEW_RECEIPT_BOUNDS = {
	summary: 1_200,
	findings: 12,
	findingPath: 1_024,
	findingText: 800,
	validationEvidence: 16,
	evidenceCheck: 256,
	evidenceText: 800,
	residualRisks: 12,
	residualRisk: 500,
	ledgerArtifactPath: 1_024,
	ledgerGateId: 160,
	ledgerEvidenceSummary: 1_200,
	ledgerRequiredNextState: 800,
} as const;
type StructuredOutputKind = "none" | "review" | "decision";

const EXPECTED_TOPOLOGY: Readonly<Record<WorkflowAction, readonly (string | readonly string[])[]>> = {
	audit: [
		["pi-workbench.reviewer", "pi-workbench.risk-reviewer"],
		"pi-workbench.reviewer",
	],
	deliver: [
		"pi-workbench.planner",
		"pi-workbench.worker",
		["pi-workbench.reviewer", "pi-workbench.risk-reviewer"],
		"pi-workbench.reviewer",
		"expand:pi-workbench.worker",
		"expand:pi-workbench.risk-reviewer",
	],
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inspectKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, prefix: string, errors: string[]): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) errors.push(`${prefix}: unsupported key ${key}`);
	}
}

function inspectOptionalString(value: unknown, field: string, prefix: string, errors: string[]): void {
	if (value !== undefined && typeof value !== "string") errors.push(`${prefix}: ${field} must be a string`);
}

function inspectAcceptance(value: unknown, required: boolean, prefix: string, errors: string[]): void {
	if (!required) {
		if (value !== undefined) errors.push(`${prefix}: only read-only workflow tasks may disable acceptance`);
		return;
	}
	if (!isRecord(value)) {
		errors.push(`${prefix}: read-only workflow task must explicitly disable acceptance with a reason`);
		return;
	}
	for (const key of Object.keys(value)) {
		if (key !== "level" && key !== "reason") errors.push(`${prefix}: acceptance has unsupported key ${key}`);
	}
	if (value.level !== "none") errors.push(`${prefix}: read-only workflow acceptance level must be none`);
	if (typeof value.reason !== "string" || !value.reason.trim()) {
		errors.push(`${prefix}: read-only workflow acceptance must include a non-empty reason`);
	}
}

function sameStringSet(value: unknown, expected: readonly string[]): boolean {
	return Array.isArray(value)
		&& value.every((entry) => typeof entry === "string")
		&& value.length === expected.length
		&& expected.every((entry) => value.includes(entry));
}

function inspectExactBound(
	schema: unknown,
	keyword: "maxItems" | "maxLength",
	expected: number,
	field: string,
	prefix: string,
	errors: string[],
): void {
	if (!isRecord(schema) || schema[keyword] !== expected) {
		errors.push(`${prefix}: ${field} must set ${keyword} ${expected}`);
	}
}

function inspectReviewReceiptSchema(
	value: Record<string, unknown>,
	prefix: string,
	errors: string[],
	decision: boolean,
): void {
	if (value.type !== "object" || value.additionalProperties !== false) {
		errors.push(`${prefix}: review receipt root must be a closed object schema`);
	}
	const requiredFields = decision ? DECISION_REQUIRED_FIELDS : REVIEW_REQUIRED_FIELDS;
	if (!sameStringSet(value.required, requiredFields)) {
		errors.push(`${prefix}: review receipt required fields must be ${requiredFields.join(", ")}`);
	}
	const properties = value.properties;
	const verdict = isRecord(properties) ? properties.verdict : undefined;
	const verdicts = isRecord(verdict) ? verdict.enum : undefined;
	if (!sameStringSet(verdicts, ["READY", "NOT_READY"])) {
		errors.push(`${prefix}: verdict enum must be READY, NOT_READY`);
	}
	const findings = isRecord(properties) ? properties.findings : undefined;
	if (!isRecord(findings) || findings.type !== "array") {
		errors.push(`${prefix}: findings must be an array schema`);
	}
	const findingItems = isRecord(findings) ? findings.items : undefined;
	const findingProperties = isRecord(findingItems) ? findingItems.properties : undefined;
	const findingSeverity = isRecord(findingProperties) ? findingProperties.severity : undefined;
	if (!isRecord(findingSeverity) || !sameStringSet(findingSeverity.enum, ["P0", "P1", "P2", "P3"])) {
		errors.push(`${prefix}: finding severity enum must be P0, P1, P2, P3`);
	}
	for (const [field, expectedType] of [
		["summary", "string"],
		["validationEvidence", "array"],
		["residualRisks", "array"],
		["ledgerDisposition", "object"],
	] as const) {
		const schema = isRecord(properties) ? properties[field] : undefined;
		if (!isRecord(schema) || schema.type !== expectedType) {
			const article = expectedType === "string" ? "a" : "an";
			errors.push(`${prefix}: ${field} must be ${article} ${expectedType} schema`);
		}
	}
	const summary = isRecord(properties) ? properties.summary : undefined;
	inspectExactBound(summary, "maxLength", REVIEW_RECEIPT_BOUNDS.summary, "summary", prefix, errors);
	inspectExactBound(findings, "maxItems", REVIEW_RECEIPT_BOUNDS.findings, "findings", prefix, errors);
	for (const [field, maximum] of [
		["path", REVIEW_RECEIPT_BOUNDS.findingPath],
		["violatedContract", REVIEW_RECEIPT_BOUNDS.findingText],
		["scenario", REVIEW_RECEIPT_BOUNDS.findingText],
		["safeFix", REVIEW_RECEIPT_BOUNDS.findingText],
		["validation", REVIEW_RECEIPT_BOUNDS.findingText],
	] as const) {
		const schema = isRecord(findingProperties) ? findingProperties[field] : undefined;
		inspectExactBound(schema, "maxLength", maximum, `finding ${field}`, prefix, errors);
	}
	const validationEvidence = isRecord(properties) ? properties.validationEvidence : undefined;
	const items = isRecord(validationEvidence) ? validationEvidence.items : undefined;
	const evidenceProperties = isRecord(items) ? items.properties : undefined;
	inspectExactBound(
		validationEvidence,
		"maxItems",
		REVIEW_RECEIPT_BOUNDS.validationEvidence,
		"validationEvidence",
		prefix,
		errors,
	);
	inspectExactBound(
		isRecord(evidenceProperties) ? evidenceProperties.check : undefined,
		"maxLength",
		REVIEW_RECEIPT_BOUNDS.evidenceCheck,
		"validationEvidence check",
		prefix,
		errors,
	);
	inspectExactBound(
		isRecord(evidenceProperties) ? evidenceProperties.evidence : undefined,
		"maxLength",
		REVIEW_RECEIPT_BOUNDS.evidenceText,
		"validationEvidence evidence",
		prefix,
		errors,
	);
	const status = isRecord(evidenceProperties) ? evidenceProperties.status : undefined;
	const states = isRecord(status) ? status.enum : undefined;
	if (JSON.stringify(states) !== JSON.stringify(REVIEW_EVIDENCE_STATES)) {
		errors.push(`${prefix}: validationEvidence status enum must be ${REVIEW_EVIDENCE_STATES.join(", ")}`);
	}
	const residualRisks = isRecord(properties) ? properties.residualRisks : undefined;
	inspectExactBound(residualRisks, "maxItems", REVIEW_RECEIPT_BOUNDS.residualRisks, "residualRisks", prefix, errors);
	inspectExactBound(
		isRecord(residualRisks) ? residualRisks.items : undefined,
		"maxLength",
		REVIEW_RECEIPT_BOUNDS.residualRisk,
		"residualRisks item",
		prefix,
		errors,
	);
	const ledgerDisposition = isRecord(properties) ? properties.ledgerDisposition : undefined;
	const ledgerProperties = isRecord(ledgerDisposition) ? ledgerDisposition.properties : undefined;
	for (const [field, maximum] of [
		["artifactPath", REVIEW_RECEIPT_BOUNDS.ledgerArtifactPath],
		["gateId", REVIEW_RECEIPT_BOUNDS.ledgerGateId],
		["evidenceSummary", REVIEW_RECEIPT_BOUNDS.ledgerEvidenceSummary],
		["requiredNextState", REVIEW_RECEIPT_BOUNDS.ledgerRequiredNextState],
	] as const) {
		const schema = isRecord(ledgerProperties) ? ledgerProperties[field] : undefined;
		inspectExactBound(schema, "maxLength", maximum, `ledgerDisposition ${field}`, prefix, errors);
	}

	const branches = Array.isArray(value.oneOf) ? value.oneOf.filter(isRecord) : [];
	const branchVerdicts = branches.flatMap((branch) => {
		const branchProperties = branch.properties;
		const branchVerdict = isRecord(branchProperties) ? branchProperties.verdict : undefined;
		return isRecord(branchVerdict) && typeof branchVerdict.const === "string" ? [branchVerdict.const] : [];
	});
	if (!sameStringSet(branchVerdicts, ["READY", "NOT_READY"])) {
		errors.push(`${prefix}: oneOf must contain exactly one READY and one NOT_READY branch`);
	}
	for (const expected of ["READY", "NOT_READY"] as const) {
		const branch = branches.find((candidate) => {
			const branchProperties = candidate.properties;
			const branchVerdict = isRecord(branchProperties) ? branchProperties.verdict : undefined;
			return isRecord(branchVerdict) && branchVerdict.const === expected;
		});
		const branchProperties = branch?.properties;
		const branchFindings = isRecord(branchProperties) ? branchProperties.findings : undefined;
		const ledger = isRecord(branchProperties) ? branchProperties.ledgerDisposition : undefined;
		const ledgerProperties = isRecord(ledger) ? ledger.properties : undefined;
		const ledgerResult = isRecord(ledgerProperties) ? ledgerProperties.result : undefined;
		const findingConstraint = expected === "READY"
			? isRecord(branchFindings) && branchFindings.maxItems === 0
			: isRecord(branchFindings) && branchFindings.minItems === 1;
		if (!branch || !findingConstraint || !isRecord(ledgerResult) || ledgerResult.const !== expected) {
			errors.push(`${prefix}: ${expected} branch must couple verdict, findings, and ledger disposition`);
		}
		if (decision && expected === "READY") {
			const criticalBatches = isRecord(branchProperties) ? branchProperties.criticalRepairBatches : undefined;
			if (!isRecord(criticalBatches) || criticalBatches.maxItems !== 0) {
				errors.push(`${prefix}: READY decision must forbid critical repair batches`);
			}
		}
	}

	const criticalBatches = isRecord(properties) ? properties.criticalRepairBatches : undefined;
	if (!decision) {
		if (criticalBatches !== undefined) errors.push(`${prefix}: only the synthesis decision may define criticalRepairBatches`);
		return;
	}
	if (!isRecord(criticalBatches) || criticalBatches.type !== "array" || criticalBatches.maxItems !== 1) {
		errors.push(`${prefix}: criticalRepairBatches must be an array capped at one batch`);
		return;
	}
	const batchItems = criticalBatches.items;
	const batchProperties = isRecord(batchItems) ? batchItems.properties : undefined;
	const batchId = isRecord(batchProperties) ? batchProperties.id : undefined;
	if (
		!isRecord(batchItems)
		|| batchItems.type !== "object"
		|| batchItems.additionalProperties !== false
		|| !sameStringSet(batchItems.required, ["id"])
		|| !isRecord(batchProperties)
		|| !sameStringSet(Object.keys(batchProperties), ["id"])
		|| !isRecord(batchId)
		|| batchId.const !== "critical-p0-p1"
	) {
		errors.push(`${prefix}: critical repair batch must be a closed gate-only object containing only id critical-p0-p1`);
	}

	const conditional = Array.isArray(value.allOf) && value.allOf.length === 1 && isRecord(value.allOf[0])
		? value.allOf[0]
		: undefined;
	const ifSchema = conditional?.if;
	const ifProperties = isRecord(ifSchema) ? ifSchema.properties : undefined;
	const ifFindings = isRecord(ifProperties) ? ifProperties.findings : undefined;
	const contains = isRecord(ifFindings) ? ifFindings.contains : undefined;
	const containsProperties = isRecord(contains) ? contains.properties : undefined;
	const containsSeverity = isRecord(containsProperties) ? containsProperties.severity : undefined;
	const thenSchema = conditional?.then;
	const thenProperties = isRecord(thenSchema) ? thenSchema.properties : undefined;
	const thenBatches = isRecord(thenProperties) ? thenProperties.criticalRepairBatches : undefined;
	const elseSchema = conditional?.else;
	const elseProperties = isRecord(elseSchema) ? elseSchema.properties : undefined;
	const elseBatches = isRecord(elseProperties) ? elseProperties.criticalRepairBatches : undefined;
	if (
		!isRecord(containsSeverity)
		|| !sameStringSet(containsSeverity.enum, ["P0", "P1"])
		|| !isRecord(thenBatches)
		|| thenBatches.minItems !== 1
		|| thenBatches.maxItems !== 1
		|| !isRecord(elseBatches)
		|| elseBatches.maxItems !== 0
	) {
		errors.push(`${prefix}: critical repair gating must fail closed on P0/P1 findings`);
	}
}

function normalizedArtifactPath(value: string): string | undefined {
	if (
		value.includes("\\") ||
		path.posix.isAbsolute(value) ||
		path.win32.isAbsolute(value) ||
		path.win32.parse(value).root.length > 0
	) {
		return undefined;
	}
	const normalized = path.posix.normalize(value);
	if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized !== value) {
		return undefined;
	}
	return normalized;
}

function inspectTask(
	taskValue: unknown,
	prefix: string,
	available: ReadonlySet<string>,
	produced: Set<string>,
	outputPaths: Set<string>,
	structuredOutputKind: StructuredOutputKind,
	errors: string[],
): string | undefined {
	if (!isRecord(taskValue)) {
		errors.push(`${prefix}: task must be an object`);
		return undefined;
	}
	inspectKeys(taskValue, TASK_KEYS, prefix, errors);

	const agent = taskValue.agent;
	if (typeof agent !== "string" || !Object.hasOwn(ROLE_POLICIES, agent)) {
		errors.push(`${prefix}: unknown agent ${String(agent)}`);
	} else if (!ROLE_POLICIES[agent]?.surfaces.includes("workflow")) {
		errors.push(`${prefix}: agent ${agent} is not approved for workflows`);
	}
	inspectAcceptance(
		taskValue.acceptance,
		typeof agent === "string" && ROLE_POLICIES[agent]?.capability === "read-only",
		prefix,
		errors,
	);

	if (typeof taskValue.task !== "string" || !taskValue.task.trim()) {
		errors.push(`${prefix}: task must be non-empty`);
	} else {
		const references = [...taskValue.task.matchAll(OUTPUT_REFERENCE)].map((match) => match[1]!);
		for (const reference of references) {
			if (!OUTPUT_NAME.test(reference)) errors.push(`${prefix}: invalid output reference ${reference || "<empty>"}`);
			else if (!available.has(reference)) errors.push(`${prefix}: forward or unknown output reference ${reference}`);
		}
		if (references.length > 0 && !taskValue.task.includes("Open and read")) {
			errors.push(`${prefix}: artifact consumer must explicitly open referenced outputs`);
		}
	}

	inspectOptionalString(taskValue.phase, "phase", prefix, errors);
	inspectOptionalString(taskValue.label, "label", prefix, errors);
	if (taskValue.progress !== undefined && typeof taskValue.progress !== "boolean") {
		errors.push(`${prefix}: progress must be a boolean`);
	}

	if (taskValue.as !== undefined) {
		if (typeof taskValue.as !== "string" || !OUTPUT_NAME.test(taskValue.as)) {
			errors.push(`${prefix}: invalid as name ${String(taskValue.as)}`);
		} else if (available.has(taskValue.as) || produced.has(taskValue.as)) {
			errors.push(`${prefix}: duplicate as name ${taskValue.as}`);
		} else {
			produced.add(taskValue.as);
		}
	}

	if (taskValue.outputMode !== undefined && taskValue.outputMode !== "inline" && taskValue.outputMode !== "file-only") {
		errors.push(`${prefix}: outputMode must be inline or file-only`);
	}
	if (taskValue.outputMode === "file-only" && typeof taskValue.output !== "string") {
		errors.push(`${prefix}: file-only requires output`);
	}
	if (taskValue.output !== undefined) {
		if (typeof taskValue.output !== "string" || !taskValue.output) {
			errors.push(`${prefix}: output must be a normalized relative path inside run artifacts`);
		} else {
			const normalized = normalizedArtifactPath(taskValue.output);
			if (normalized === undefined) {
				errors.push(`${prefix}: output must be a normalized relative path inside run artifacts`);
			} else if (outputPaths.has(normalized)) {
				errors.push(`${prefix}: duplicate output path ${taskValue.output}`);
			} else {
				outputPaths.add(normalized);
			}
		}
	}
	if (structuredOutputKind !== "none" && taskValue.outputSchema === undefined) {
		errors.push(`${prefix}: independent reviewer must define outputSchema`);
	}
	if (structuredOutputKind === "none" && taskValue.outputSchema !== undefined) {
		errors.push(`${prefix}: only independent review steps may define outputSchema`);
	}

	if (taskValue.outputSchema !== undefined) {
		if (!isRecord(taskValue.outputSchema)) {
			errors.push(`${prefix}: outputSchema must be a JSON Schema object`);
		} else {
			try {
				Compile(taskValue.outputSchema as never);
			} catch (error) {
				errors.push(`${prefix}: invalid outputSchema: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (structuredOutputKind !== "none") {
				inspectReviewReceiptSchema(taskValue.outputSchema, prefix, errors, structuredOutputKind === "decision");
			}
		}
		if (taskValue.output !== undefined || taskValue.outputMode === "file-only") {
			errors.push(`${prefix}: structured output must flow through its named value, not a duplicate file-only receipt`);
		}
	}

	return typeof agent === "string" ? agent : undefined;
}

function inspectDynamicStep(
	stepValue: Record<string, unknown>,
	prefix: string,
	available: ReadonlySet<string>,
	produced: Set<string>,
	outputPaths: Set<string>,
	structuredOutputKind: StructuredOutputKind,
	errors: string[],
): string | undefined {
	inspectKeys(stepValue, DYNAMIC_KEYS, prefix, errors);
	inspectOptionalString(stepValue.phase, "phase", prefix, errors);
	inspectOptionalString(stepValue.label, "label", prefix, errors);
	if (stepValue.concurrency !== undefined && (!Number.isInteger(stepValue.concurrency) || Number(stepValue.concurrency) < 1)) {
		errors.push(`${prefix}: concurrency must be a positive integer`);
	}
	if (stepValue.failFast !== undefined && typeof stepValue.failFast !== "boolean") {
		errors.push(`${prefix}: failFast must be a boolean`);
	}

	const expand = stepValue.expand;
	if (!isRecord(expand)) {
		errors.push(`${prefix}: expand must be an object`);
	} else {
		inspectKeys(expand, EXPAND_KEYS, `${prefix} expand`, errors);
		const from = expand.from;
		if (!isRecord(from)) {
			errors.push(`${prefix}: expand.from must be an object`);
		} else {
			inspectKeys(from, EXPAND_FROM_KEYS, `${prefix} expand.from`, errors);
			if (typeof from.output !== "string" || !OUTPUT_NAME.test(from.output)) {
				errors.push(`${prefix}: expand.from.output must be a safe output name`);
			} else if (!available.has(from.output)) {
				errors.push(`${prefix}: expand references forward or unknown output ${from.output}`);
			}
			if (typeof from.path !== "string" || (from.path !== "" && !from.path.startsWith("/"))) {
				errors.push(`${prefix}: expand.from.path must be a JSON Pointer`);
			}
		}
		if (expand.item !== undefined && (typeof expand.item !== "string" || !ITEM_NAME.test(expand.item))) {
			errors.push(`${prefix}: expand.item must be a safe item name`);
		}
		if (expand.key !== undefined && (typeof expand.key !== "string" || (expand.key !== "" && !expand.key.startsWith("/")))) {
			errors.push(`${prefix}: expand.key must be a JSON Pointer`);
		}
		if (!Number.isInteger(expand.maxItems) || Number(expand.maxItems) < 0) {
			errors.push(`${prefix}: expand.maxItems must be an integer at least zero`);
		}
		if (expand.onEmpty !== "skip" && expand.onEmpty !== "fail") {
			errors.push(`${prefix}: expand.onEmpty must be skip or fail`);
		}
	}

	let agent: string | undefined;
	if (!isRecord(stepValue.parallel)) {
		errors.push(`${prefix}: dynamic parallel must be one task template object`);
	} else {
		agent = inspectTask(
			stepValue.parallel,
			`${prefix} template`,
			available,
			new Set<string>(),
			outputPaths,
			structuredOutputKind,
			errors,
		);
		if (stepValue.parallel.as !== undefined) {
			errors.push(`${prefix}: dynamic task templates must publish through collect.as`);
		}
	}

	const collect = stepValue.collect;
	if (!isRecord(collect)) {
		errors.push(`${prefix}: collect must be an object`);
	} else {
		inspectKeys(collect, COLLECT_KEYS, `${prefix} collect`, errors);
		if (typeof collect.as !== "string" || !OUTPUT_NAME.test(collect.as)) {
			errors.push(`${prefix}: collect.as must be a safe output name`);
		} else if (available.has(collect.as) || produced.has(collect.as)) {
			errors.push(`${prefix}: duplicate collect.as name ${collect.as}`);
		} else {
			produced.add(collect.as);
		}
	}
	return agent;
}

function inspectBoundedDynamicContract(
	stepValue: unknown,
	prefix: string,
	expected: {
		agent: string;
		source: string;
		path: string;
		item: string;
		key?: string;
		collect: string;
		output?: string;
		outputMode: "inline" | "file-only";
	},
	errors: string[],
): void {
	if (!isRecord(stepValue)) return;
	const expand = isRecord(stepValue.expand) ? stepValue.expand : undefined;
	const from = isRecord(expand?.from) ? expand.from : undefined;
	const template = isRecord(stepValue.parallel) ? stepValue.parallel : undefined;
	const collect = isRecord(stepValue.collect) ? stepValue.collect : undefined;
	if (
		!expand
		|| expand.maxItems !== 1
		|| expand.onEmpty !== "skip"
		|| stepValue.concurrency !== 1
		|| stepValue.failFast !== true
	) {
		errors.push(`${prefix}: conditional fanout must be pinned to maxItems 1, onEmpty skip, concurrency 1, and failFast true`);
	}
	if (
		!from
		|| from.output !== expected.source
		|| from.path !== expected.path
		|| expand?.item !== expected.item
		|| (expected.key === undefined ? expand?.key !== undefined : expand?.key !== expected.key)
		|| template?.agent !== expected.agent
		|| collect?.as !== expected.collect
		|| template?.output !== expected.output
		|| template?.outputMode !== expected.outputMode
	) {
		errors.push(`${prefix}: conditional fanout binding changed`);
	}
}

/**
 * Return every violation of Pi Engineering's closed, bounded workflow contract.
 * This is shared by package validation and the runtime loader so an invalid
 * chain cannot make it as far as RPC readiness checks or writer acquisition.
 */
export function workflowDefinitionErrors(
	expectedName: WorkflowAction,
	value: unknown,
	label = `Engineering ${expectedName} workflow`,
): string[] {
	const errors: string[] = [];
	if (!isRecord(value)) return [`${label}: workflow root must be an object`];
	inspectKeys(value, ROOT_KEYS, label, errors);
	if (value.name !== expectedName) errors.push(`${label}: name must be ${expectedName}`);
	if (value.package !== "pi-workbench") errors.push(`${label}: package must be pi-workbench`);
	if (typeof value.description !== "string" || !value.description.trim()) {
		errors.push(`${label}: description must be non-empty`);
	}
	if (!Array.isArray(value.chain) || value.chain.length === 0) {
		errors.push(`${label}: chain must be a non-empty array`);
		return errors;
	}

	const available = new Set<string>();
	const outputPaths = new Set<string>();
	const topology: Array<string | string[]> = [];
	for (let index = 0; index < value.chain.length; index += 1) {
		const stepValue: unknown = value.chain[index];
		const prefix = `${label} step ${index + 1}`;
		const produced = new Set<string>();
		if (isRecord(stepValue) && (Object.hasOwn(stepValue, "expand") || Object.hasOwn(stepValue, "collect"))) {
			const structuredOutputKind: StructuredOutputKind = expectedName === "deliver" && index === 5 ? "review" : "none";
			const agent = inspectDynamicStep(
				stepValue,
				prefix,
				available,
				produced,
				outputPaths,
				structuredOutputKind,
				errors,
			);
			topology.push(`expand:${agent ?? "<invalid>"}`);
		} else if (isRecord(stepValue) && Object.hasOwn(stepValue, "parallel")) {
			inspectKeys(stepValue, GROUP_KEYS, prefix, errors);
			inspectOptionalString(stepValue.phase, "phase", prefix, errors);
			inspectOptionalString(stepValue.label, "label", prefix, errors);
			if (!Array.isArray(stepValue.parallel)) {
				errors.push(`${prefix}: parallel must be an array`);
				topology.push([]);
				continue;
			}
			if (stepValue.parallel.length !== 2 || stepValue.concurrency !== 2) {
				errors.push(`${prefix}: parallel review must contain exactly two concurrent tasks`);
			}
			if (stepValue.failFast !== undefined && typeof stepValue.failFast !== "boolean") {
				errors.push(`${prefix}: failFast must be a boolean`);
			}
			if (stepValue.failFast !== false) {
				errors.push(`${prefix}: independent parallel review must set failFast false`);
			}
			const agents: string[] = [];
			const structuredOutputKind: StructuredOutputKind = (
				(expectedName === "audit" && index === 0)
				|| (expectedName === "deliver" && index === 2)
			) ? "review" : "none";
			for (let taskIndex = 0; taskIndex < stepValue.parallel.length; taskIndex += 1) {
				const task = stepValue.parallel[taskIndex];
				const agent = inspectTask(
					task,
					`${prefix} task ${taskIndex + 1}`,
					available,
					produced,
					outputPaths,
					structuredOutputKind,
					errors,
				);
				if (agent) agents.push(agent);
			}
			if (agents.some((agent) => ROLE_POLICIES[agent]?.capability === "writer")) {
				errors.push(`${prefix}: writers may not run in parallel`);
			}
			topology.push(agents);
		} else {
			const structuredOutputKind: StructuredOutputKind = expectedName === "deliver" && index === 3
				? "decision"
				: "none";
			const agent = inspectTask(
				stepValue,
				prefix,
				available,
				produced,
				outputPaths,
				structuredOutputKind,
				errors,
			);
			topology.push(agent ?? "<invalid>");
		}
		for (const output of produced) available.add(output);
	}

	const finalStep = value.chain.at(-1);
	const finalOutputMode = isRecord(finalStep) && isRecord(finalStep.parallel)
		? finalStep.parallel.outputMode
		: isRecord(finalStep) ? finalStep.outputMode : undefined;
	if (finalOutputMode !== "inline") {
		errors.push(`${label}: final step must return inline`);
	}
	if (expectedName === "deliver") {
		const decision = value.chain[3];
		if (!isRecord(decision) || decision.as !== "decision" || decision.outputMode !== "inline") {
			errors.push(`${label}: synthesis decision must publish decision inline`);
		}
		inspectBoundedDynamicContract(value.chain[4], `${label} step 5`, {
			agent: "pi-workbench.worker",
			source: "decision",
			path: "/criticalRepairBatches",
			item: "repairBatch",
			key: "/id",
			collect: "repairResults",
			output: "critical-repair.md",
			outputMode: "file-only",
		}, errors);
		inspectBoundedDynamicContract(value.chain[5], `${label} step 6`, {
			agent: "pi-workbench.risk-reviewer",
			source: "repairResults",
			path: "",
			item: "repairResult",
			key: "/key",
			collect: "finalReviews",
			outputMode: "inline",
		}, errors);
	}
	if (JSON.stringify(topology) !== JSON.stringify(EXPECTED_TOPOLOGY[expectedName])) {
		errors.push(`${label}: ${expectedName} topology changed`);
	}
	const serialized = JSON.stringify(value);
	if (serialized.includes("SHIPYARD") || serialized.includes("team_")) {
		errors.push(`${label}: legacy orchestration marker remains`);
	}
	return errors;
}

export function requireWorkflowDefinition(
	expectedName: WorkflowAction,
	value: unknown,
	label = `Engineering ${expectedName} workflow`,
): WorkflowDefinition {
	const errors = workflowDefinitionErrors(expectedName, value, label);
	if (errors.length > 0) throw new Error(`Invalid Pi Engineering workflow:\n- ${errors.join("\n- ")}`);
	return value as WorkflowDefinition;
}
