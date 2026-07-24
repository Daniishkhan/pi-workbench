/**
 * Shared environment markers owned by pi-subagents' child launcher.
 * Centralized so module registration gating reads one definition.
 */
export const CHILD_ENV = "PI_SUBAGENT_CHILD";
export const RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";

/** True when this Pi process is a pi-subagents child session. */
export function isChildSession(): boolean {
	return process.env[CHILD_ENV] === "1";
}
