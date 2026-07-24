# Pi Workbench

Pi Workbench is a private, modular Pi package for a solo software-development workflow. It combines reusable one-off agents, Shipyard's fixed engineering pipelines, Agent Teams, and bounded Dynamic Workflows behind one policy layer.

Workbench is the single top-level Pi package. It owns Shipyard, Agent Teams, Dynamic Workflows, roles, routing, shared policy, and writer safety. The process/session engine remains upstream `pi-subagents`, but Workbench now declares, integrity-locks, and registers an immutable snapshot of that dependency itself—there is no second Pi package entry and no vendored fork.

## Architecture

```text
/workbench and workbench_route
  ├─ one-off roles: quick, deep, plan, implement, review-oneoff
  ├─ Shipyard: explore, debug, fast, review, security, ui, compact, deliver, ship
  ├─ Agent Teams: peer communication and shared tasks
  └─ Dynamic Workflows: bounded branches/loops/fanout (experimental)
                       │
     pi-subagents upstream main @ 105c1399d365
```

The four modes are alternatives. Workbench forbids nested orchestration and keeps one mutation-capable owner per cwd/worktree for Workbench-managed launches.

## Requirements

- Pi 0.81.1 or newer
- Node.js 24 or newer
- Network access during installation to fetch the integrity-locked upstream `pi-subagents` snapshot
- `pi-web-access` only when using `pi-workbench.researcher`

## Ownership boundary

Shipyard, Agent Teams, and Dynamic Workflows are self-contained Workbench modules. `pi-subagents` is not Workbench-owned: it is pulled directly from upstream main commit `105c1399d36517292cc7dbe1f56f4724de39bd10`, locked by URL and SHA-512 integrity, and imported only through its public package entry point. See [`THIRD_PARTY.md`](./THIRD_PARTY.md).

Updating the runtime is an explicit Workbench change: review a new upstream commit, update the dependency and compatibility verifier, regenerate the lockfile, then run the complete test and Pi discovery suite. Workbench never floats silently with the main branch.

## Install from this checkout

The canonical Git checkout is:

```text
~/Desktop/pi-workbench
```

Pi activates it through this local package link, preserving the existing settings entry:

```text
~/.pi/agent/packages/pi-workbench -> ~/Desktop/pi-workbench
```

Install the locked dependencies and verify the runtime from the checkout:

```bash
cd ~/Desktop/pi-workbench
npm ci
npm run verify:runtime
```

For a first-time migration from the former standalone packages, use the migration script instead of editing settings by hand:

```bash
node scripts/migrate-settings.mjs --check
node scripts/migrate-settings.mjs --apply
```

The migration:

- removes the old standalone `npm:pi-subagents@0.35.1` entry because Workbench now owns the upstream runtime dependency;
- replaces the old local Shipyard/Teams/Dynamic package entries with `./packages/pi-workbench`;
- merges the recommended namespaced model profile without overwriting existing user overrides;
- creates a timestamped settings backup and manifest;
- archives `~/.agents/scout.md` instead of deleting it;
- leaves old package directories and all prior run/state data untouched.

Run `/reload` after applying. The apply result prints the rollback manifest:

```bash
node scripts/migrate-settings.mjs --rollback ~/.pi/agent/backups/pi-workbench-.../manifest.json
```

Rollback refuses to overwrite settings edited after migration unless `--force` is supplied. The completed local migration's historical backup directories were later removed on explicit owner instruction; this script still creates a new reversible manifest if it is run again.

## Front door

Humans use `/workbench` or `/work`:

```text
/workbench status
/workbench quick <question>
/workbench deep <task>
/workbench plan <task>
/workbench implement <approved task>
/workbench review-oneoff <target>
/workbench review <target>
/workbench deliver <approved task>
/workbench team <goal>
/workbench dynamic <task>
```

Use `/workbench plan grill: <target>` when the planner should pressure-test the proposal through a bounded, one-question-at-a-time supervisor interview before returning the hardened plan. Ordinary `plan` requests remain non-interactive.

