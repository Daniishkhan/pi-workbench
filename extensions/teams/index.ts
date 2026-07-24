/**
 * pi-agent-teams — agent teams for Pi.
 *
 * One session acts as the team lead. It spawns teammates as independent
 * pi-subagents async runs. Teammates coordinate through a shared team
 * directory (config, task list, mailboxes, notes) instead of only reporting
 * back to the parent. pi-subagents owns process lifecycle; this extension
 * owns team state, messaging, and lead-side delivery.
 *
 * Registration is environment-gated:
 * - Lead sessions (normal Pi): all team tools + /team command + mail poller.
 * - Child sessions (PI_SUBAGENT_CHILD set by pi-subagents): only the
 *   teammate-safe tools; identity resolves from PI_SUBAGENT_RUN_ID.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import { resolveTeamAgentCapability } from "../core/role-policy.ts";
import type { SubagentRpcClient } from "../core/subagent-rpc.ts";
import type { WriterCoordinator } from "../core/writer-coordinator.ts";
import { runIdFromSpawnReply, type RpcEventBus } from "./rpc.ts";
import {
	LEAD,
	advanceCursor,
	appendNote,
	claimNextTask,
	claimTask,
	completeTask,
	createTask,
	createTeam,
	decorateTasks,
	findMemberByRunId,
	listTasks,
	listTeamNames,
	loadConfig,
	readInbox,
	readNotes,
	sanitizeMemberName,
	sanitizeName,
	sendMessage,
	teamDir,
	updateConfig,
	updateTask,
	type MemberIdentity,
	type TeamConfig,
	type TeamMember,
	type TeamMessage,
} from "./store.ts";

const TEAMMATE_AGENT = "pi-agent-teams.teammate";
const CHILD_ENV = "PI_SUBAGENT_CHILD";
const RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";
const ASYNC_COMPLETE_EVENT = "subagent:async-complete";
const ACTIVE_ENTRY = "pi-agent-teams:active";
const MAIL_CUSTOM_TYPE = "pi-agent-teams";
const POLL_MS = 3_000;
const SUMMARY_MAX = 800;
/** Lead mail delivery is batched and throttled so chatty teammates cannot
 * force a model turn every few seconds. */
const MAIL_INJECT_MIN_INTERVAL_MS = 15_000;
const MAIL_INJECT_MAX_MESSAGES = 20;
/** Terminal states in pi-subagents' documented status.json lifecycle artifact. */
const TERMINAL_RUN_STATES = new Set(["complete", "completed", "failed", "stopped", "timed_out", "timeout"]);

/** status.json may advertise stopped/failed as soon as cancellation begins.
 * A terminal state is authoritative only once the runner writes endedAt or the
 * separate result artifact exists. */
export function isConfirmedTerminalRunArtifact(state: string, hasResult: boolean, endedAt?: unknown): boolean {
	return TERMINAL_RUN_STATES.has(state) && (hasResult || (typeof endedAt === "number" && Number.isFinite(endedAt) && endedAt > 0));
}
/** A running member whose run artifacts are entirely missing for this long is
 * marked failed: the process was lost or the OS cleaned the temp dir (reboot). */
const LOST_RUN_GRACE_MS = 10 * 60_000;

interface TeamsState {
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

export default function registerTeams(pi: ExtensionAPI, options: RegisterTeamsOptions = {}) {
	const events = (pi as unknown as { events: RpcEventBus }).events;
	const isChildSession = options.childSession ?? Boolean(process.env[CHILD_ENV]);
	const state: TeamsState = { rpc: options.rpc ?? null, lastMailInjectAt: 0 };

	// -----------------------------------------------------------------------
	// Small helpers
	// -----------------------------------------------------------------------

	function text(value: unknown): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
		const isString = typeof value === "string";
		return {
			content: [{ type: "text", text: isString ? value : JSON.stringify(value, null, 2) }],
			details: isString ? { message: value } : (value as Record<string, unknown>),
		};
	}

	function requireRpc(): SubagentRpcClient {
		if (!state.rpc) throw new Error("Agent Teams spawning requires the shared Pi Workbench RPC client.");
		return state.rpc;
	}

	function isActiveMemberStatus(status: TeamMember["status"]): boolean {
		return status === "running" || status === "stopping";
	}

	function activeTeamDir(assertedTeam?: string): { name: string; dir: string; config: TeamConfig } {
		const name = state.activeTeam;
		if (!name) throw new Error("No active team. Create one with team_create (or /team new <goal>).");
		if (assertedTeam && assertedTeam !== name) {
			throw new Error(`Team assertion '${assertedTeam}' does not match this session's active team '${name}'.`);
		}
		const dir = teamDir(name);
		const config = loadConfig(dir);
		if (!state.currentSessionId || config.leadSessionId !== state.currentSessionId) {
			throw new Error(`Pi session '${state.currentSessionId ?? "unknown"}' is not the registered lead for team '${name}'.`);
		}
		return { name, dir, config };
	}

