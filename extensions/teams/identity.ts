/**
 * Caller identity for Agent Teams: the registered lead (parent session) or a
 * teammate child session authenticated by its pi-subagents run id. Optional
 * identity fields are assertions only — they can never select a caller.
 */

import { RUN_ID_ENV } from "../core/env.ts";
import { findMemberByRunId, LEAD, loadConfig, type MemberIdentity, type TeamConfig } from "./store.ts";
import type { TeamsRuntime } from "./runtime.ts";

export interface CallerIdentity {
	team: string;
	dir: string;
	member: string;
	config: TeamConfig;
}

export interface TeamsIdentity {
	findOwnIdentity(): Promise<MemberIdentity | null>;
	resolveCaller(identity?: { team?: string; member?: string }): Promise<CallerIdentity>;
}

export function createTeamsIdentity(runtime: TeamsRuntime, runIdOverride?: string): TeamsIdentity {
	/** Resolve this child session's team membership from its run id, with a
	 * short retry: the lead writes the runId into the team config after the
	 * spawn RPC reply, which can land after this process started. */
	async function findOwnIdentity(): Promise<MemberIdentity | null> {
		const runId = runIdOverride?.trim() || process.env[RUN_ID_ENV]?.trim();
		if (!runId) return null;
		for (let attempt = 0; attempt < 8; attempt++) {
			const found = findMemberByRunId(runId);
			if (found) return found;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		return null;
	}

	/** Who is calling: the registered lead or a teammate authenticated by run id. */
	async function resolveCaller(identity?: { team?: string; member?: string }): Promise<CallerIdentity> {
		if (!runtime.isChildSession) {
			const { name, dir, config } = runtime.activeTeamDir(identity?.team);
			if (identity?.member && identity.member !== LEAD) {
				throw new Error(`Lead identity assertion must be '${LEAD}', not '${identity.member}'.`);
			}
			return { team: name, dir, member: LEAD, config };
		}
		const found = await findOwnIdentity();
		if (!found) {
			throw new Error("This child session is not a registered team teammate: PI_SUBAGENT_RUN_ID does not match any team member.");
		}
		if (found.member.name === LEAD || found.member.name === "all") {
			throw new Error(`Reserved legacy member '${found.member.name}' cannot authenticate as a teammate.`);
		}
		if (identity?.team && identity.team !== found.team) {
			throw new Error(`Team assertion '${identity.team}' does not match the run-id identity '${found.team}/${found.member.name}'.`);
		}
		if (identity?.member && identity.member !== found.member.name) {
			throw new Error(`Member assertion '${identity.member}' does not match the run-id identity '${found.team}/${found.member.name}'.`);
		}
		const config = loadConfig(found.dir);
		return { team: found.team, dir: found.dir, member: found.member.name, config };
	}

	return { findOwnIdentity, resolveCaller };
}