Models use `workbench_route` with the same explicit modes. There is no keyword-based auto-router: routing is deterministic and visible.

Workbench registers no module-specific orchestration commands. Legacy `/shipyard`, `/team`, `/workflow`, `/workflows`, `/ultracode`, and saved-workflow slash commands are not exposed. Supporting `team_*` and `dynamic_*` tools are operational primitives used only after `workbench_route` selects those modes; Shipyard launches directly through the router's internal service.

## Selection policy

- **quick**: bounded, low-cost repository reconnaissance;
- **deep**: comprehensive implementation context and reusable handoff;
- **plan / implement / review-oneoff**: one independent result;
- **Shipyard**: fixed code exploration, debugging, review, delivery, and readiness gates;
- **Agent Teams**: only when peers need shared tasks or direct messages;
- **Dynamic Workflows**: only for bounded data-dependent fanout, branches, or loops.

Prefer the smallest reliable mechanism. Shipyard is safer than inventing a delivery topology; Teams are more expensive than report-back delegation; Dynamic Workflows are not a replacement for Shipyard.

## Configuration

Global configuration lives at:

```text
~/.pi/agent/extensions/pi-workbench/config.json
```

Defaults:

```json
{
  "modules": {
    "shipyard": true,
    "agentTeams": true,
    "dynamicWorkflows": false
  },
  "shipyard": {
    "agentBindings": {}
  },
  "dynamic": {},
  "writerGuard": {
    "enabled": true
  }
}
```

Changes take effect after `/reload`.

The optional `dynamic` object carries Dynamic Workflows policy (`defaultSize`, `sizeLimits`, `maxConcurrency`, `maxRuntimeMs`, `maxIntermediateBytes`, `maxResultBytes`, `allowUnrestricted`, `unrestrictedSafetyCap`, `allowUnattendedTrusted`, `approvalMode`). The legacy standalone `~/.pi/agent/extensions/dynamic-workflows/config.json` is still read as a fallback with a deprecation warning when the `dynamic` section is empty.

### Shipyard role binding

Shipyard chains retain their canonical `pi-shipyard.*` role names. You can substitute custom agents without weakening capability policy:

```json
{
  "shipyard": {
    "agentBindings": {
      "pi-shipyard.codebase-reader": "pi-workbench.deep-reader",
      "pi-shipyard.contract-reviewer": "pi-workbench.reviewer"
    }
  }
}
```

Capability grants are calculated against the canonical Shipyard role before the replacement name is applied. A binding that changes a role from read-only to writer (or the reverse) is rejected. Unknown custom agents fail closed as writers, so custom read-only roles must first be added to the shared role policy registry.

### Models

Agent files are model-agnostic. Recommended local assignments are stored in:

```text
profiles/recommended-agent-overrides.json
```

The migration merges these into `settings.subagents.agentOverrides`. This keeps role behavior in agent files and model/fallback/thinking policy in settings where it can be changed without editing package source.

## Agents

General package-scoped roles:

- `pi-workbench.fast-scout`
- `pi-workbench.deep-reader`
- `pi-workbench.planner`
- `pi-workbench.worker`
- `pi-workbench.reviewer`
- `pi-workbench.oracle`
- `pi-workbench.researcher`

Compatibility namespaces remain unchanged:

- `pi-shipyard.*`
- `pi-workbench.teams-scout`
- `pi-workbench.teams-teammate`

(Agent Teams roles moved from the retired `pi-agent-teams.*` namespace; the settings migration rewrites those `agentOverrides` keys automatically.)

No package agent registers as bare `scout`, so it cannot unexpectedly shadow the clean builtin.

## Skills

The Pi package manifest exposes only the unified `pi-workbench` routing skill to the parent session. The `agent-teams` and specialized `shipyard-*` skills remain packaged under `skills/` for internal use, but they do not appear in Pi's global startup skill list.

## Writer guard

Durable writer leases live under:

```text
~/.pi/agent/workbench/writer-leases/
```

Workbench acquires a lease for:

- Shipyard `compact`, `deliver`, and `ship`;
- the general `implement` route;
- write-capable team members;
- dynamic workflows declaring `write` permission.

Read-only work can still run concurrently. Unknown custom team agents always fail closed as writers; `team_spawn.write: false` cannot downgrade an unregistered tool surface. Writer keys resolve to the canonical Git worktree root, while linked worktrees remain independent. An uncertain launch retains its lease.

Inspect leases with `/workbench`. Manual recovery is available through `/workbench release-writer`, which requires interactive confirmation and should be used only after confirming the old writer is gone.

This guard covers Workbench-managed launches, not arbitrary direct calls to another extension's `subagent` tool.

## Dynamic Workflows

Dynamic Workflows are disabled by default. When enabled they retain exact-source editing, hash-bound approval, budgets, state artifacts, structured outputs, bounded loops, and branching. The reviewed bytes—not an earlier draft—are compiled and executed. Saved definitions remain reusable through the Workbench dynamic route and `dynamic_run`; they do not create slash commands.

Compiler provenance checks reject forged nodes/references, unsafe schema shapes, non-finite values, undeclared skills/acceptance payloads, future or scope-invalid references, and nested phases. Input, individual output, aggregate intermediate values, and the selected final result all have hard limits. Interrupted statuses remain inspectable and are reconciled as failed after reload.

Workbench removes the old unversioned parallel batch bridge. Read-only fanout uses concurrent versioned single-agent delegation through ephemeral, permission-restricted runtime agents. Parallel writers are rejected—even when old source requests `worktree:true`—because the foreground delegation protocol cannot safely create isolated worktrees. Use one serialized writer followed by read-only verification. Cancellation holds the durable writer lease until the child returns a terminal acknowledgement or the bounded shutdown grace expires.

Dynamic state lives under the unified Workbench state root:

```text
~/.pi/agent/workbench/dynamic/saved/
~/.pi/agent/workbench/dynamic/drafts/
~/.pi/agent/workbench/dynamic/runs/
~/.pi/agent/workbench/dynamic/trust.json
```

Pre-unification locations (`~/.pi/agent/workflows/`, `workflow-drafts/`, `workflow-runs/`, `workflow-trust.json`) are still read as a fallback; new writes always go to the unified root.

Dynamic policy lives in the `dynamic` section of the Workbench config (see Configuration); the legacy `~/.pi/agent/extensions/dynamic-workflows/config.json` is read as a deprecated fallback only.

## State locations

All Workbench state shares one root:

```text
~/.pi/agent/workbench/
  shipyard/runs/       findings ledgers + launch journals
  shipyard/context/    reusable repository context cache
  teams/               Agent Teams shared state
  dynamic/             saved definitions, drafts, run artifacts, trust
  writer-leases/       one-writer-per-worktree leases
```

Legacy locations (`~/.pi/agent/shipyard-runs/`, `shipyard-context/`, `teams/`, and the dynamic paths above) remain readable as fallbacks, so existing state keeps working without migration. Writes always go to the unified root. `PI_WORKBENCH_TEAMS_ROOT` overrides the teams root (the retired `PI_AGENT_TEAMS_ROOT` is honored as a fallback).

- pi-subagents async artifacts: owned entirely by `pi-subagents`

No state migration or deletion is required.

## Validation

```bash
cd ~/Desktop/pi-workbench
npm test
npm run verify:runtime
npm pack --dry-run
pi -e . --list-models
```

After settings migration and `/reload`:

```text
/subagents-doctor
/workbench
/work
```

Confirm that `/shipyard`, `/team`, `/workflow`, `/workflows`, and `/ultracode` are absent. Dynamic enablement should be smoke-tested separately on a disposable repository.

## Shipping boundary

The package never treats implementation or readiness as authority to commit, push, publish, deploy, create a remote, or delete old packages/data. Those remain explicit user actions.
