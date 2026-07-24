/**
 * Pi Workbench on-disk state layout. One state root per Pi agent directory:
 *
 *   ~/.pi/agent/workbench/
 *     shipyard/runs/       run-scoped findings ledgers + launch journals
 *     shipyard/context/    reusable repository context cache
 *     teams/               Agent Teams shared state (config, tasks, mail, notes)
 *     dynamic/saved/       saved user-scope dynamic workflow definitions
 *     dynamic/drafts/      session-scoped workflow drafts
 *     dynamic/runs/        session-scoped workflow run artifacts
 *     dynamic/trust.json   exact-hash workflow trust entries
 *     writer-leases/       one-writer-per-worktree lease records
 *
 * Every location also knows its pre-unification legacy path. Reads fall back
 * to the legacy location so existing user state keeps working; writes always
 * go to the unified root. All roots derive from pi's getAgentDir() so the
 * PI_CODING_AGENT_DIR override is honored everywhere.
 */

import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function workbenchStateRoot(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "workbench");
}

// --- Shipyard ---------------------------------------------------------------

export function shipyardRunsRoot(agentDir: string = getAgentDir()): string {
	return path.join(workbenchStateRoot(agentDir), "shipyard", "runs");
}

export function legacyShipyardRunsRoot(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "shipyard-runs");
}

export function shipyardContextRoot(agentDir: string = getAgentDir()): string {
	return path.join(workbenchStateRoot(agentDir), "shipyard", "context");
}

export function legacyShipyardContextRoot(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "shipyard-context");
}

// --- Agent Teams ------------------------------------------------------------

export const TEAMS_ROOT_ENV = "PI_WORKBENCH_TEAMS_ROOT";
export const LEGACY_TEAMS_ROOT_ENV = "PI_AGENT_TEAMS_ROOT";

/** Primary teams root: env override, else the unified workbench state root. */
export function teamsStateRoot(agentDir: string = getAgentDir()): string {
	const override = process.env[TEAMS_ROOT_ENV]?.trim() || process.env[LEGACY_TEAMS_ROOT_ENV]?.trim();
	if (override) return path.resolve(override);
	return path.join(workbenchStateRoot(agentDir), "teams");
}

/** Pre-unification teams root, read as a fallback only. */
export function legacyTeamsStateRoot(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "teams");
}

// --- Dynamic Workflows ------------------------------------------------------

export function dynamicStateRoot(agentDir: string = getAgentDir()): string {
	return path.join(workbenchStateRoot(agentDir), "dynamic");
}

export interface DynamicStateRoots {
	/** Saved user-scope workflow definitions. */
	savedRoot: string;
	/** Session-scoped draft root (append the session id). */
	draftsRoot: string;
	/** Session-scoped run artifact root (append the session id). */
	runsRoot: string;
	trustPath: string;
}

export function dynamicStateRoots(agentDir: string = getAgentDir()): DynamicStateRoots {
	const root = dynamicStateRoot(agentDir);
	return {
		savedRoot: path.join(root, "saved"),
		draftsRoot: path.join(root, "drafts"),
		runsRoot: path.join(root, "runs"),
		trustPath: path.join(root, "trust.json"),
	};
}

export function legacyDynamicStateRoots(agentDir: string = getAgentDir()): DynamicStateRoots {
	return {
		savedRoot: path.join(agentDir, "workflows"),
		draftsRoot: path.join(agentDir, "workflow-drafts"),
		runsRoot: path.join(agentDir, "workflow-runs"),
		trustPath: path.join(agentDir, "workflow-trust.json"),
	};
}

// --- Writer leases ----------------------------------------------------------

export function writerLeasesRoot(agentDir: string = getAgentDir()): string {
	return path.join(workbenchStateRoot(agentDir), "writer-leases");
}
