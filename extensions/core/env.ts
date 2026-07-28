/**
 * Shared environment markers owned by pi-subagents' child launcher.
 * Centralized so module registration gating reads one definition.
 */
export const CHILD_ENV = "PI_SUBAGENT_CHILD";
export const RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";
export const RUNTIME_HOST_ONLY_ENV = "PI_ENGINEERING_RUNTIME_HOST_ONLY";

/** True when this Pi process is a pi-subagents child session. */
export function isChildSession(): boolean {
	return process.env[CHILD_ENV] === "1";
}

/**
 * True when another bounded package needs only Pi Engineering's retained
 * pi-subagents runtime bridge. Child sessions remain normal Engineering leaves.
 */
export function isRuntimeHostOnly(): boolean {
	return process.env[RUNTIME_HOST_ONLY_ENV] === "1" && !isChildSession();
}
