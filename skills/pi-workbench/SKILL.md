---
name: pi-workbench
description: Route software work through Pi Workbench's one-off agents, Shipyard, Agent Teams, or bounded Dynamic Workflows. Use when selecting or coordinating the appropriate execution mode.
---

# Pi Workbench

Pi Workbench has one policy layer and four alternative execution modes. Never nest the orchestration modes.

## Selection

- **Quick one-off**: `workbench_route` mode `quick` for bounded repository reconnaissance.
- **Deep one-off**: mode `deep` for comprehensive implementation context.
- **Plan / implement / review-oneoff**: dedicated general roles for one bounded result.
- **Shipyard**: fixed software lifecycle modes (`explore`, `debug`, `fast`, `review`, `security`, `ui`, `compact`, `deliver`, `ship`).
- **Agent Teams**: only when 2-5 peers genuinely need shared tasks or direct messages. Prefer read-only scouts and only one writer per cwd.
- **Dynamic Workflows**: bounded data-dependent fanout, branches, or loops; experimental, disabled by default, and always human-approved.

Prefer the smallest mechanism that can reliably finish the task. A single agent is cheaper than a workflow; Shipyard is safer than inventing a delivery pipeline; Teams are justified only by coordination; Dynamic Workflows are justified only by programmatic topology.

## Hard boundaries

- The parent owns routing and synthesis. Leaf agents do not launch orchestration.
- Only one Workbench-managed writer may own a cwd/worktree.
- Read-only work can run in parallel.
- Shipyard findings capabilities remain workflow-scoped and must never be guessed or copied.
- Dynamic source must be reviewed and approved before execution.
- No Workbench mode implies commit, push, publish, deploy, credential changes, or destructive Git/data operations.

Humans can use `/workbench` or `/work`; models use `workbench_route`.
