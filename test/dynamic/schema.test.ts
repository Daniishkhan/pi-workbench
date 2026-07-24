import assert from "node:assert/strict";
import { test } from "node:test";
import { compileWorkflowSource } from "../../extensions/dynamic/compiler.ts";
import { assertSchemaSafe, parseAndValidateStructuredOutput } from "../../extensions/dynamic/schema.ts";

test("rejects unsupported schema keywords at the root and nested levels", () => {
	assert.throws(() => assertSchemaSafe({ type: "string", pattern: "^x$" }), /unsupported.*pattern/i);
	assert.throws(
		() => assertSchemaSafe({ type: "object", properties: { value: { type: "string", pattern: "^x$" } } }),
		/unsupported.*pattern/i,
	);
});

test("uses structural JSON equality for const and enum, including null-prototype DSL objects", () => {
	const schema = { type: "object", const: { a: 1, b: 2 } };
	assert.deepEqual(parseAndValidateStructuredOutput('{"b":2,"a":1}', schema), { b: 2, a: 1 });
	const enumSchema = { enum: [{ a: 1, b: 2 }] };
	assert.deepEqual(parseAndValidateStructuredOutput('{"b":2,"a":1}', enumSchema), { b: 2, a: 1 });
	const compiled = compileWorkflowSource(`workflow({ version: 1, name: "schema", description: "Compiled schema.", size: "small", permissions: ["read"], phases: ["Run"], steps: [phase("Run", [run("check", { agent: "pi-dynamic-workflows.verifier", task: "Check", schema: { type: "object", const: { a: 1, b: 2 } } })])], result: output("check") });`);
	const compiledSchema = (compiled.steps[0] as any).steps[0].task.schema;
	assert.deepEqual(parseAndValidateStructuredOutput('{"b":2,"a":1}', compiledSchema), { b: 2, a: 1 });
});

test("validates anyOf and all sibling constraints", () => {
	assert.throws(
		() => parseAndValidateStructuredOutput("1", { type: "string", anyOf: [{ const: 1 }] }),
		/expected string/,
	);
});

test("enforces supported numeric and object constraints", () => {
	assert.throws(() => parseAndValidateStructuredOutput("9", { type: "number", maximum: 5 }), /greater than maximum/);
	assert.throws(
		() => parseAndValidateStructuredOutput('{"ok":true,"extra":1}', {
			type: "object",
			required: ["ok"],
			additionalProperties: false,
			properties: { ok: { type: "boolean" } },
		}),
		/additional property/,
	);
});
