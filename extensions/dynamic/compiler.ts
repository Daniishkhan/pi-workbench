import { parse } from "acorn";
import { normalizeManifest, validateWorkflowSourceSize, workflowSourceHash } from "./manifest.ts";
import { assertSchemaSafe } from "./schema.ts";
import type {
	CompiledWorkflow,
	ForEachNode,
	ParallelNode,
	RepeatNode,
	RunNode,
	SetNode,
	WhenNode,
	WorkflowCondition,
	WorkflowNode,
	WorkflowReference,
	WorkflowValue,
} from "./ir.ts";
import type { WorkflowAgentTask, WorkflowSize } from "./types.ts";

const MAX_STATIC_NODES = 200;
const MAX_NESTING = 8;
const MAX_ARRAY_ITEMS = 500;
const MAX_OBJECT_KEYS = 200;
const MAX_STRING_CHARS = 32 * 1024;
const SAFE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

interface CompileState {
	ids: Set<string>;
	outputNames: Set<string>;
	autoId: number;
}

type AstNode = Record<string, any>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${label} must be an object.`);
	return value;
}

function assertArray(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
	return value;
}

function assertString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
	if (value.length > MAX_STRING_CHARS) throw new Error(`${label} exceeds ${MAX_STRING_CHARS} characters.`);
	return value;
}

function assertSafeId(value: unknown, label: string): string {
	const id = assertString(value, label);
	if (!SAFE_ID.test(id)) throw new Error(`${label} '${id}' must match ${SAFE_ID}.`);
	return id;
}

function assertSafeName(value: unknown, label: string): string {
	const name = assertString(value, label);
	if (!SAFE_NAME.test(name)) throw new Error(`${label} '${name}' must match ${SAFE_NAME}.`);
	return name;
}

function optionalPositiveInteger(value: unknown, label: string, max: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
		throw new Error(`${label} must be an integer from 1 to ${max}.`);
	}
	return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
	return value;
}

function normalizeTurnBudget(value: unknown, label: string): WorkflowAgentTask["turnBudget"] | undefined {
	if (value === undefined) return undefined;
	const budget = assertRecord(value, label);
	assertOnlyKeys(budget, ["maxTurns", "graceTurns"], label);
	const maxTurns = optionalPositiveInteger(budget.maxTurns, `${label}.maxTurns`, 10_000);
	if (!maxTurns) throw new Error(`${label}.maxTurns is required.`);
	let graceTurns: number | undefined;
	if (budget.graceTurns !== undefined) {
		if (typeof budget.graceTurns !== "number" || !Number.isInteger(budget.graceTurns) || budget.graceTurns < 0 || budget.graceTurns > 10_000) {
			throw new Error(`${label}.graceTurns must be an integer from 0 to 10000.`);
		}
		graceTurns = budget.graceTurns;
	}
	return { maxTurns, ...(graceTurns !== undefined ? { graceTurns } : {}) };
}

function normalizeToolBudget(value: unknown, label: string): WorkflowAgentTask["toolBudget"] | undefined {
	if (value === undefined) return undefined;
	const budget = assertRecord(value, label);
	assertOnlyKeys(budget, ["soft", "hard", "block"], label);
	const hard = optionalPositiveInteger(budget.hard, `${label}.hard`, 1_000_000);
	if (!hard) throw new Error(`${label}.hard is required.`);
	const soft = optionalPositiveInteger(budget.soft, `${label}.soft`, 1_000_000);
	if (soft !== undefined && soft > hard) throw new Error(`${label}.soft must not exceed hard.`);
	let block: string[] | "*" | undefined;
	if (budget.block !== undefined) {
		if (budget.block === "*") block = "*";
		else if (Array.isArray(budget.block) && budget.block.length > 0 && budget.block.length <= 128
			&& budget.block.every((entry) => typeof entry === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(entry))) {
			block = [...budget.block];
		} else throw new Error(`${label}.block must be '*' or a non-empty array of tool names.`);
	}
	return { ...(soft !== undefined ? { soft } : {}), hard, ...(block !== undefined ? { block } : {}) };
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const allowedSet = new Set(allowed);
	const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
	if (unknown.length > 0) throw new Error(`${label} has unsupported fields: ${unknown.join(", ")}.`);
}

function registerId(state: CompileState, id: string): string {
	if (state.ids.has(id)) throw new Error(`Duplicate workflow node id '${id}'.`);
	state.ids.add(id);
	return id;
}

function registerOutput(state: CompileState, name: string): string {
	if (state.outputNames.has(name)) throw new Error(`Duplicate workflow output name '${name}'.`);
	state.outputNames.add(name);
	return name;
}

function normalizePointer(value: unknown, label: string): string {
	if (value === undefined || value === "") return "";
	if (typeof value !== "string" || (!value.startsWith("/") && value !== "")) {
		throw new Error(`${label} must be an empty string or JSON Pointer beginning with '/'.`);
	}
	if (value.length > 1_024) throw new Error(`${label} is too long.`);
	return value;
}

function reference(source: WorkflowReference["source"], args: unknown[], label: string): WorkflowReference {
	if (source === "input" || source === "item") {
		if (args.length > 1) throw new Error(`${label} accepts at most one JSON Pointer.`);
		return { kind: "reference", source, pointer: normalizePointer(args[0], `${label} pointer`) } as WorkflowReference;
	}
	if (args.length < 1 || args.length > 2) throw new Error(`${label} requires a name and optional JSON Pointer.`);
	const name = assertSafeName(args[0], `${label} name`);
	return {
		kind: "reference",
		source,
		name,
		pointer: normalizePointer(args[1], `${label} pointer`),
	} as WorkflowReference;
}

function isReference(value: unknown): value is WorkflowReference {
	if (!isRecord(value) || value.kind !== "reference" || typeof value.pointer !== "string") return false;
	if (value.source === "input" || value.source === "item") {
		return Object.keys(value).every((key) => ["kind", "source", "pointer"].includes(key));
	}
	if (value.source === "output" || value.source === "variable") {
		return typeof value.name === "string"
			&& Object.keys(value).every((key) => ["kind", "source", "name", "pointer"].includes(key));
	}
	return false;
}

function toWorkflowValue(value: unknown, label: string): WorkflowValue {
	if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${label} must not contain NaN or Infinity.`);
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
	if (isReference(value)) return value;
	if (Array.isArray(value)) return value.map((entry, index) => toWorkflowValue(entry, `${label}[${index}]`));
	if (isRecord(value)) {
		if (value.kind === "reference") throw new Error(`${label} contains a malformed workflow reference.`);
		const output: Record<string, WorkflowValue> = {};
		for (const [key, child] of Object.entries(value)) output[key] = toWorkflowValue(child, `${label}.${key}`);
		return output;
	}
	throw new Error(`${label} contains an unsupported value.`);
}

