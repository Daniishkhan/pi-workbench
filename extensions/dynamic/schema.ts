const MAX_SCHEMA_BYTES = 32 * 1024;
const MAX_SCHEMA_DEPTH = 20;
const MAX_VALIDATION_ERRORS = 8;
const JSON_SCHEMA_TYPES = new Set(["null", "boolean", "number", "integer", "string", "array", "object"]);
const SUPPORTED_KEYWORDS = new Set([
	"$id", "$schema", "title", "description", "type", "properties", "required", "items", "additionalProperties",
	"enum", "const", "anyOf", "allOf", "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonEqual(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (Array.isArray(left) || Array.isArray(right)) {
		return Array.isArray(left) && Array.isArray(right)
			&& left.length === right.length
			&& left.every((entry, index) => jsonEqual(entry, right[index]));
	}
	if (isRecord(left) || isRecord(right)) {
		if (!isRecord(left) || !isRecord(right)) return false;
		const leftKeys = Object.keys(left);
		const rightKeys = Object.keys(right);
		return leftKeys.length === rightKeys.length
			&& leftKeys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
	}
	return false;
}

function typeMatches(type: string, value: unknown): boolean {
	switch (type) {
		case "null": return value === null;
		case "boolean": return typeof value === "boolean";
		case "number": return typeof value === "number" && Number.isFinite(value);
		case "integer": return typeof value === "number" && Number.isInteger(value);
		case "string": return typeof value === "string";
		case "array": return Array.isArray(value);
		case "object": return isRecord(value);
		default: return false;
	}
}

function walkSchema(schema: Record<string, unknown>, depth: number, label: string): void {
	if (depth > MAX_SCHEMA_DEPTH) throw new Error(`Output schema nesting exceeds ${MAX_SCHEMA_DEPTH}.`);
	const unknown = Object.keys(schema).filter((key) => !SUPPORTED_KEYWORDS.has(key));
	if (unknown.length > 0) throw new Error(`${label} uses unsupported output schema keyword(s): ${unknown.join(", ")}.`);
	if (schema.type !== undefined) {
		const types = typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type : [];
		if (types.length === 0 || !types.every((entry) => typeof entry === "string" && JSON_SCHEMA_TYPES.has(entry))) {
			throw new Error(`${label}.type must be a supported JSON Schema type or non-empty type array.`);
		}
	}
	if (schema.properties !== undefined) {
		if (!isRecord(schema.properties)) throw new Error(`${label}.properties must be an object.`);
		for (const [name, child] of Object.entries(schema.properties)) {
			if (!isRecord(child)) throw new Error(`${label}.properties.${name} must be a schema object.`);
			walkSchema(child, depth + 1, `${label}.properties.${name}`);
		}
	}
	if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every((entry) => typeof entry === "string"))) {
		throw new Error(`${label}.required must be a string array.`);
	}
	if (schema.items !== undefined) {
		if (!isRecord(schema.items)) throw new Error(`${label}.items must be a schema object.`);
		walkSchema(schema.items, depth + 1, `${label}.items`);
	}
	for (const keyword of ["anyOf", "allOf"] as const) {
		if (schema[keyword] === undefined) continue;
		if (!Array.isArray(schema[keyword]) || schema[keyword].length === 0 || !schema[keyword].every(isRecord)) {
			throw new Error(`${label}.${keyword} must be a non-empty schema array.`);
		}
		(schema[keyword] as Record<string, unknown>[]).forEach((child, index) => walkSchema(child, depth + 1, `${label}.${keyword}[${index}]`));
	}
	if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
		throw new Error(`${label}.enum must be a non-empty array.`);
	}
	if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
		throw new Error(`${label}.additionalProperties supports only true or false.`);
	}
	for (const keyword of ["minItems", "maxItems", "minLength", "maxLength"] as const) {
		if (schema[keyword] !== undefined && (typeof schema[keyword] !== "number" || !Number.isInteger(schema[keyword]) || schema[keyword] < 0)) {
			throw new Error(`${label}.${keyword} must be a non-negative integer.`);
		}
	}
	for (const keyword of ["minimum", "maximum"] as const) {
		if (schema[keyword] !== undefined && (typeof schema[keyword] !== "number" || !Number.isFinite(schema[keyword]))) {
			throw new Error(`${label}.${keyword} must be a finite number.`);
		}
	}
}

