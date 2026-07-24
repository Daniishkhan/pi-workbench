export const WORKFLOW_NAMES = ["explore", "debug", "fast", "review", "security", "ui", "compact", "deliver", "ship"] as const;

export type WorkflowName = (typeof WORKFLOW_NAMES)[number];

const WORKFLOW_NAME_SET = new Set<string>(WORKFLOW_NAMES);
const LEGACY_WORKFLOW_NAMES: Record<string, WorkflowName> = {
	"review-fast": "fast",
	"review-mesh": "review",
	"review-security": "security",
	"review-ui": "ui",
	"deliver-compact": "compact",
};

export function normalizeWorkflowName(value: string): WorkflowName | undefined {
	const normalized = value.trim().toLowerCase();
	if (WORKFLOW_NAME_SET.has(normalized)) return normalized as WorkflowName;
	return LEGACY_WORKFLOW_NAMES[normalized];
}

export function parseShipyardCommand(value: string): { workflow?: WorkflowName; mode?: string; task?: string } {
	const trimmed = value.trim();
	if (!trimmed) return {};
	const separator = trimmed.search(/\s/);
	const mode = separator === -1 ? trimmed : trimmed.slice(0, separator);
	const task = separator === -1 ? undefined : trimmed.slice(separator).trim() || undefined;
	return { workflow: normalizeWorkflowName(mode), mode, task };
}

export function completeWorkflowModes(prefix: string): WorkflowName[] | null {
	const withoutLeadingSpace = prefix.trimStart();
	if (/\s/.test(withoutLeadingSpace)) return null;
	const normalized = withoutLeadingSpace.toLowerCase();
	const matches = WORKFLOW_NAMES.filter((mode) => mode.startsWith(normalized));
	return matches.length > 0 ? [...matches] : null;
}