function normalizeCondition(value: unknown, label: string): WorkflowCondition {
	const condition = assertRecord(value, label);
	switch (condition.kind) {
		case "equals":
			assertOnlyKeys(condition, ["kind", "left", "right"], label);
			return { kind: "equals", left: toWorkflowValue(condition.left, `${label}.left`), right: toWorkflowValue(condition.right, `${label}.right`) };
		case "exists":
		case "not-empty":
			assertOnlyKeys(condition, ["kind", "value"], label);
			return { kind: condition.kind, value: toWorkflowValue(condition.value, `${label}.value`) } as WorkflowCondition;
		case "not":
			assertOnlyKeys(condition, ["kind", "condition"], label);
			return { kind: "not", condition: normalizeCondition(condition.condition, `${label}.condition`) };
		case "and":
		case "or": {
			assertOnlyKeys(condition, ["kind", "conditions"], label);
			if (!Array.isArray(condition.conditions) || condition.conditions.length === 0) throw new Error(`${label}.conditions must be a non-empty array.`);
			return { kind: condition.kind, conditions: condition.conditions.map((entry, index) => normalizeCondition(entry, `${label}.conditions[${index}]`)) };
		}
		default:
			throw new Error(`${label} is not a supported workflow condition.`);
	}
}

const BUILDER_NODE = Symbol("pi-dynamic-workflows-builder-node");

