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
 * - Lead sessions (normal Pi): all team tools + mail poller.
 * - Child sessions (PI_SUBAGENT_CHILD set by pi-subagents): only the
 *   teammate-safe tools; identity resolves from PI_SUBAGENT_RUN_ID.
 *
 * Modules: runtime.ts (shared state/helpers), identity.ts (caller auth),
 * delivery.ts (mail poller + completion reconciliation), spawn.ts (teammate
 * launch), store.ts (on-disk team state). This file only wires them into
 * tools, commands, and lifecycle events.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isChildSession as detectChildSession } from "../core/env.ts";
import { dataResult } from "../core/result.ts";
import { createTeamsDelivery } from "./delivery.ts";
import { createTeamsIdentity } from "./identity.ts";
import {
	ACTIVE_ENTRY,
	ASYNC_COMPLETE_EVENT,
	createTeamsRuntime,
	POLL_MS,
	type RegisterTeamsOptions,
} from "./runtime.ts";
import { createTeamsSpawner, type SpawnTeammateInput } from "./spawn.ts";
import {
	appendNote,
	claimNextTask,
	claimTask,
	completeTask,
	createTask,
	createTeam,
	decorateTasks,
	LEAD,
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
	type TeamMember,
} from "./store.ts";

export type { RegisterTeamsOptions };

