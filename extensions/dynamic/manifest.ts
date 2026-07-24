import { createHash } from "node:crypto";
import {
	WORKFLOW_FORMAT_VERSION,
	type WorkflowManifest,
	type WorkflowPermission,
	type WorkflowSize,
} from "./types.ts";

export const MAX_WORKFLOW_SOURCE_BYTES = 64 * 1024;
const MAX_NAME_LENGTH = 48;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_PHASES = 32;
const MAX_PHASE_LENGTH = 80;

export function workflowSourceHash(source: string): string {
	return createHash("sha256").update(source, "utf8").digest("hex");
}

export function normalizeWorkflowName(raw: string): string {
	const name = raw.trim().toLowerCase();
	if (!/^[a-z][a-z0-9-]{1,47}$/.test(name)) {
		throw new Error(
			`Invalid workflow name '${raw}'. Use 2-${MAX_NAME_LENGTH} lowercase characters: a-z, 0-9, and '-'; start with a letter.`,
		);
	}
	return name;
}

function positiveInteger(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new Error(`${field} must be a positive integer when provided.`);
	}
	return value;
}

function normalizePermissions(value: unknown): WorkflowPermission[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error("Workflow permissions must be a non-empty array containing 'read' and optional 'write'/'fork-context'.");
	}
	const allowed = new Set<WorkflowPermission>(["read", "write", "fork-context"]);
	const output: WorkflowPermission[] = [];
	for (const item of value) {
		if (typeof item !== "string" || !allowed.has(item as WorkflowPermission)) {
			throw new Error(`Unsupported workflow permission: ${String(item)}.`);
		}
		if (!output.includes(item as WorkflowPermission)) output.push(item as WorkflowPermission);
	}
	if (!output.includes("read")) throw new Error("Workflow permissions must include 'read'.");
	return output;
}

function normalizeSize(value: unknown, fallback: WorkflowSize): WorkflowSize {
	if (value === undefined) return fallback;
	if (value === "small" || value === "medium" || value === "large" || value === "unrestricted") return value;
	throw new Error(`Unsupported workflow size: ${String(value)}.`);
}

export function normalizeManifest(raw: unknown, defaultSize: WorkflowSize = "small"): WorkflowManifest {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("Workflow definition must be an object.");
	}
	const value = raw as Record<string, unknown>;
	const allowedKeys = new Set([
		"version",
		"name",
		"description",
		"size",
		"permissions",
		"phases",
		"maxAgents",
		"maxConcurrency",
		"timeoutMs",
	]);
	const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key) && key !== "run");
	if (unknown.length > 0) throw new Error(`Unknown workflow manifest fields: ${unknown.join(", ")}.`);
	if (value.version !== WORKFLOW_FORMAT_VERSION) {
		throw new Error(`Workflow version must be ${WORKFLOW_FORMAT_VERSION}.`);
	}
	if (typeof value.name !== "string") throw new Error("Workflow name is required.");
	const name = normalizeWorkflowName(value.name);
	if (typeof value.description !== "string" || !value.description.trim()) {
		throw new Error("Workflow description is required.");
	}
	const description = value.description.trim();
	if (description.length > MAX_DESCRIPTION_LENGTH) {
		throw new Error(`Workflow description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`);
	}
	if (!Array.isArray(value.phases) || value.phases.length === 0 || value.phases.length > MAX_PHASES) {
		throw new Error(`Workflow phases must contain 1-${MAX_PHASES} phase names.`);
	}
	const phases = value.phases.map((phase, index) => {
		if (typeof phase !== "string" || !phase.trim() || phase.trim().length > MAX_PHASE_LENGTH) {
			throw new Error(`Workflow phase ${index + 1} must be a non-empty string up to ${MAX_PHASE_LENGTH} characters.`);
		}
		return phase.trim();
	});
	if (new Set(phases).size !== phases.length) throw new Error("Workflow phase names must be unique.");
	return {
		version: WORKFLOW_FORMAT_VERSION,
		name,
		description,
		size: normalizeSize(value.size, defaultSize),
		permissions: normalizePermissions(value.permissions),
		phases,
		...(positiveInteger(value.maxAgents, "maxAgents") !== undefined
			? { maxAgents: positiveInteger(value.maxAgents, "maxAgents") }
			: {}),
		...(positiveInteger(value.maxConcurrency, "maxConcurrency") !== undefined
			? { maxConcurrency: positiveInteger(value.maxConcurrency, "maxConcurrency") }
			: {}),
		...(positiveInteger(value.timeoutMs, "timeoutMs") !== undefined
			? { timeoutMs: positiveInteger(value.timeoutMs, "timeoutMs") }
			: {}),
	};
}

export function validateWorkflowSourceSize(source: string): void {
	if (!source.trim()) throw new Error("Workflow source cannot be empty.");
	const bytes = Buffer.byteLength(source, "utf8");
	if (bytes > MAX_WORKFLOW_SOURCE_BYTES) {
		throw new Error(`Workflow source is ${bytes} bytes; maximum is ${MAX_WORKFLOW_SOURCE_BYTES}.`);
	}
	if (source.includes("\0")) throw new Error("Workflow source must not contain NUL bytes.");
	if (/[\u202A-\u202E\u2066-\u2069]/u.test(source)) {
		throw new Error("Workflow source must not contain bidirectional text-control characters.");
	}
	if (/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(source)) {
		throw new Error("Workflow source contains unsupported control characters.");
	}
}
