/**
 * Teammate spawning: briefing construction plus the guarded RPC launch that
 * registers the member on the roster. Runs in the lead session only.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beginGuardedSpawn } from "../core/guarded-spawn.ts";
import { resolveTeamAgentCapability } from "../core/role-policy.ts";
import { LEAD, sanitizeMemberName, updateConfig } from "./store.ts";
import { TEAMMATE_AGENT, type TeamsRuntime } from "./runtime.ts";
import type { TeamsDelivery } from "./delivery.ts";

export interface SpawnTeammateInput {
	name: string;
	role: string;
	task: string;
	model?: string;
	agent?: string;
	write?: boolean;
}

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

export function createTeamsSpawner(runtime: TeamsRuntime, delivery: TeamsDelivery) {
	async function spawnTeammate(
		ctx: ExtensionContext,
		input: SpawnTeammateInput,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const { name: team, dir, config } = runtime.activeTeamDir();
		runtime.requireOpenTeam(config, "spawn a teammate", LEAD);
		const memberName = sanitizeMemberName(input.name);
		const agent = input.agent?.trim() || TEAMMATE_AGENT;
		const existing = config.members.find((m) => m.name === memberName);
		if (existing && delivery.isActiveMemberStatus(existing.status)) {
			throw new Error(`Teammate '${memberName}' is ${existing.status}. Wait for terminal completion before respawning it.`);
		}
		const respawn = Boolean(existing);
		const writeCapable = resolveTeamAgentCapability(agent, input.write) === "writer";
		if (writeCapable && !runtime.options.writerCoordinator) {
			throw new Error("Write-capable Agent Teams spawning requires the shared Workbench writer coordinator.");
		}
		const prompt = buildTeammatePrompt({ team, dir, member: memberName, role: input.role, task: input.task, respawn });
		const guard = await beginGuardedSpawn({
			rpc: runtime.requireRpc(),
			writerCoordinator: runtime.options.writerCoordinator,
			cwd: ctx.cwd,
			owner: `team:${team}/${memberName}`,
			writeCapable,
			label: "Spawn",
			signal,
		});
		const { runId } = await guard.spawn({
			params: {
				agent,
				task: prompt,
				cwd: ctx.cwd,
				context: "fresh",
				async: true,
				clarify: false,
				artifacts: true,
				...(input.model ? { model: input.model } : {}),
			},
			signal,
			requireRunIdMessage: "Spawn was accepted without a run id. Refusing to register an unauthenticated teammate; inspect the pi-subagents fleet before releasing any retained writer lease.",
		});
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
		delivery.startPoller();
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

	return { spawnTeammate };
}