	function requireOpenTeam(config: TeamConfig, action: string, caller?: string): void {
		if (config.closed || config.closing) {
			throw new Error(`Team '${config.name}' is ${config.closed ? "closed" : "closing"}; cannot ${action}.`);
		}
		if (caller && caller !== LEAD) {
			const member = config.members.find((candidate) => candidate.name === caller);
			if (!member || member.status !== "running") {
				throw new Error(`Teammate '${caller}' is ${member?.status ?? "unregistered"}; cannot ${action}.`);
			}
		}
	}

	/** Resolve this child session's team membership from its run id, with a
	 * short retry: the lead writes the runId into the team config after the
	 * spawn RPC reply, which can land after this process started. */
	async function findOwnIdentity(): Promise<MemberIdentity | null> {
		const runId = options.runId?.trim() || process.env[RUN_ID_ENV]?.trim();
		if (!runId) return null;
		for (let attempt = 0; attempt < 8; attempt++) {
			const found = findMemberByRunId(runId);
			if (found) return found;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		return null;
	}

	/** Who is calling: the registered lead or a teammate authenticated by run id.
	 * Optional identity fields are assertions only and can never select a caller. */
	async function resolveCaller(identity?: { team?: string; member?: string }): Promise<{ team: string; dir: string; member: string; config: TeamConfig }> {
		if (!isChildSession) {
			const { name, dir, config } = activeTeamDir(identity?.team);
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

	function inject(textBody: string): void {
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
	}

	// -----------------------------------------------------------------------
	// Lead-side delivery: mail poller + completion notifications
	// -----------------------------------------------------------------------

	function formatMail(messages: TeamMessage[], extra = 0): string {
		const lines = messages.map((m) => {
			const time = new Date(m.ts).toLocaleTimeString();
			return `- [${m.from} · ${time}] ${m.message}`;
		});
		return [
			`📬 Team mail (${messages.length} shown${extra > 0 ? `, +${extra} more queued` : ""}):`,
			...lines,
			"",
			"You are the team lead. Reply, unblock teammates, assign tasks (team_tasks), or synthesize finished work.",
		].join("\n");
	}

	function formatTeammateMail(memberName: string, messages: TeamMessage[]): string {
		const lines = messages.map((m) => {
			const time = new Date(m.ts).toLocaleTimeString();
			return `- [${m.from} · ${time}] ${m.message}`;
		});
		return [
			`📬 Team mail for '${memberName}' (${messages.length} new):`,
			...lines,
			"",
			"Act on this mail if it changes your plan, then continue your task. Reply with team_send.",
		].join("\n");
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
				inject(formatMail(batch, extra));
				state.lastMailInjectAt = now;
				advanceCursor(dir, LEAD, batch[batch.length - 1]!.ts);
			} catch {
				// Transient filesystem races are fine; try again next tick.
			}
		}, POLL_MS);
		state.poller.unref?.();
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
		pi.appendEntry(ACTIVE_ENTRY, { team: null });
	}

