/**
 * Lead-side and teammate-side delivery: the mail poller, completion detection
 * against pi-subagents' documented lifecycle artifacts, and member-status
 * reconciliation. All callbacks are best-effort: delivery must never break
 * the hosting session.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isConfirmedTerminalRunArtifact, runIdFromAsyncComplete } from "../core/run-lifecycle.ts";
import {
	ACTIVE_ENTRY,
	LOST_RUN_GRACE_MS,
	MAIL_INJECT_MAX_MESSAGES,
	MAIL_INJECT_MIN_INTERVAL_MS,
	POLL_MS,
	SUMMARY_MAX,
	type TeamsRuntime,
} from "./runtime.ts";
import {
	advanceCursor,
	LEAD,
	loadConfig,
	readInbox,
	teamDir,
	updateConfig,
	type TeamConfig,
	type TeamMember,
	type TeamMessage,
} from "./store.ts";

export interface TeamsDelivery {
	startPoller(): void;
	stopPoller(): void;
	handleAsyncComplete(payload: unknown): void;
	/** Mid-flight teammate mail delivery (child sessions only). */
	deliverTeammateMail(memberName: string, dir: string): void;
	isActiveMemberStatus(status: TeamMember["status"]): boolean;
}

function isActiveMemberStatus(status: TeamMember["status"]): boolean {
	return status === "running" || status === "stopping";
}

function mapTerminalStatus(raw: unknown): TeamMember["status"] {
	const value = String(raw ?? "").toLowerCase();
	if (["failed", "error", "timed_out", "timeout"].some((s) => value.includes(s))) return "failed";
	if (["stopped", "cancelled", "canceled", "aborted"].some((s) => value.includes(s))) return "stopped";
	return "idle";
}