function validateNode(
	schema: Record<string, unknown>,
	value: unknown,
	path: string,
	errors: string[],
	depth: number,
): void {
	if (errors.length >= MAX_VALIDATION_ERRORS) return;
	if (depth > MAX_SCHEMA_DEPTH) {
		errors.push(`${path}: schema nesting exceeds ${MAX_SCHEMA_DEPTH}`);
		return;
	}
	if (schema.const !== undefined && !jsonEqual(schema.const, value)) errors.push(`${path}: does not match const`);
	if (Array.isArray(schema.enum) && !schema.enum.some((entry) => jsonEqual(entry, value))) errors.push(`${path}: is not in enum`);
	if (Array.isArray(schema.anyOf)) {
		const matches = schema.anyOf.some((candidate) => {
			const local: string[] = [];
			validateNode(candidate as Record<string, unknown>, value, path, local, depth + 1);
			return local.length === 0;
		});
		if (!matches) errors.push(`${path}: does not match anyOf`);
	}
	if (Array.isArray(schema.allOf)) {
		for (const candidate of schema.allOf) validateNode(candidate as Record<string, unknown>, value, path, errors, depth + 1);
	}
	const types = typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type as string[] : [];
	if (types.length > 0 && !types.some((type) => typeMatches(type, value))) {
		errors.push(`${path}: expected ${types.join("|")}`);
		return;
	}
	if (typeof value === "number") {
		if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path}: less than minimum`);
		if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path}: greater than maximum`);
	}
	if (typeof value === "string") {
		if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${path}: shorter than minLength`);
		if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errors.push(`${path}: longer than maxLength`);
	}
	if (Array.isArray(value)) {
		if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${path}: fewer than minItems`);
		if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${path}: more than maxItems`);
		if (isRecord(schema.items)) {
			for (let index = 0; index < value.length && errors.length < MAX_VALIDATION_ERRORS; index++) {
				validateNode(schema.items, value[index], `${path}/${index}`, errors, depth + 1);
			}
		}
	}
	if (isRecord(value)) {
		const required = Array.isArray(schema.required) ? schema.required as string[] : [];
		for (const key of required) if (!Object.hasOwn(value, key)) errors.push(`${path}/${key}: required property missing`);
		const properties = isRecord(schema.properties) ? schema.properties : {};
		for (const [key, childSchema] of Object.entries(properties)) {
			if (Object.hasOwn(value, key)) validateNode(childSchema as Record<string, unknown>, value[key], `${path}/${key}`, errors, depth + 1);
		}
		if (schema.additionalProperties === false) {
			for (const key of Object.keys(value)) if (!Object.hasOwn(properties, key)) errors.push(`${path}/${key}: additional property not allowed`);
		}
	}
}

export function assertSchemaSafe(schema: Record<string, unknown>): void {
	const bytes = Buffer.byteLength(JSON.stringify(schema), "utf8");
	if (bytes > MAX_SCHEMA_BYTES) throw new Error(`Output schema is ${bytes} bytes; maximum is ${MAX_SCHEMA_BYTES}.`);
	walkSchema(schema, 0, "$schema");
}

export function parseAndValidateStructuredOutput(output: string, schema: Record<string, unknown>): unknown {
	assertSchemaSafe(schema);
	const trimmed = output.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i)?.[1]?.trim() ?? trimmed;
	let value: unknown;
	try {
		value = JSON.parse(fenced);
	} catch (error) {
		throw new Error(`Agent output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const errors: string[] = [];
	validateNode(schema, value, "$", errors, 0);
	if (errors.length > 0) throw new Error(`Agent JSON failed output schema: ${errors.join("; ")}`);
	return value;
}