function markBuilderNode<T extends WorkflowNode>(node: T): T {
	Object.defineProperty(node, BUILDER_NODE, { value: true, enumerable: false, configurable: false, writable: false });
	return node;
}

function buildRun(args: unknown[], state: CompileState): RunNode {
	if (args.length !== 2) throw new Error("run(id, options) requires exactly two arguments.");
	const id = registerId(state, assertSafeId(args[0], "run id"));
	const options = assertRecord(args[1], `run('${id}') options`);
	assertOnlyKeys(options, [
		"agent", "task", "label", "saveAs", "write", "context", "model", "timeoutMs",
		"turnBudget", "toolBudget", "schema",
	], `run('${id}') options`);
	const saveAs = registerOutput(state, assertSafeName(options.saveAs ?? id.replace(/-/g, "_"), `run('${id}') saveAs`));
	const context = options.context;
	if (context !== undefined && context !== "fresh" && context !== "fork") {
		throw new Error(`run('${id}') context must be 'fresh' or 'fork'.`);
	}
	if (options.schema !== undefined && !isRecord(options.schema)) {
		throw new Error(`run('${id}') schema must be an object.`);
	}
	if (isRecord(options.schema)) assertSchemaSafe(options.schema);
	if (options.write !== undefined && typeof options.write !== "boolean") {
		throw new Error(`run('${id}') write must be a boolean.`);
	}
	const model = options.model === undefined ? undefined : assertString(options.model, `run('${id}') model`);
	const timeoutMs = optionalPositiveInteger(options.timeoutMs, `run('${id}') timeoutMs`, 24 * 60 * 60_000);
	const turnBudget = normalizeTurnBudget(options.turnBudget, `run('${id}') turnBudget`);
	const toolBudget = normalizeToolBudget(options.toolBudget, `run('${id}') toolBudget`);
	const label = options.label === undefined ? undefined : assertString(options.label, `run('${id}') label`).trim();
	const task: WorkflowAgentTask = {
		agent: assertString(options.agent, `run('${id}') agent`),
		task: assertString(options.task, `run('${id}') task`),
		...(options.write === true ? { write: true } : {}),
		...(context ? { context } : {}),
		...(model ? { model } : {}),
		...(timeoutMs ? { timeoutMs } : {}),
		...(turnBudget ? { turnBudget } : {}),
		...(toolBudget ? { toolBudget } : {}),
		...(isRecord(options.schema) ? { schema: options.schema } : {}),
	};
	return markBuilderNode({
		kind: "run",
		id,
		...(label ? { label } : {}),
		saveAs,
		task,
	});
}

function assertNodes(value: unknown, label: string): WorkflowNode[] {
	const nodes = assertArray(value, label);
	for (const [index, node] of nodes.entries()) {
		if (!isRecord(node) || (node as Record<PropertyKey, unknown>)[BUILDER_NODE] !== true) {
			throw new Error(`${label}[${index}] must be produced by a supported workflow step builder; raw node objects are forbidden.`);
		}
	}
	return nodes as WorkflowNode[];
}

function buildPhase(args: unknown[], state: CompileState): WorkflowNode {
	if (args.length !== 2) throw new Error("phase(name, steps) requires exactly two arguments.");
	const name = assertString(args[0], "phase name").trim();
	const idBase = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 56);
	const id = registerId(state, assertSafeId(`phase-${idBase}`, "phase id"));
	return markBuilderNode({ kind: "phase", id, name, steps: assertNodes(args[1], `phase('${name}') steps`) });
}