export default function registerTeams(pi: ExtensionAPI, options: RegisterTeamsOptions = {}) {
	const isChild = options.childSession ?? detectChildSession();
	const runtime = createTeamsRuntime(pi, options, isChild);
	const { state } = runtime;
	const identity = createTeamsIdentity(runtime, options.runId);
	const delivery = createTeamsDelivery(runtime);
	const spawner = createTeamsSpawner(runtime, delivery);

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

		const reply = await runtime.requireRpc().request("stop", { id: current.runId }).catch((error) => ({
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
			const caller = await identity.resolveCaller(params);
			const config = caller.config;
			runtime.requireOpenTeam(config, "send team mail", caller.member);
			const to = params.to.trim();
			if (to !== LEAD && to !== "all" && !config.members.some((m) => m.name === to)) {
				throw new Error(`Unknown recipient '${to}'. Members: ${config.members.map((m) => m.name).join(", ") || "(none)"}, lead, all.`);
			}
			const delivered = sendMessage(caller.dir, caller.member, to, params.message, config.members.map((m) => m.name));
			const note = to !== LEAD && to !== "all"
				? (config.members.find((m) => m.name === to)?.status !== "running" ? ` '${to}' is not currently running; it will read this on its next spawn.` : "")
				: "";
			return dataResult(`Message sent to ${delivered.join(", ")}.${note}`);
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
			const caller = await identity.resolveCaller(params);
			const markRead = params.markRead ?? true;
			if (markRead) runtime.requireOpenTeam(caller.config, "advance the inbox cursor", caller.member);
			const messages = readInbox(caller.dir, caller.member, markRead);
			if (messages.length === 0) return dataResult(`No new mail for ${caller.member}.`);
			return dataResult({
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
			const caller = await identity.resolveCaller(params);
			if (params.action !== "list") runtime.requireOpenTeam(caller.config, `perform task action '${params.action}'`, caller.member);
			switch (params.action) {
				case "create": {
					if (!params.title) throw new Error("team_tasks create requires title.");
					const task = createTask(caller.dir, { title: params.title, description: params.description, deps: params.deps, createdBy: caller.member });
					return dataResult(task);
				}
				case "list":
					return dataResult({ tasks: decorateTasks(listTasks(caller.dir)) });
				case "update": {
					if (!params.id) throw new Error("team_tasks update requires id.");
					return dataResult(updateTask(caller.dir, params.id, caller.member, { title: params.title, description: params.description, status: params.status, deps: params.deps }));
				}
				case "claim": {
					if (!params.id) throw new Error("team_tasks claim requires id.");
					return dataResult(claimTask(caller.dir, params.id, caller.member));
				}
				case "next": {
					const task = claimNextTask(caller.dir, caller.member);
					return task ? dataResult(task) : dataResult("No unclaimed, unblocked tasks available.");
				}
				case "complete": {
					if (!params.id) throw new Error("team_tasks complete requires id.");
					return dataResult(completeTask(caller.dir, params.id, caller.member));
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
			const caller = await identity.resolveCaller(params);
			const members = caller.config.members.map((m) => ({
				name: m.name,
				role: m.role,
				status: m.status,
				task: m.task,
				spawns: m.spawns,
				lastSummary: m.lastSummary,
			}));
			return dataResult({ team: caller.team, goal: caller.config.goal, closing: caller.config.closing ?? false, closed: caller.config.closed, you: caller.member, members });
		},
	});

	pi.registerTool({
		name: "team_status",
		label: "Team Status",
		description: "Team overview: roster, shared tasks with blockers, and unread mail counts.",
		promptSnippet: "Show team roster, tasks, and mail",
		parameters: Type.Object({ ...IdentityParams }),
		async execute(_id, params) {
			const caller = await identity.resolveCaller(params);
			const unread: Record<string, number> = {};
			for (const m of caller.config.members) unread[m.name] = readInbox(caller.dir, m.name, false).length;
			unread[LEAD] = readInbox(caller.dir, LEAD, false).length;
			return dataResult({
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
			const caller = await identity.resolveCaller({ team: params.team });
			const target = params.member ?? caller.member;
			if (target !== LEAD && !caller.config.members.some((member) => member.name === target)) {
				throw new Error(`Unknown notes target '${target}'. Use '${LEAD}' or an exact roster member name.`);
			}
			if (params.action === "append") {
				runtime.requireOpenTeam(caller.config, "append team notes", caller.member);
				if (target !== caller.member && caller.member !== LEAD) {
					throw new Error("Teammates can only append to their own notes.");
				}
				if (!params.content?.trim()) throw new Error("team_notes append requires content.");
				appendNote(caller.dir, target, params.content, caller.member);
				return dataResult(`Note appended to ${target}.`);
			}
			const notes = readNotes(caller.dir, target);
			return dataResult(notes ? { member: target, notes } : `No notes for ${target} yet.`);
		},
	});

	// -----------------------------------------------------------------------
	// Lead-only tools and lifecycle
	// -----------------------------------------------------------------------

	if (!isChild) {
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
					const active = runtime.activeTeamDir();
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
				return dataResult({
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
				return dataResult(await spawner.spawnTeammate(ctx, params as SpawnTeammateInput, signal));
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
				const { dir, config } = runtime.activeTeamDir();
				const memberName = params.member ? sanitizeMemberName(params.member) : undefined;
				const targets = memberName
					? config.members.filter((member) => member.name === memberName)
					: config.members.filter((member) => delivery.isActiveMemberStatus(member.status));
				if (targets.length === 0) return dataResult(params.member ? `No member named '${params.member}'.` : "No active teammates.");
				const results: StopOutcome[] = [];
				for (const member of targets) results.push(await requestMemberStop(dir, member));
				return dataResult({
					results: results.map((result) => ({
						member: result.member,
						stopRequested: result.accepted && result.status === "stopping",
						terminal: !delivery.isActiveMemberStatus(result.status),
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
				const { name, dir, config } = runtime.activeTeamDir();
				if (config.closed) return dataResult({ team: name, closed: true, keptAt: dir });
				const results: StopOutcome[] = [];
				for (const member of config.members.filter((candidate) => delivery.isActiveMemberStatus(candidate.status))) {
					results.push(await requestMemberStop(dir, member));
				}
				const failures = results.filter((result) => !result.accepted);
				if (failures.length > 0) {
					return dataResult({
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
					delivery.stopPoller();
					pi.appendEntry(ACTIVE_ENTRY, { team: null });
				} else {
					delivery.startPoller();
				}
				return dataResult({ team: name, ...transition, results, keptAt: dir });
			},
		});

		// -------------------------------------------------------------------
		// Session lifecycle (lead only)
		// -------------------------------------------------------------------

		const unsubscribeCompletion = runtime.events.on(ASYNC_COMPLETE_EVENT, (payload: unknown) => {
			delivery.handleAsyncComplete(payload);
		});

		function restoreActiveTeam(ctx: ExtensionContext): void {
			delivery.stopPoller();
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
				delivery.startPoller();
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
			delivery.stopPoller();
			state.activeTeam = undefined;
			state.currentSessionId = undefined;
			if (typeof unsubscribeCompletion === "function") unsubscribeCompletion();
			state.rpc = null;
		});
	}

	// -----------------------------------------------------------------------
	// Teammate-side delivery: mid-flight mail injection (child sessions only)
	// -----------------------------------------------------------------------

	if (isChild) {
		pi.on("session_start", async () => {
			// Every pi-subagents child has a run id, but only teammates appear in
			// a team config. Resolve identity in the background so the retry loop
			// never delays startup for ordinary children (reviewers, one-off runs).
			void (async () => {
				const found = await identity.findOwnIdentity();
				if (!found || found.member.name === LEAD || found.member.name === "all" || state.poller || state.sessionEnded) return;
				const memberName = found.member.name;
				const dir = found.dir;
				state.poller = setInterval(() => {
					try {
						delivery.deliverTeammateMail(memberName, dir);
					} catch {
						// Transient filesystem races are fine; try again next tick.
					}
				}, POLL_MS);
				state.poller.unref?.();
			})();
		});

		pi.on("session_shutdown", async () => {
			state.sessionEnded = true;
			delivery.stopPoller();
		});
	}
}
