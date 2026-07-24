---
name: agent-teams
description: Coordinate a team of independent Pi teammates with a shared task list and direct peer messaging. Use for complex work where parallel agents must share findings, challenge each other, or own separable slices (research + review, cross-layer features, competing debugging hypotheses). Prefer plain pi-subagents for simple report-back delegation and Shipyard for fixed review/delivery pipelines.
---

# Agent Teams

Agent teams coordinate multiple independent Pi sessions. You are the **team lead**: you spawn teammates, assign work, and synthesize results. Teammates work autonomously, share a task list, and message each other and you directly. Team mail and completion notices arrive automatically in this session.

## When to use what

- **Plain pi-subagents** (`subagent`, `/run`, `/parallel`): focused report-back tasks — one question, one review, one isolated job. Cheapest; workers never talk to each other.
- **Agent teams** (this skill): work that needs *coordination* — peers sharing findings mid-flight, cross-layer ownership, competing hypotheses, long multi-part efforts. Higher token cost.
- **Shipyard** (`/shipyard`): fixed engineering pipelines (review mesh, deliver, ship) with their own gates. Don't rebuild those with teams.

If teammates wouldn't need to talk to each other, use pi-subagents instead.

## The loop

1. **Create**: `team_create({goal})` — one team per session.
2. **Define ownership**: pick 2–5 teammates with *separable* slices (different files, layers, or hypotheses). Overlapping file ownership causes write conflicts — partition by module, directory, or artifact.
3. **Seed tasks**: `team_tasks({action:"create", title, deps?})` for shared milestones and dependencies.
4. **Spawn**: `team_spawn({name, role, task})` per teammate. The task is their full briefing: goal, ownership boundary, deliverables, and who else is on the team. Use `agent: "pi-agent-teams.scout"` for read-only research/review slices; default teammates can write.
5. **Coordinate**: mail arrives automatically — yours batched, teammates' injected mid-flight. Answer blockers, reassign tasks, steer via `team_send`. Check `team_status` when unsure.
6. **Respawn**: finished teammates can get more work — `team_spawn` with the same name; they resume from their `team_notes`.
7. **Synthesize + disband**: when the goal is met, pull results together, verify the assembled work yourself, then `team_disband`.

## Lead discipline

- Stay the coordinator. Don't do teammates' slices yourself while they run.
- Give tasks that produce clear deliverables (a file, a verdict, a test), not open-ended exploration.
- 3–5 teammates is the sweet spot; more means coordination overhead and cost.
- Write conflicts are the main failure mode — if two teammates must touch the same file, sequence them with task `deps` instead of running them in parallel.
- Teammates never commit or push; final integration and validation are yours.

## Human commands

`/team` (dashboard) · `/team new <goal>` · `/team spawn <name>|<role>|<task>` · `/team say <to> <msg>` · `/team tasks` · `/team stop <name>` · `/team disband`