function buildParallel(args: unknown[], state: CompileState): ParallelNode {
	if (args.length !== 2) throw new Error("parallel(id, options) requires exactly two arguments.");
	const id = registerId(state, assertSafeId(args[0], "parallel id"));
	const options = assertRecord(args[1], `parallel('${id}') options`);
	assertOnlyKeys(options, ["label", "concurrency", "worktree", "failFast", "steps"], `parallel('${id}') options`);
	const steps = assertNodes(options.steps, `parallel('${id}') steps`);
	if (!steps.every((step) => step.kind === "run")) throw new Error(`parallel('${id}') may contain only run(...) steps.`);
	return markBuilderNode({
		kind: "parallel",
		id,
		label: typeof options.label === "string" && options.label.trim() ? options.label.trim() : id,
		...(optionalPositiveInteger(options.concurrency, `parallel('${id}') concurrency`, 32) ? { concurrency: options.concurrency as number } : {}),
		...(optionalBoolean(options.worktree, `parallel('${id}') worktree`) !== undefined ? { worktree: options.worktree as boolean } : {}),
		...(optionalBoolean(options.failFast, `parallel('${id}') failFast`) !== undefined ? { failFast: options.failFast as boolean } : {}),
		steps: steps as RunNode[],
	});
}

function buildForEach(args: unknown[], state: CompileState): ForEachNode {
	if (args.length !== 2) throw new Error("forEach(id, options) requires exactly two arguments.");
	const id = registerId(state, assertSafeId(args[0], "forEach id"));
	const options = assertRecord(args[1], `forEach('${id}') options`);
	assertOnlyKeys(options, [
		"label", "from", "as", "maxItems", "concurrency", "worktree", "failFast", "collectAs", "steps",
	], `forEach('${id}') options`);
	const maxItems = optionalPositiveInteger(options.maxItems, `forEach('${id}') maxItems`, 500);
	if (!maxItems) throw new Error(`forEach('${id}') requires a finite maxItems.`);
	const collectAs = registerOutput(
		state,
		assertSafeName(options.collectAs ?? `${id.replace(/-/g, "_")}_results`, `forEach('${id}') collectAs`),
	);
	return markBuilderNode({
		kind: "for-each",
		id,
		label: typeof options.label === "string" && options.label.trim() ? options.label.trim() : id,
		from: toWorkflowValue(options.from, `forEach('${id}') from`),
		itemName: assertSafeName(options.as ?? "item", `forEach('${id}') as`),
		maxItems,
		...(optionalPositiveInteger(options.concurrency, `forEach('${id}') concurrency`, 32) ? { concurrency: options.concurrency as number } : {}),
		...(optionalBoolean(options.worktree, `forEach('${id}') worktree`) !== undefined ? { worktree: options.worktree as boolean } : {}),
		...(optionalBoolean(options.failFast, `forEach('${id}') failFast`) !== undefined ? { failFast: options.failFast as boolean } : {}),
		collectAs,
		steps: assertNodes(options.steps, `forEach('${id}') steps`),
	});
}

function buildWhen(args: unknown[], state: CompileState): WhenNode {
	if (args.length < 3 || args.length > 4) throw new Error("when(id, condition, thenSteps, elseSteps?) expects 3-4 arguments.");
	const id = registerId(state, assertSafeId(args[0], "when id"));
	const condition = normalizeCondition(args[1], `when('${id}') condition`);
	return markBuilderNode({
		kind: "when",
		id,
		label: id,
		condition,
		then: assertNodes(args[2], `when('${id}') thenSteps`),
		else: args[3] === undefined ? [] : assertNodes(args[3], `when('${id}') elseSteps`),
	});
}

