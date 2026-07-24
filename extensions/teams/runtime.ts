/**
 * Shared Agent Teams runtime: registration options, session state, and the
 * small helper bag every teams submodule (identity, delivery, spawn, tools)
 * closes over. Created once per registration in index.ts.
 */

import type { EventBus, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentRpcClient } from "../core/subagent-rpc.ts";
import type { WriterCoordinator } from "../core/writer-coordinator.ts";
import {
	LEAD,
	loadConfig,
	teamDir,
	type TeamConfig,
} from "./store.ts";

export const TEAMMATE_AGENT = "pi-workbench.teams-teammate";
export const ASYNC_COMPLETE_EVENT = "subagent:async-complete";
export const ACTIVE_ENTRY = "pi-workbench:teams:active";
export const MAIL_CUSTOM_TYPE = "pi-workbench:teams:mail";
export const POLL_MS = 3_000;
export const SUMMARY_MAX = 800;
/** Lead mail delivery is batched and throttled so chatty teammates cannot
 * force a model turn every few seconds. */
export const MAIL_INJECT_MIN_INTERVAL_MS = 15_000;
export const MAIL_INJECT_MAX_MESSAGES = 20;
/** A running member whose run artifacts are entirely missing for this long is
 * marked failed: the process was lost or the OS cleaned the temp dir (reboot). */
export const LOST_RUN_GRACE_MS = 10 * 60_000;

export interface TeamsState {
	activeTeam?: string;
	currentSessionId?: string;
	poller?: ReturnType<typeof setInterval>;
	rpc: SubagentRpcClient | null;
	lastMailInjectAt: number;
	/** Cached pi-subagents temp root (pi-subagents-<scope>) once located. */
	tempScopeDir?: string | null;
	/** Set when the session is shutting down; blocks late poller starts. */
	sessionEnded?: boolean;
}

export interface RegisterTeamsOptions {
	writerCoordinator?: WriterCoordinator;
	rpc?: SubagentRpcClient;
	/** Test/embedded-host override. Production registration derives this from PI_SUBAGENT_CHILD. */
	childSession?: boolean;
	/** Test/embedded-host override. Production registration derives this from PI_SUBAGENT_RUN_ID. */
	runId?: string;
}

export interface TeamsRuntime {
	pi: ExtensionAPI;
	events: EventBus;
	options: RegisterTeamsOptions;
	isChildSession: boolean;
	state: TeamsState;
	requireRpc(): SubagentRpcClient;
	activeTeamDir(assertedTeam?: string): { name: string; dir: string; config: TeamConfig };
	requireOpenTeam(config: TeamConfig, action: string, caller?: string): void;
	inject(textBody: string): void;
}

export function createTeamsRuntime(pi: ExtensionAPI, options: RegisterTeamsOptions, isChildSession: boolean): TeamsRuntime {
	const runtime: TeamsRuntime = {
		pi,
		events: pi.events,
		options,
		isChildSession,
		state: { rpc: options.rpc ?? null, lastMailInjectAt: 0 },

		requireRpc(): SubagentRpcClient {
			if (!runtime.state.rpc) throw new Error("Agent Teams spawning requires the shared Pi Workbench RPC client.");
			return runtime.state.rpc;
		},

		activeTeamDir(assertedTeam?: string): { name: string; dir: string; config: TeamConfig } {
			const name = runtime.state.activeTeam;
			if (!name) throw new Error("No active team. Start one through /workbench team <goal> or workbench_route, which will use team_create.");
			if (assertedTeam && assertedTeam !== name) {
				throw new Error(`Team assertion '${assertedTeam}' does not match this session's active team '${name}'.`);
			}
			const dir = teamDir(name);
			const config = loadConfig(dir);
			if (!runtime.state.currentSessionId || config.leadSessionId !== runtime.state.currentSessionId) {
				throw new Error(`Pi session '${runtime.state.currentSessionId ?? "unknown"}' is not the registered lead for team '${name}'.`);
			}
			return { name, dir, config };
		},

		requireOpenTeam(config: TeamConfig, action: string, caller?: string): void {
			if (config.closed || config.closing) {
				throw new Error(`Team '${config.name}' is ${config.closed ? "closed" : "closing"}; cannot ${action}.`);
			}
			if (caller && caller !== LEAD) {
				const member = config.members.find((candidate) => candidate.name === caller);
				if (!member || member.status !== "running") {
					throw new Error(`Teammate '${caller}' is ${member?.status ?? "unregistered"}; cannot ${action}.`);
				}
			}
		},

		inject(textBody: string): void {
			try {
				pi.sendMessage(
					{ customType: MAIL_CUSTOM_TYPE, content: textBody, display: true },
					{ triggerTurn: true, deliverAs: "steer" },
				);
			} catch {
				// Non-interactive modes may reject turn triggering; the message is
				// still visible in the transcript on the next natural turn.
				try {
					pi.sendMessage({ customType: MAIL_CUSTOM_TYPE, content: textBody, display: true });
				} catch {
					// Give up quietly; mail remains in the inbox file.
				}
			}
		},
	};
	return runtime;
}