	/** Record a teammate's terminal state exactly once and notify the lead. */
	function recordCompletion(dir: string, runId: string, status: TeamMember["status"], summary: string): void {
		options.writerCoordinator?.releaseRun(runId);
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
		inject([
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

	function mapTerminalStatus(raw: unknown): TeamMember["status"] {
		const value = String(raw ?? "").toLowerCase();
		if (["failed", "error", "timed_out", "timeout"].some((s) => value.includes(s))) return "failed";
		if (["stopped", "cancelled", "canceled", "aborted"].some((s) => value.includes(s))) return "stopped";
		return "idle";
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
			if (!state.activeTeam || !payload || typeof payload !== "object") return;
			const runId = (payload as Record<string, unknown>).runId;
			if (typeof runId !== "string" || !runId) return;
			const dir = teamDir(state.activeTeam);
			const config = loadConfig(dir);
			if (!config.members.some((m) => m.runId === runId)) return; // Not one of ours (e.g. a Shipyard or ad-hoc run).
			const { status, summary } = completionSummary(payload as Record<string, unknown>);
			recordCompletion(dir, runId, status, summary);
		} catch {
			// Completion handling must never break the session.
		}
	}

	// -----------------------------------------------------------------------
	// Spawning
	// -----------------------------------------------------------------------

	function buildTeammatePrompt(input: { team: string; dir: string; member: string; role: string; task: string; respawn: boolean }): string {
		return [
			`You are '${input.member}', a teammate on Agent Team '${input.team}'.`,
			`Team directory: ${input.dir}`,
			`Your role: ${input.role}`,
			"",
			"## Team protocol",
			"- You are an independent teammate, not a report-back subagent. Coordinate with the lead and peers through team tools.",
			"- Your identity is authenticated automatically from PI_SUBAGENT_RUN_ID. Omit team/member assertions unless diagnosing a mismatch; assertions can never change your identity.",
			"- Start by calling team_inbox() and team_tasks({action:\"list\"}) to see messages and available work.",
			"- Claim work with team_tasks({action:\"claim\", id}) or team_tasks({action:\"next\"}); complete it with team_tasks({action:\"complete\", id}).",
			"- Message the lead with team_send({to:\"lead\", message}) and peers with team_send({to:\"<member>\", message}). Broadcast with to:\"all\".",
			"- Check team_inbox periodically — always before a major decision and before you finish.",
			"- Record durable progress with team_notes({action:\"append\", content}) so a future spawn of you can resume context.",
			input.respawn ? `- This is a respawn. Read your previous notes first: team_notes({action:\"read\"}).` : "",
			"- Do not edit files another teammate owns without coordinating first (see your role/task).",
			"- Do not launch subagents or teams. You are a leaf worker.",
			"- Before finishing: send key results to the lead via team_send({to:\"lead\", ...}), update your tasks, append notes. Your final message is a concise report: what you did, evidence, open issues.",
			"",
			"## Your task",
			input.task,
		].filter(Boolean).join("\n");
	}

	async function spawnTeammate(
		ctx: ExtensionContext,
		input: { name: string; role: string; task: string; model?: string; agent?: string; write?: boolean },
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const { name: team, dir, config } = activeTeamDir();
		requireOpenTeam(config, "spawn a teammate", LEAD);
		const memberName = sanitizeMemberName(input.name);
		const agent = input.agent?.trim() || TEAMMATE_AGENT;
		const existing = config.members.find((m) => m.name === memberName);
		if (existing && isActiveMemberStatus(existing.status)) {
			throw new Error(`Teammate '${memberName}' is ${existing.status}. Wait for terminal completion before respawning it.`);
		}
		const respawn = Boolean(existing);
		const writeCapable = resolveTeamAgentCapability(agent, input.write) === "writer";
		if (writeCapable && !options.writerCoordinator) {
			throw new Error("Write-capable Agent Teams spawning requires the shared Workbench writer coordinator.");
		}
		const writerLease = writeCapable ? options.writerCoordinator!.acquire(ctx.cwd, `team:${team}/${memberName}`) : undefined;
		const prompt = buildTeammatePrompt({ team, dir, member: memberName, role: input.role, task: input.task, respawn });

		const ping = await requireRpc().request("ping", {}, signal).catch((error) => {
			options.writerCoordinator?.release(writerLease?.token);
			throw error;
		});
		if (!ping.success) {
			options.writerCoordinator?.release(writerLease?.token);
			throw new Error(`pi-subagents RPC unavailable: ${ping.error?.message ?? "ping failed"}. Is pi-subagents installed?`);
		}
		const reply = await requireRpc().request("spawn", {
			agent,
			task: prompt,
			cwd: ctx.cwd,
			context: "fresh",
			async: true,
			clarify: false,
			artifacts: true,
			...(input.model ? { model: input.model } : {}),
		}, signal).catch((error) => {
			options.writerCoordinator?.markUncertain(writerLease?.token);
			throw error;
		});
		if (!reply.success) {
			options.writerCoordinator?.release(writerLease?.token);
			throw new Error(`Spawn failed: ${reply.error?.message ?? "unknown RPC error"}`);
		}
		const runId = runIdFromSpawnReply(reply);
		if (!runId) {
			options.writerCoordinator?.markUncertain(writerLease?.token);
			throw new Error(
				"Spawn was accepted without a run id. Refusing to register an unauthenticated teammate; inspect the pi-subagents fleet before releasing any retained writer lease.",
			);
		}
		if (writerLease) options.writerCoordinator?.attachRun(writerLease.token, runId);
		const now = Date.now();
		updateConfig(dir, (cfg) => {
			const member = cfg.members.find((m) => m.name === memberName);
			if (member) {
				member.role = input.role;
				member.task = input.task;
				member.agent = agent;
				member.runId = runId;
				member.status = "running";
				member.spawns += 1;
				member.spawnedAt = now;
				member.endedAt = undefined;
				member.lastSummary = undefined;
				member.model = input.model;
			} else {
				cfg.members.push({
					name: memberName,
					role: input.role,
					task: input.task,
					agent,
					runId,
					status: "running",
					spawns: 1,
					spawnedAt: now,
					model: input.model,
				});
			}
		});
		startPoller();
		return {
			team,
			member: memberName,
			runId,
			respawn,
			status: "running",
			writeCapable,
			hint: `Teammate '${memberName}' launched in the background. You will be notified on completion; mail arrives automatically.`,
		};
	}

	// -----------------------------------------------------------------------
	// Tool registration — teammate-safe tools (lead + teammates)
	// -----------------------------------------------------------------------

	const IdentityParams = {
		team: Type.Optional(Type.String({ description: "Optional team identity assertion. It must match the active lead team or the caller's run-id identity." })),
		member: Type.Optional(Type.String({ description: "Optional caller identity assertion. It must match 'lead' or the caller's run-id identity." })),
	};

	pi.registerTool({
		name: "team_send",
		label: "Team Send",
		description: "Send a message to a teammate's mailbox, to the lead (to=\"lead\"), or broadcast (to=\"all\"). Mail to an idle teammate is read when it next spawns or checks its inbox.",
		promptSnippet: "Message the lead or a teammate on the agent team",
		parameters: Type.Object({
			to: Type.String({ description: "Recipient: a member name, \"lead\", or \"all\"." }),
			message: Type.String({ description: "Message text." }),
			...IdentityParams,
		}),
		async execute(_id, params) {
			const caller = await resolveCaller(params);
			const config = caller.config;
			requireOpenTeam(config, "send team mail", caller.member);
			const to = params.to.trim();
			if (to !== LEAD && to !== "all" && !config.members.some((m) => m.name === to)) {
				throw new Error(`Unknown recipient '${to}'. Members: ${config.members.map((m) => m.name).join(", ") || "(none)"}, lead, all.`);
			}
			const delivered = sendMessage(caller.dir, caller.member, to, params.message, config.members.map((m) => m.name));
			const note = to !== LEAD && to !== "all"
				? (config.members.find((m) => m.name === to)?.status !== "running" ? ` '${to}' is not currently running; it will read this on its next spawn.` : "")
				: "";
			return text(`Message sent to ${delivered.join(", ")}.${note}`);
		},
	});

	pi.registerTool({
		name: "team_inbox",
		label: "Team Inbox",
		description: "Read new messages from your mailbox (lead reads the lead mailbox). Messages are marked read by default.",
		promptSnippet: "Check your team mailbox",
		parameters: Type.Object({
			markRead: Type.Optional(Type.Boolean({ description: "Mark returned messages as read (default true)." })),
			...IdentityParams,
		}),
		async execute(_id, params) {
			const caller = await resolveCaller(params);
			const markRead = params.markRead ?? true;
			if (markRead) requireOpenTeam(caller.config, "advance the inbox cursor", caller.member);
			const messages = readInbox(caller.dir, caller.member, markRead);
			if (messages.length === 0) return text(`No new mail for ${caller.member}.`);
			return text({
				unread: messages.length,
				messages: messages.map((m) => ({ from: m.from, at: new Date(m.ts).toISOString(), message: m.message })),
			});
		},
	});

	pi.registerTool({
		name: "team_tasks",
		label: "Team Tasks",
		description: "Manage the team's shared task list: create, list, update, claim, next (claim first available), or complete tasks. Tasks can depend on other tasks; blocked tasks cannot be claimed.",
		promptSnippet: "Create, claim, and update shared team tasks",
		parameters: Type.Object({
			action: StringEnum(["create", "list", "update", "claim", "next", "complete"] as const),
			id: Type.Optional(Type.String({ description: "Task id, e.g. t1 (for update/claim/complete)." })),
			title: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()),
			deps: Type.Optional(Type.Array(Type.String(), { description: "Task ids that must complete first." })),
			status: Type.Optional(StringEnum(["pending", "in_progress", "completed"] as const)),
			...IdentityParams,
		}),
		async execute(_id, params) {
			const caller = await resolveCaller(params);
			if (params.action !== "list") requireOpenTeam(caller.config, `perform task action '${params.action}'`, caller.member);
			switch (params.action) {
				case "create": {
					if (!params.title) throw new Error("team_tasks create requires title.");
					const task = createTask(caller.dir, { title: params.title, description: params.description, deps: params.deps, createdBy: caller.member });
					return text(task);
				}
				case "list":
					return text({ tasks: decorateTasks(listTasks(caller.dir)) });
				case "update": {
					if (!params.id) throw new Error("team_tasks update requires id.");
					return text(updateTask(caller.dir, params.id, caller.member, { title: params.title, description: params.description, status: params.status, deps: params.deps }));
				}
				case "claim": {
					if (!params.id) throw new Error("team_tasks claim requires id.");
					return text(claimTask(caller.dir, params.id, caller.member));
				}
				case "next": {
					const task = claimNextTask(caller.dir, caller.member);
					return task ? text(task) : text("No unclaimed, unblocked tasks available.");
				}
				case "complete": {
					if (!params.id) throw new Error("team_tasks complete requires id.");
					return text(completeTask(caller.dir, params.id, caller.member));
				}
			}
		},
	});

	pi.registerTool({
		name: "team_peers",
		label: "Team Peers",
		description: "List team members with their role, status, and current task.",
		promptSnippet: "See who is on the team",
		parameters: Type.Object({ ...IdentityParams }),
		async execute(_id, params) {
			const caller = await resolveCaller(params);
			const members = caller.config.members.map((m) => ({
				name: m.name,
				role: m.role,
				status: m.status,
				task: m.task,
				spawns: m.spawns,
				lastSummary: m.lastSummary,
			}));
			return text({ team: caller.team, goal: caller.config.goal, closing: caller.config.closing ?? false, closed: caller.config.closed, you: caller.member, members });
		},
	});

	pi.registerTool({
		name: "team_status",
		label: "Team Status",
		description: "Team overview: roster, shared tasks with blockers, and unread mail counts.",
		promptSnippet: "Show team roster, tasks, and mail",
		parameters: Type.Object({ ...IdentityParams }),
		async execute(_id, params) {
			const caller = await resolveCaller(params);
			const unread: Record<string, number> = {};
			for (const m of caller.config.members) unread[m.name] = readInbox(caller.dir, m.name, false).length;
			unread[LEAD] = readInbox(caller.dir, LEAD, false).length;
			return text({
				team: caller.team,
				goal: caller.config.goal,
				closing: caller.config.closing ?? false,
				closed: caller.config.closed,
				you: caller.member,
				members: caller.config.members.map((m) => ({ name: m.name, role: m.role, status: m.status, spawns: m.spawns })),
				tasks: decorateTasks(listTasks(caller.dir)),
				unread,
			});
		},
	});

	pi.registerTool({
		name: "team_notes",
		label: "Team Notes",
		description: "Read or append per-member continuity notes. Teammates use notes to preserve context across respawns; append goes to your own notes file.",
		promptSnippet: "Read or append teammate continuity notes",
		parameters: Type.Object({
			action: StringEnum(["read", "append"] as const),
			content: Type.Optional(Type.String({ description: "Note content (required for append)." })),
			team: IdentityParams.team,
			member: Type.Optional(Type.String({ description: "Whose notes to access (default: yourself). Must be 'lead' or an exact roster member name." })),
		}),
		async execute(_id, params) {
			const caller = await resolveCaller({ team: params.team });
			const target = params.member ?? caller.member;
			if (target !== LEAD && !caller.config.members.some((member) => member.name === target)) {
				throw new Error(`Unknown notes target '${target}'. Use '${LEAD}' or an exact roster member name.`);
			}
			if (params.action === "append") {
				requireOpenTeam(caller.config, "append team notes", caller.member);
				if (target !== caller.member && caller.member !== LEAD) {
					throw new Error("Teammates can only append to their own notes.");
				}
				if (!params.content?.trim()) throw new Error("team_notes append requires content.");
				appendNote(caller.dir, target, params.content, caller.member);
				return text(`Note appended to ${target}.`);
			}
			const notes = readNotes(caller.dir, target);
			return text(notes ? { member: target, notes } : `No notes for ${target} yet.`);
		},
	});

	interface StopOutcome {
		member: string;
		accepted: boolean;
		status: TeamMember["status"];
		error?: string;
	}

	async function requestMemberStop(dir: string, requested: TeamMember): Promise<StopOutcome> {
		const current = loadConfig(dir).members.find((member) => member.name === requested.name);
		if (!current) return { member: requested.name, accepted: false, status: requested.status, error: "member no longer exists" };
		if (current.status === "stopping") return { member: current.name, accepted: true, status: current.status };
		if (current.status !== "running") return { member: current.name, accepted: true, status: current.status };
		if (!current.runId) return { member: current.name, accepted: false, status: current.status, error: "running member has no run id" };

		const reply = await requireRpc().request("stop", { id: current.runId }).catch((error) => ({
			success: false as const,
			error: { message: error instanceof Error ? error.message : String(error) },
		}));
		if (!reply.success) {
			return {
				member: current.name,
				accepted: false,
				status: loadConfig(dir).members.find((member) => member.name === current.name)?.status ?? current.status,
				error: (reply as { error?: { message?: string } }).error?.message ?? "stop request failed",
			};
		}

		const status = updateConfig(dir, (cfg) => {
			const target = cfg.members.find((member) => member.name === current.name);
			if (target && target.runId === current.runId && target.status === "running") target.status = "stopping";
			return target?.status ?? current.status;
		});
		return { member: current.name, accepted: true, status };
	}

	// -----------------------------------------------------------------------
	// Lead-only tools, command, and listeners
	// -----------------------------------------------------------------------

	if (!isChildSession) {
		pi.registerTool({
			name: "team_create",
			label: "Team Create",
			description: "Create an agent team for this session and set it active. One team per session. Spawn 2-5 teammates with clearly separated ownership; use pi-subagents instead for simple report-back delegation.",
			promptSnippet: "Create an agent team for coordinated parallel work",
			executionMode: "sequential",
			parameters: Type.Object({
				goal: Type.String({ description: "What the team should achieve." }),
				name: Type.Optional(Type.String({ description: "Team name (a-z, 0-9, '-'). Default: session-derived." })),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const sessionId = ctx.sessionManager.getSessionId();
				if (!sessionId?.trim()) throw new Error("Agent Teams requires a persistent Pi session id before a team can be created.");
				if (state.currentSessionId && state.currentSessionId !== sessionId) {
					throw new Error("Agent Teams session state is stale after a session switch; reload before creating a team.");
				}
				state.currentSessionId = sessionId;
				if (state.activeTeam) {
					const active = activeTeamDir();
					if (!active.config.closed) {
						throw new Error(`Session '${sessionId}' already owns active team '${active.name}'. Disband it before creating another team.`);
					}
					state.activeTeam = undefined;
				}
				const otherOpenTeam = listTeamNames().find((candidate) => {
					try {
						const config = loadConfig(teamDir(candidate));
						return config.leadSessionId === sessionId && !config.closed;
					} catch {
						return false;
					}
				});
				if (otherOpenTeam) {
					throw new Error(`Session '${sessionId}' already owns open team '${otherOpenTeam}' on another branch. Return to that branch and disband it first.`);
				}
				const base = params.name
					? sanitizeName(params.name)
					: `session-${sessionId.slice(0, 8)}`;
				let name = base;
				for (let i = 2; ; i++) {
					try {
						createTeam(name, params.goal, sessionId);
						break;
					} catch (error) {
						if (params.name || !String(error).includes("already exists")) throw error;
						name = `${base}-${i}`;
					}
				}
				state.activeTeam = name;
				pi.appendEntry(ACTIVE_ENTRY, { team: name });
				return text({
					team: name,
					dir: teamDir(name),
					goal: params.goal,
					next: "Spawn teammates with team_spawn ({name, role, task}), create shared work with team_tasks ({action:\"create\"}), and watch for automatic mail/completion notifications.",
				});
			},
		});

		pi.registerTool({
			name: "team_spawn",
			label: "Team Spawn",
			description: "Spawn (or respawn) a teammate as an independent async Pi session on the active team. The teammate works autonomously, claims shared tasks, and messages peers directly. You are notified when it finishes; its mail arrives automatically.",
			promptSnippet: "Spawn an independent teammate onto the team",
			executionMode: "sequential",
			parameters: Type.Object({
				name: Type.String({ description: "Member name (a-z, 0-9, '-'), e.g. 'researcher', 'frontend'." }),
				role: Type.String({ description: "One-line role, e.g. 'Owns API research; no file edits'." }),
				task: Type.String({ description: "Full initial briefing: goal, ownership boundaries, deliverables." }),
				model: Type.Optional(Type.String({ description: "Optional model override for this teammate." })),
				agent: Type.Optional(Type.String({ description: "Subagent definition to run as. Default pi-agent-teams.teammate (writer); pi-agent-teams.scout is a packaged read-only researcher. Custom agents must include the team_* tools in their allowlist or omit tools." })),
				write: Type.Optional(Type.Boolean({ description: "Compatibility assertion only. Unknown custom agents always fail closed as writers and cannot use false; packaged roles must match their registered policy. Workbench permits one writer per Git worktree." })),
			}),
			async execute(_id, params, signal, _onUpdate, ctx) {
				return text(await spawnTeammate(ctx, params, signal));
			},
		});

		pi.registerTool({
			name: "team_stop",
			label: "Team Stop",
			description: "Request that a running teammate stop (or all active teammates when member is omitted). Acknowledged requests remain nonterminal until completion is confirmed.",
			promptSnippet: "Stop a running teammate",
			executionMode: "sequential",
			parameters: Type.Object({
				member: Type.Optional(Type.String({ description: "Member name; omit to stop all active teammates." })),
			}),
			async execute(_id, params) {
				const { dir, config } = activeTeamDir();
				const memberName = params.member ? sanitizeMemberName(params.member) : undefined;
				const targets = memberName
					? config.members.filter((member) => member.name === memberName)
					: config.members.filter((member) => isActiveMemberStatus(member.status));
				if (targets.length === 0) return text(params.member ? `No member named '${params.member}'.` : "No active teammates.");
				const results: StopOutcome[] = [];
				for (const member of targets) results.push(await requestMemberStop(dir, member));
				return text({
					results: results.map((result) => ({
						member: result.member,
						stopRequested: result.accepted && result.status === "stopping",
						terminal: !isActiveMemberStatus(result.status),
						status: result.status,
						...(result.error ? { error: result.error } : {}),
					})),
				});
			},
		});

		pi.registerTool({
			name: "team_disband",
			label: "Team Disband",
			description: "Request all active teammates stop, block further mutations, and close the team only after terminal completion is confirmed. Team files are retained.",
			promptSnippet: "Shut down and close the team",
			executionMode: "sequential",
			parameters: Type.Object({}),
			async execute() {
				const { name, dir, config } = activeTeamDir();
				if (config.closed) return text({ team: name, closed: true, keptAt: dir });
				const results: StopOutcome[] = [];
				for (const member of config.members.filter((candidate) => isActiveMemberStatus(candidate.status))) {
					results.push(await requestMemberStop(dir, member));
				}
				const failures = results.filter((result) => !result.accepted);
				if (failures.length > 0) {
					return text({
						team: name,
						closed: false,
						closing: false,
						results,
						retry: "One or more stop requests were not acknowledged. The team remains open and active members remain non-respawnable.",
					});
				}

				const transition = updateConfig(dir, (cfg) => {
					if (cfg.members.some((member) => member.status === "running")) return { closed: false, closing: false };
					if (cfg.members.some((member) => member.status === "stopping")) {
						cfg.closing = true;
						return { closed: false, closing: true };
					}
					cfg.closing = false;
					cfg.closed = true;
					return { closed: true, closing: false };
				});
				if (transition.closed) {
					state.activeTeam = undefined;
					stopPoller();
					pi.appendEntry(ACTIVE_ENTRY, { team: null });
				} else {
					startPoller();
				}
				return text({ team: name, ...transition, results, keptAt: dir });
			},
		});

		// -------------------------------------------------------------------
		// /team command
		// -------------------------------------------------------------------

		function out(ctx: ExtensionContext, message: string): void {
			if (ctx.hasUI) ctx.ui.notify(message, "info");
			else process.stdout.write(`${message}\n`);
		}

		function dashboard(): string {
			if (!state.activeTeam) return "No active team. Create one: /team new <goal> — or ask the agent to use team_create.";
			const { dir, config } = activeTeamDir();
			const tasks = decorateTasks(listTasks(dir));
			const counts = {
				pending: tasks.filter((t) => t.status === "pending").length,
				inProgress: tasks.filter((t) => t.status === "in_progress").length,
				completed: tasks.filter((t) => t.status === "completed").length,
			};
			const roster = config.members.length === 0
				? "  (no teammates yet — /team spawn <name> | <role> | <task>)"
				: config.members.map((m) => `  ${m.status === "running" ? "▶" : "■"} ${m.name} [${m.status}] — ${m.role}`).join("\n");
			const unread = readInbox(dir, LEAD, false).length;
			return [
				`Team: ${config.name}${config.closed ? " (disbanded)" : ""}`,
				`Goal: ${config.goal}`,
				`Members:\n${roster}`,
				`Tasks: ${counts.pending} pending · ${counts.inProgress} in progress · ${counts.completed} completed`,
				`Lead mail: ${unread} unread`,
				`Dir: ${dir}`,
			].join("\n");
		}

		pi.registerCommand("team", {
			description: "Agent teams: /team [new <goal> | spawn <name>|<role>|<task> | say <to> <msg> | tasks | stop <name> | disband]",
			handler: async (args, ctx) => {
				const input = (args ?? "").trim();
				try {
					if (!input) return out(ctx, dashboard());
					const [verb, ...rest] = input.split(/\s+/);
					const tail = rest.join(" ");
					if (verb === "new") {
						if (!tail) return out(ctx, "Usage: /team new <goal>");
						const sessionId = ctx.sessionManager.getSessionId();
						if (!sessionId?.trim()) throw new Error("Agent Teams requires a persistent Pi session id before a team can be created.");
						if (state.currentSessionId && state.currentSessionId !== sessionId) {
							throw new Error("Agent Teams session state is stale after a session switch; reload before creating a team.");
						}
						state.currentSessionId = sessionId;
						if (state.activeTeam) {
							const active = activeTeamDir();
							if (!active.config.closed) throw new Error(`Session '${sessionId}' already owns active team '${active.name}'.`);
							state.activeTeam = undefined;
						}
						const goal = tail;
						const base = `session-${sessionId.slice(0, 8)}`;
						let name = base;
						for (let i = 2; ; i++) {
							try {
								createTeam(name, goal, sessionId);
								break;
							} catch (error) {
								if (!String(error).includes("already exists")) throw error;
								name = `${base}-${i}`;
							}
						}
						state.activeTeam = name;
						pi.appendEntry(ACTIVE_ENTRY, { team: name });
						return out(ctx, `Team '${name}' created.\nGoal: ${goal}\nNext: /team spawn <name> | <role> | <task>`);
					}
					if (verb === "spawn") {
						const [name, role, ...taskParts] = tail.split("|").map((s) => s.trim());
						const task = taskParts.join(" | ");
						if (!name || !role || !task) return out(ctx, "Usage: /team spawn <name> | <role> | <task>");
						const result = await spawnTeammate(ctx, { name, role, task });
						return out(ctx, `Teammate '${result.member}' spawned on team '${result.team}' (run ${result.runId ?? "unknown"}).`);
					}
					if (verb === "say") {
						const [to, ...msgParts] = rest;
						const message = msgParts.join(" ");
						if (!to || !message) return out(ctx, "Usage: /team say <to> <message>");
						const { dir, config } = activeTeamDir();
						const delivered = sendMessage(dir, LEAD, to, message, config.members.map((m) => m.name));
						return out(ctx, `Sent to ${delivered.join(", ")}.`);
					}
					if (verb === "tasks") {
						const { dir } = activeTeamDir();
						const tasks = decorateTasks(listTasks(dir));
						if (tasks.length === 0) return out(ctx, "No tasks. Create with team_tasks action=create.");
						return out(ctx, tasks.map((t) => {
							const flags = [t.status, t.owner ? `owner:${t.owner}` : null, t.blocked ? "blocked" : null].filter(Boolean).join(" · ");
							return `${t.id}  ${t.title}  [${flags}]`;
						}).join("\n"));
					}
					if (verb === "stop") {
						if (!tail) return out(ctx, "Usage: /team stop <member>");
						const { dir, config } = activeTeamDir();
						const member = config.members.find((candidate) => candidate.name === sanitizeMemberName(tail));
						if (!member) return out(ctx, `No member named '${tail}'.`);
						const result = await requestMemberStop(dir, member);
						if (!result.accepted) return out(ctx, `Stop request for '${tail}' failed: ${result.error ?? "unknown error"}.`);
						return out(ctx, result.status === "stopping" ? `Stop requested for '${tail}'; awaiting terminal completion.` : `'${tail}' is already ${result.status}.`);
					}
					if (verb === "disband") {
						const { dir, config } = activeTeamDir();
						const results: StopOutcome[] = [];
						for (const member of config.members.filter((candidate) => isActiveMemberStatus(candidate.status))) {
							results.push(await requestMemberStop(dir, member));
						}
						const failures = results.filter((result) => !result.accepted);
						if (failures.length > 0) {
							return out(ctx, `Team '${config.name}' remains open; stop failed for ${failures.map((result) => result.member).join(", ")}.`);
						}
						const transition = updateConfig(dir, (cfg) => {
							if (cfg.members.some((member) => member.status === "running")) return { closed: false, closing: false };
							if (cfg.members.some((member) => member.status === "stopping")) {
								cfg.closing = true;
								return { closed: false, closing: true };
							}
							cfg.closing = false;
							cfg.closed = true;
							return { closed: true, closing: false };
						});
						if (transition.closed) {
							state.activeTeam = undefined;
							stopPoller();
							pi.appendEntry(ACTIVE_ENTRY, { team: null });
							return out(ctx, `Team '${config.name}' disbanded. Files kept at ${dir}.`);
						}
						startPoller();
						return out(ctx, `Team '${config.name}' is closing; awaiting terminal teammate completion.`);
					}
					return out(ctx, `Unknown subcommand '${verb}'. Try /team, /team new, /team spawn, /team say, /team tasks, /team stop, /team disband.`);
				} catch (error) {
					out(ctx, `Team error: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		});

		// -------------------------------------------------------------------
		// Session lifecycle (lead only)
		// -------------------------------------------------------------------

		const unsubscribeCompletion = events.on(ASYNC_COMPLETE_EVENT, (payload: unknown) => {
			handleAsyncComplete(payload);
		});

		function restoreActiveTeam(ctx: ExtensionContext): void {
			stopPoller();
			state.currentSessionId = ctx.sessionManager.getSessionId();
			state.activeTeam = undefined;
			let candidate: string | undefined;
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type === "custom" && entry.customType === ACTIVE_ENTRY) {
					const team = (entry.data as { team?: string | null } | undefined)?.team;
					candidate = team || undefined;
				}
			}
			if (!candidate || !state.currentSessionId) return;
			try {
				const config = loadConfig(teamDir(candidate));
				if (config.leadSessionId !== state.currentSessionId || config.closed) return;
				state.activeTeam = candidate;
				startPoller();
			} catch {
				// Invalid, missing, foreign, and legacy ownerless teams fail closed.
			}
		}

		pi.on("session_start", async (_event, ctx) => {
			restoreActiveTeam(ctx);
		});

		pi.on("session_tree", async (_event, ctx) => {
			restoreActiveTeam(ctx);
		});

		pi.on("session_shutdown", async () => {
			stopPoller();
			state.activeTeam = undefined;
			state.currentSessionId = undefined;
			if (typeof unsubscribeCompletion === "function") unsubscribeCompletion();
			state.rpc = null;
		});
	}

	// -----------------------------------------------------------------------
	// Teammate-side delivery: mid-flight mail injection (child sessions only)
	// -----------------------------------------------------------------------

	if (isChildSession) {
		pi.on("session_start", async () => {
			// Every pi-subagents child has a run id, but only teammates appear in
			// a team config. Resolve identity in the background so the retry loop
			// never delays startup for ordinary children (reviewers, one-off runs).
			void (async () => {
				const identity = await findOwnIdentity();
				if (!identity || identity.member.name === LEAD || identity.member.name === "all" || state.poller || state.sessionEnded) return;
				const memberName = identity.member.name;
				const dir = identity.dir;
				state.poller = setInterval(() => {
					try {
						const unread = readInbox(dir, memberName, false);
						if (unread.length === 0) return;
						inject(formatTeammateMail(memberName, unread));
						advanceCursor(dir, memberName, unread[unread.length - 1]!.ts);
					} catch {
						// Transient filesystem races are fine; try again next tick.
					}
				}, POLL_MS);
				state.poller.unref?.();
			})();
		});

		pi.on("session_shutdown", async () => {
			state.sessionEnded = true;
			stopPoller();
		});
	}
}