function buildRepeat(args: unknown[], state: CompileState): RepeatNode {
	if (args.length !== 2) throw new Error("repeat(id, options) requires exactly two arguments.");
	const id = registerId(state, assertSafeId(args[0], "repeat id"));
	const options = assertRecord(args[1], `repeat('${id}') options`);
	assertOnlyKeys(options, ["label", "maxIterations", "until", "collectAs", "steps"], `repeat('${id}') options`);
	const maxIterations = optionalPositiveInteger(options.maxIterations, `repeat('${id}') maxIterations`, 20);
	if (!maxIterations) throw new Error(`repeat('${id}') requires a finite maxIterations.`);
	const until = normalizeCondition(options.until, `repeat('${id}') until`);
	let collectAs: string | undefined;
	if (options.collectAs !== undefined) {
		collectAs = registerOutput(state, assertSafeName(options.collectAs, `repeat('${id}') collectAs`));
	}
	return markBuilderNode({
		kind: "repeat",
		id,
		label: typeof options.label === "string" && options.label.trim() ? options.label.trim() : id,
		maxIterations,
		until,
		...(collectAs ? { collectAs } : {}),
		steps: assertNodes(options.steps, `repeat('${id}') steps`),
	});
}

function buildSet(args: unknown[], state: CompileState): SetNode {
	if (args.length !== 2) throw new Error("set(name, value) requires exactly two arguments.");
	const name = assertSafeName(args[0], "set variable name");
	return markBuilderNode({
		kind: "set",
		id: registerId(state, assertSafeId(`set-${name.toLowerCase().replace(/_/g, "-")}-${++state.autoId}`, "set id")),
		name,
		value: toWorkflowValue(args[1], `set('${name}') value`),
	});
}

function buildCondition(name: string, args: unknown[]): WorkflowCondition {
	switch (name) {
		case "equals":
			if (args.length !== 2) throw new Error("equals(left, right) requires two arguments.");
			return { kind: "equals", left: toWorkflowValue(args[0], "equals left"), right: toWorkflowValue(args[1], "equals right") };
		case "exists":
		case "notEmpty":
			if (args.length !== 1) throw new Error(`${name}(value) requires one argument.`);
			return { kind: name === "exists" ? "exists" : "not-empty", value: toWorkflowValue(args[0], `${name} value`) };
		case "not":
			if (args.length !== 1) throw new Error("not(condition) requires one condition.");
			return { kind: "not", condition: normalizeCondition(args[0], "not condition") };
		case "and":
		case "or": {
			if (args.length !== 1 || !Array.isArray(args[0]) || args[0].length === 0) {
				throw new Error(`${name}([conditions]) requires one non-empty condition array.`);
			}
			return { kind: name, conditions: args[0].map((entry, index) => normalizeCondition(entry, `${name}[${index}]`)) } as WorkflowCondition;
		}
		default:
			throw new Error(`Unsupported condition builder '${name}'.`);
	}
}

function buildCall(name: string, args: unknown[], state: CompileState): unknown {
	switch (name) {
		case "input": return reference("input", args, "input");
		case "output": return reference("output", args, "output");
		case "variable": return reference("variable", args, "variable");
		case "item": return reference("item", args, "item");
		case "run": return buildRun(args, state);
		case "phase": return buildPhase(args, state);
		case "parallel": return buildParallel(args, state);
		case "forEach": return buildForEach(args, state);
		case "when": return buildWhen(args, state);
		case "repeat": return buildRepeat(args, state);
		case "set": return buildSet(args, state);
		case "equals":
		case "exists":
		case "notEmpty":
		case "not":
		case "and":
		case "or":
			return buildCondition(name, args);
		default:
			throw new Error(`Call to unsupported workflow builder '${name}'.`);
	}
}