export function createTeamsDelivery(runtime: TeamsRuntime): TeamsDelivery {
	const { state } = runtime;

	function formatMail(header: string, footer: string, messages: TeamMessage[], extra = 0): string {
		const lines = messages.map((m) => {
			const time = new Date(m.ts).toLocaleTimeString();
			return `- [${m.from} · ${time}] ${m.message}`;
		});
		return [header, ...lines, "", footer].join("\n");
	}

	function stopPoller(): void {
		if (state.poller) {
			clearInterval(state.poller);
			state.poller = undefined;
		}
	}

	function startPoller(): void {
		if (state.poller || !state.activeTeam) return;
		state.poller = setInterval(() => {
			try {
				if (!state.activeTeam) return stopPoller();
				const dir = teamDir(state.activeTeam);
				const config = loadConfig(dir);
				if (config.closed) return stopPoller();
				// Reconcile member statuses against pi-subagents' documented
				// lifecycle artifacts (safety net for the event fast path).
				reconcileActiveMembers(dir, config);
				if (!state.activeTeam) return;
				// Throttled, capped mail delivery so chatty teammates cannot
				// force a lead model turn every poll tick.
				const now = Date.now();
				if (now - state.lastMailInjectAt < MAIL_INJECT_MIN_INTERVAL_MS) return;
				const unread = readInbox(dir, LEAD, false);
				if (unread.length === 0) return;
				const batch = unread.slice(0, MAIL_INJECT_MAX_MESSAGES);
				const extra = unread.length - batch.length;
				runtime.inject(formatMail(
					`📬 Team mail (${batch.length} shown${extra > 0 ? `, +${extra} more queued` : ""}):`,
					"You are the team lead. Reply, unblock teammates, assign tasks (team_tasks), or synthesize finished work.",
					batch,
					extra,
				));
				state.lastMailInjectAt = now;
				advanceCursor(dir, LEAD, batch[batch.length - 1]!.ts);
			} catch {
				// Transient filesystem races are fine; try again next tick.
			}
		}, POLL_MS);
		state.poller.unref?.();
	}

	/** Deliver a teammate's unread mail mid-flight (child sessions only). */
	function deliverTeammateMail(memberName: string, dir: string): void {
		const unread = readInbox(dir, memberName, false);
		if (unread.length === 0) return;
		runtime.inject(formatMail(
			`📬 Team mail for '${memberName}' (${unread.length} new):`,
			"Act on this mail if it changes your plan, then continue your task. Reply with team_send.",
			unread,
		));
		advanceCursor(dir, memberName, unread[unread.length - 1]!.ts);
	}

	// -----------------------------------------------------------------------
	// Completion detection: documented lifecycle artifacts + event fast path
	// -----------------------------------------------------------------------

	/** Locate pi-subagents' temp scope dir (pi-subagents-<scope>) holding a run's artifacts. */
	function findRunArtifacts(runId: string): { statusFile?: string; resultFile?: string } {
		const candidates: string[] = [];
		if (state.tempScopeDir) {
			candidates.push(state.tempScopeDir);
		} else {
			try {
				for (const entry of fs.readdirSync(os.tmpdir())) {
					if (entry.startsWith("pi-subagents-")) candidates.push(path.join(os.tmpdir(), entry));
				}
			} catch {
				return {};
			}
		}
		for (const root of candidates) {
			const statusFile = path.join(root, "async-subagent-runs", runId, "status.json");
			const resultFile = path.join(root, "async-subagent-results", `${runId}.json`);
			const hasStatus = fs.existsSync(statusFile);
			const hasResult = fs.existsSync(resultFile);
			if (hasStatus || hasResult) {
				state.tempScopeDir = root;
				return { ...(hasStatus ? { statusFile } : {}), ...(hasResult ? { resultFile } : {}) };
			}
		}
		return {};
	}

	/** Read a run's state from pi-subagents' documented status/result JSON artifacts. */
	function readRunState(runId: string): { state: string; summary: string; confirmedTerminal: boolean } | null {
		try {
			const { statusFile, resultFile } = findRunArtifacts(runId);
			if (resultFile) {
				// The result file only exists once a run has finished.
				try {
					const result = JSON.parse(fs.readFileSync(resultFile, "utf8")) as Record<string, unknown>;
					const first = Array.isArray(result.results) && result.results.length > 0
						? (result.results[0] as Record<string, unknown>)
						: result;
					const runState = String(first.status ?? first.state ?? result.status ?? result.state ?? "complete");
					return {
						state: runState,
						summary: String(first.summary ?? result.summary ?? "").trim(),
						confirmedTerminal: isConfirmedTerminalRunArtifact(runState, true),
					};
				} catch {
					// Fall through to the status file.
				}
			}
			if (statusFile) {
				const status = JSON.parse(fs.readFileSync(statusFile, "utf8")) as Record<string, unknown>;
				const steps = Array.isArray(status.steps) ? (status.steps as Array<Record<string, unknown>>) : [];
				const runState = String(status.state ?? "");
				return {
					state: runState,
					summary: String(steps[0]?.summary ?? "").trim(),
					confirmedTerminal: isConfirmedTerminalRunArtifact(runState, false, status.endedAt),
				};
			}
			return null;
		} catch {
			return null;
		}
	}

	function finalizeClosingTeam(dir: string): void {
		const finalized = updateConfig(dir, (cfg) => {
			if (!cfg.closing || cfg.members.some((member) => isActiveMemberStatus(member.status))) return null;
			cfg.closing = false;
			cfg.closed = true;
			return cfg.name;
		});
		if (!finalized || state.activeTeam !== finalized) return;
		state.activeTeam = undefined;
		stopPoller();
		runtime.pi.appendEntry(ACTIVE_ENTRY, { team: null });
	}

	/** Record a teammate's terminal state exactly once and notify the lead. */
	function recordCompletion(dir: string, runId: string, status: TeamMember["status"], summary: string): void {
		runtime.options.writerCoordinator?.releaseRun(runId);
		const memberName = updateConfig(dir, (cfg) => {
			const target = cfg.members.find((m) => m.runId === runId);
			if (!target || !isActiveMemberStatus(target.status)) return null; // Already recorded.
			target.status = status;
			target.endedAt = Date.now();
			target.lastSummary = summary || undefined;
			return target.name;
		});
		finalizeClosingTeam(dir);
		if (!memberName) return;
		const icon = status === "idle" ? "✅" : status === "failed" ? "❌" : "⏹️";
		runtime.inject([
			`${icon} Teammate '${memberName}' finished (${status}).`,
			summary ? `Report: ${summary}` : "No final report was captured.",
			"",
			"Use team_status for the roster, team_inbox for mail, and team_spawn to give a teammate more work.",
		].join("\n"));
	}

	/** Poll documented run artifacts for teammates whose completion event was missed. */
	function reconcileActiveMembers(dir: string, config: TeamConfig): void {
		for (const member of config.members) {
			if (!isActiveMemberStatus(member.status) || !member.runId) continue;
			const runState = readRunState(member.runId);
			if (!runState) {
				// A never-stopped running process with missing artifacts is treated as
				// lost after a generous grace period. A stop-acknowledged process stays
				// nonterminal until an authoritative completion artifact arrives.
				if (member.status === "running" && Date.now() - member.spawnedAt > LOST_RUN_GRACE_MS) {
					recordCompletion(dir, member.runId, "failed", "Run artifacts are missing (process lost or temp dir cleaned); marked failed by the reconciler. Respawn to continue.");
				}
				continue;
			}
			if (!runState.confirmedTerminal) continue;
			recordCompletion(dir, member.runId, mapTerminalStatus(runState.state), runState.summary.slice(0, SUMMARY_MAX));
		}
	}

	function completionSummary(payload: Record<string, unknown>): { status: TeamMember["status"]; summary: string } {
		const first = Array.isArray(payload.results) && payload.results.length > 0
			? (payload.results[0] as Record<string, unknown>)
			: payload;
		const rawStatus = first.status ?? first.state ?? payload.status ?? payload.state;
		const rawSummary = first.summary ?? first.output ?? payload.summary ?? payload.output ?? "";
		const summary = String(typeof rawSummary === "string" ? rawSummary : JSON.stringify(rawSummary)).trim();
		return {
			status: mapTerminalStatus(rawStatus),
			summary: summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX)}…` : summary,
		};
	}

	function handleAsyncComplete(payload: unknown): void {
		try {
			if (!state.activeTeam) return;
			const runId = runIdFromAsyncComplete(payload);
			if (!runId) return;
			const dir = teamDir(state.activeTeam);
			const config = loadConfig(dir);
			if (!config.members.some((m) => m.runId === runId)) return; // Not one of ours (e.g. a Shipyard or ad-hoc run).
			const { status, summary } = completionSummary(payload as Record<string, unknown>);
			recordCompletion(dir, runId, status, summary);
		} catch {
			// Completion handling must never break the session.
		}
	}

	return {
		startPoller,
		stopPoller,
		handleAsyncComplete,
		deliverTeammateMail,
		isActiveMemberStatus,
	};
}
