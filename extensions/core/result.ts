/** Shared tool-result helpers so every Workbench tool returns one shape. */

export interface TextToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

export function textResult(text: string, details: Record<string, unknown> = {}): TextToolResult {
	return { content: [{ type: "text" as const, text }], details };
}

/** String results stay readable; structured results are JSON for the model and
 * mirrored into details for renderers and follow-up tooling. */
export function dataResult(value: unknown): TextToolResult {
	const isString = typeof value === "string";
	return {
		content: [{ type: "text" as const, text: isString ? value : JSON.stringify(value, null, 2) }],
		details: isString ? { message: value } : (value as Record<string, unknown>),
	};
}