function evaluate(node: AstNode, state: CompileState, depth = 0): unknown {
	if (depth > MAX_NESTING * 4) throw new Error("Workflow source expression nesting is too deep.");
	switch (node.type) {
		case "Literal":
			if (node.regex || typeof node.value === "bigint") throw new Error("Regex and BigInt literals are not supported.");
			if (typeof node.value === "number" && !Number.isFinite(node.value)) throw new Error("Workflow number literals must be finite.");
			if (typeof node.value === "string" && node.value.length > MAX_STRING_CHARS) throw new Error("Workflow string literal is too long.");
			return node.value;
		case "TemplateLiteral":
			if (node.expressions.length > 0) throw new Error("JavaScript template expressions are not supported; use {{...}} workflow placeholders in a plain string.");
			return node.quasis.map((part: AstNode) => part.value.cooked).join("");
		case "UnaryExpression":
			if (node.operator !== "-" || node.argument.type !== "Literal" || typeof node.argument.value !== "number") {
				throw new Error("Only negative numeric unary literals are supported.");
			}
			if (!Number.isFinite(node.argument.value)) throw new Error("Workflow number literals must be finite.");
			return -node.argument.value;
		case "ArrayExpression":
			if (node.elements.length > MAX_ARRAY_ITEMS) throw new Error(`Workflow arrays may contain at most ${MAX_ARRAY_ITEMS} items.`);
			return node.elements.map((element: AstNode | null, index: number) => {
				if (!element || element.type === "SpreadElement") throw new Error(`Array holes/spreads are not supported (index ${index}).`);
				return evaluate(element, state, depth + 1);
			});
		case "ObjectExpression": {
			if (node.properties.length > MAX_OBJECT_KEYS) throw new Error(`Workflow objects may contain at most ${MAX_OBJECT_KEYS} keys.`);
			const output: Record<string, unknown> = Object.create(null);
			for (const property of node.properties as AstNode[]) {
				if (property.type !== "Property" || property.kind !== "init" || property.method || property.computed || property.shorthand) {
					throw new Error("Workflow objects support only explicit, non-computed key: value properties.");
				}
				const key = property.key.type === "Identifier" ? property.key.name : property.key.value;
				if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)) {
					throw new Error(`Unsafe or unsupported object key: ${String(key)}.`);
				}
				if (Object.hasOwn(output, key)) throw new Error(`Duplicate object key '${key}'.`);
				output[key] = evaluate(property.value, state, depth + 1);
			}
			return output;
		}
		case "CallExpression": {
			if (node.optional || node.callee.type !== "Identifier" || node.arguments.some((argument: AstNode) => argument.type === "SpreadElement")) {
				throw new Error("Workflow calls must target a supported builder identifier and cannot use spreads/optional calls.");
			}
			const args = node.arguments.map((argument: AstNode) => evaluate(argument, state, depth + 1));
			return buildCall(node.callee.name, args, state);
		}
		default:
			throw new Error(`Unsupported JavaScript syntax '${node.type}'. Dynamic code, variables, imports, functions, and native loops are not allowed.`);
	}
}

function validateValueReferences(
	value: WorkflowValue,
	outputs: Set<string>,
	variables: Set<string>,
	itemAllowed: boolean,
	label: string,
): void {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return;
	if (Array.isArray(value)) {
		value.forEach((entry, index) => validateValueReferences(entry, outputs, variables, itemAllowed, `${label}[${index}]`));
		return;
	}
	if (value.kind === "reference") {
		const reference = value as WorkflowReference;
		if (reference.source === "output" && !outputs.has(reference.name)) throw new Error(`${label} references unknown output '${reference.name}'.`);
		if (reference.source === "variable" && !variables.has(reference.name)) throw new Error(`${label} references unknown variable '${reference.name}'.`);
		if (reference.source === "item" && !itemAllowed) throw new Error(`${label} uses item() outside forEach.`);
		return;
	}
	for (const [key, child] of Object.entries(value)) validateValueReferences(child, outputs, variables, itemAllowed, `${label}.${key}`);
}

function validateConditionReferences(
	condition: WorkflowCondition,
	outputs: Set<string>,
	variables: Set<string>,
	itemAllowed: boolean,
	label: string,
): void {
	if (condition.kind === "equals") {
		validateValueReferences(condition.left, outputs, variables, itemAllowed, `${label}.left`);
		validateValueReferences(condition.right, outputs, variables, itemAllowed, `${label}.right`);
	} else if (condition.kind === "exists" || condition.kind === "not-empty") {
		validateValueReferences(condition.value, outputs, variables, itemAllowed, `${label}.value`);
	} else if (condition.kind === "not") {
		validateConditionReferences(condition.condition, outputs, variables, itemAllowed, `${label}.condition`);
	} else {
		condition.conditions.forEach((entry, index) => validateConditionReferences(entry, outputs, variables, itemAllowed, `${label}[${index}]`));
	}
}

interface Availability {
	outputs: Set<string>;
	variables: Set<string>;
	itemNames: Set<string>;
	iterationAllowed: boolean;
}

function cloneAvailability(value: Availability): Availability {
	return {
		outputs: new Set(value.outputs),
		variables: new Set(value.variables),
		itemNames: new Set(value.itemNames),
		iterationAllowed: value.iterationAllowed,
	};
}

function intersectInto(target: Set<string>, left: Set<string>, right: Set<string>): void {
	target.clear();
	for (const value of left) if (right.has(value)) target.add(value);
}

function validateTaskTemplate(template: string, available: Availability, label: string): void {
	for (const match of template.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*)\s*\}\}/g)) {
		const pathText = match[1]!;
		const [root, name] = pathText.split(".");
		if (root === "input") continue;
		if (root === "outputs") {
			if (name && !available.outputs.has(name)) throw new Error(`${label} template references output '${name}' before it is available.`);
			continue;
		}
		if (root === "variables") {
			if (name && !available.variables.has(name)) throw new Error(`${label} template references variable '${name}' before it is available.`);
			continue;
		}
		if (root === "item" || available.itemNames.has(root)) {
			if (available.itemNames.size === 0) throw new Error(`${label} template uses '${root}' outside forEach.`);
			continue;
		}
		if (root === "iteration") {
			if (!available.iterationAllowed) throw new Error(`${label} template uses iteration outside repeat.`);
			continue;
		}
		throw new Error(`${label} template uses unknown root '${root}'.`);
	}
}

function validateRunAvailability(node: RunNode, available: Availability): void {
	validateTaskTemplate(node.task.task, available, `run('${node.id}') task`);
	available.outputs.add(node.saveAs);
}

function validateNodeFlow(nodes: WorkflowNode[], available: Availability): void {
	for (const node of nodes) {
		switch (node.kind) {
			case "phase":
				validateNodeFlow(node.steps, available);
				break;
			case "run":
				validateRunAvailability(node, available);
				break;
			case "parallel":
				for (const step of node.steps) {
					const taskAvailability = cloneAvailability(available);
					validateTaskTemplate(step.task.task, taskAvailability, `run('${step.id}') task`);
				}
				for (const step of node.steps) available.outputs.add(step.saveAs);
				break;
			case "set":
				validateValueReferences(node.value, available.outputs, available.variables, available.itemNames.size > 0, `set('${node.name}')`);
				available.variables.add(node.name);
				break;
			case "for-each": {
				validateValueReferences(node.from, available.outputs, available.variables, available.itemNames.size > 0, `forEach('${node.id}') from`);
				const body = cloneAvailability(available);
				body.itemNames = new Set(["item", node.itemName]);
				validateNodeFlow(node.steps, body);
				available.outputs.add(node.collectAs);
				break;
			}
			case "repeat": {
				const body = cloneAvailability(available);
				body.iterationAllowed = true;
				validateNodeFlow(node.steps, body);
				validateConditionReferences(node.until, body.outputs, body.variables, body.itemNames.size > 0, `repeat('${node.id}') until`);
				available.outputs = body.outputs;
				available.variables = body.variables;
				if (node.collectAs) available.outputs.add(node.collectAs);
				break;
			}
			case "when": {
				validateConditionReferences(node.condition, available.outputs, available.variables, available.itemNames.size > 0, `when('${node.id}') condition`);
				const thenAvailable = cloneAvailability(available);
				const elseAvailable = cloneAvailability(available);
				validateNodeFlow(node.then, thenAvailable);
				validateNodeFlow(node.else, elseAvailable);
				intersectInto(available.outputs, thenAvailable.outputs, elseAvailable.outputs);
				intersectInto(available.variables, thenAvailable.variables, elseAvailable.variables);
				break;
			}
		}
	}
}

function validateTree(nodes: WorkflowNode[], depth = 0): number {
	if (depth > MAX_NESTING) throw new Error(`Workflow nesting exceeds ${MAX_NESTING} levels.`);
	let count = 0;
	for (const node of nodes) {
		count++;
		if (node.kind === "phase" && depth > 0) throw new Error("phase(...) nodes are allowed only at the workflow top level.");
		if (node.kind === "phase" || node.kind === "for-each" || node.kind === "repeat") count += validateTree(node.steps, depth + 1);
		else if (node.kind === "when") count += validateTree(node.then, depth + 1) + validateTree(node.else, depth + 1);
		else if (node.kind === "parallel") count += validateTree(node.steps, depth + 1);
	}
	return count;
}

export function compileWorkflowSource(source: string, defaultSize: WorkflowSize = "small"): CompiledWorkflow {
	validateWorkflowSourceSize(source);
	let program: AstNode;
	try {
		program = parse(source, { ecmaVersion: "latest", sourceType: "script", allowHashBang: false }) as unknown as AstNode;
	} catch (error) {
		throw new Error(`Workflow JavaScript syntax error: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!Array.isArray(program.body) || program.body.length !== 1 || program.body[0]?.type !== "ExpressionStatement") {
		throw new Error("Workflow source must contain exactly one workflow({...}) expression.");
	}
	const root = program.body[0].expression as AstNode;
	if (root.type !== "CallExpression" || root.callee?.type !== "Identifier" || root.callee.name !== "workflow" || root.arguments.length !== 1) {
		throw new Error("Workflow source must contain exactly one workflow({...}) call.");
	}
	const state: CompileState = { ids: new Set(), outputNames: new Set(), autoId: 0 };
	const raw = evaluate(root.arguments[0], state);
	const definition = assertRecord(raw, "workflow definition");
	const steps = assertNodes(definition.steps, "workflow steps");
	if (definition.result === undefined) {
		throw new Error("Workflow definition requires a result value (usually output('finalNode')).");
	}
	const result = toWorkflowValue(definition.result, "workflow result");
	const manifestInput = { ...definition };
	delete manifestInput.steps;
	delete manifestInput.result;
	const manifest = normalizeManifest(manifestInput, defaultSize);
	const phaseNames = steps.filter((node) => node.kind === "phase").map((node) => (node as { name: string }).name);
	if (phaseNames.length !== steps.length) throw new Error("Top-level workflow steps must all be phase(...) nodes.");
	if (JSON.stringify(phaseNames) !== JSON.stringify(manifest.phases)) {
		throw new Error(`Manifest phases ${JSON.stringify(manifest.phases)} must exactly match top-level phase order ${JSON.stringify(phaseNames)}.`);
	}
	const staticNodeCount = validateTree(steps);
	const available: Availability = { outputs: new Set(), variables: new Set(), itemNames: new Set(), iterationAllowed: false };
	validateNodeFlow(steps, available);
	validateValueReferences(result, available.outputs, available.variables, false, "workflow result");
	if (staticNodeCount > MAX_STATIC_NODES) {
		throw new Error(`Workflow contains ${staticNodeCount} static nodes; maximum is ${MAX_STATIC_NODES}.`);
	}
	return {
		version: 1,
		manifest,
		steps,
		result,
		staticNodeCount,
		sourceHash: workflowSourceHash(source),
	};
}
