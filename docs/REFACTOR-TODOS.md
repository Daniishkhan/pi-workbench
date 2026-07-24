# Pi Workbench refactor todos

Source: implementation review of the consolidated package (see review discussion).
Rule for every phase: `npm test` stays green. Phases 1–2 must be invisible to users.

## Phase 1 — pure DRY, zero behavior change ✅ DONE

### New core utilities
- [x] `core/env.ts` — `CHILD_ENV`, `RUN_ID_ENV`, `isChildSession()` (replaces 5 copies of the constant)
- [x] `core/result.ts` — `textResult()` + `dataResult()` (replaces 4 copies)
- [x] `core/json.ts` — strictest `writeJsonAtomic` (non-finite/BigInt guard, 0700 dir, 0600 file), `readJson`, `ensurePrivateDir`, `writeTextAtomic` (replaces 3 divergent copies; teams store gains 0600 as hardening)
- [x] `core/sanitize.ts` — one `safePathSegment` (merges `safePart` in workflows.ts + `sanitizeSegment` in dynamic/store.ts)
- [x] `core/run-lifecycle.ts` — shared terminal-state set + `isConfirmedTerminalRunArtifact` + `classifySubagentStatusText` + `runIdFromAsyncComplete` (dedupes writer-reconciliation + teams)
- [x] Event bus: pi's public `EventBus` type was already exported by `@earendil-works/pi-coding-agent` — all local bus interfaces/casts replaced with it (`SubagentRpcEventBus`/`WorkflowEventBus` kept as deprecated aliases)
- [x] `core/guarded-spawn.ts` — `beginGuardedSpawn` (lease + ping) / `guard.spawn` (spawn + lease resolution) replacing the 8-step choreography copied in router.spawnOneOff, teams.spawnTeammate, workflows.spawnWorkflow. Lease states: held → transferred/released; `discard()` releases only while held (kills the `preserveWriterLease` flag pattern)

### Deletions (dead code)
- [x] Deleted `extensions/shipyard/rpc-client.ts` and `extensions/teams/rpc.ts` (shims; subclasses only used by their own tests) — consumers import from `core/subagent-rpc.ts`
- [x] Deleted `test/shipyard/rpc-client.test.ts` and `test/teams/rpc.test.ts` (shim tests; core client covered by `test/core/rpc-client.test.ts`)
- [x] Deleted `extensions/core/types.ts` (`WorkbenchModuleOptions`, unused)
- [x] Deleted `extensions/core/index.ts` barrel (nothing imported it)

### Router single-sourcing
- [x] `router.ts` dispatch uses `routeCategory()` instead of manual branching
- [x] Deleted `workflowName()` if-chain; added `isShipyardMode()` type guard
- [x] Moved workflow names into `core/routing.ts` (`SHIPYARD_WORKFLOW_NAMES`/`ShipyardWorkflowName`); deleted `shipyard/workflow-names.ts`; HELP/status text derive from the mode lists

### pi-subagents public contracts
- [x] `dynamic/delegation.ts` now type-checks `SubagentDelegationResponse` from the public `pi-subagents/delegation` subpath. Note: runtime import is **type-only** because Node's strip-types runner refuses node_modules TS; the event-name literals stay local and are now guarded by `scripts/verify-runtime.mjs` (extended to the delegation contract + async-complete event)

### Teams split (`teams/index.ts`, was 1007 lines → ~480)
- [x] `teams/runtime.ts` — shared state + helper bag (`createTeamsRuntime`)
- [x] `teams/identity.ts` — findOwnIdentity / resolveCaller
- [x] `teams/delivery.ts` — mail formatting (unified), poller, completion detection/reconcile
- [x] `teams/spawn.ts` — buildTeammatePrompt / spawnTeammate (on guarded spawn)
- [x] `teams/index.ts` — registration, tools, lifecycle only

## Phase 2 — single source of policy ✅ DONE

- [x] `shipyard/workflow-catalog.ts` — `SHIPYARD_WORKFLOWS` table (file, timeoutMs, findings, mutating, defaultTask) drives the runner, `resolveWorkflowTask`, and chain-file validation
- [x] `shipyard/findings-policy.ts` — declarative findings capability matrix (replaces suffix if-chain); prose stage convention documented + validator smoke-checks derivation on every chain step
- [x] role-policy ↔ agent frontmatter cross-check in validator, with documented `CAPABILITY_FRONTMATTER_EXCEPTIONS` (shipwright); debugger.md gained missing `acceptanceRole: read-only`; `DYNAMIC_*_ROLES` derived from `ROLE_POLICIES`
- [x] `scripts/validate.mjs` → `scripts/validate.ts` — structural checks against the real registries (role policy, catalog, findings policy, FIRST_WAVE_OUTPUTS); deleted-shim checks replaced with a single-client-construction rule

Validation: 126 tests green, `npm run check`, `npm pack --dry-run`, `pi -e . --list-models` all pass.

## Phase 3 — naming/config/state unification (user-visible, behind migration) ✅ DONE
- [x] One config file: `dynamic:` section in workbench config; legacy `extensions/dynamic-workflows/config.json` read as fallback + deprecation warning
- [x] One state root `~/.pi/agent/workbench/{shipyard/{runs,context},teams,dynamic/{saved,drafts,runs},writer-leases}`; legacy locations read as fallback
- [x] Tool renames: `review_findings` → `shipyard_findings`; `workflow_*` → `dynamic_*` (chose the `dynamic_*` rename; Shipyard's internal workflows.ts unchanged)
- [x] Custom types to `pi-workbench:<module>:<thing>` (`pi-workbench:teams:active`, `pi-workbench:teams:mail`, `pi-workbench:dynamic:complete`, `pi-workbench:dynamic:run`); `PI_WORKBENCH_TEAMS_ROOT` with `PI_AGENT_TEAMS_ROOT` fallback
- [x] Agent namespaces: kept `pi-shipyard.*` as documented brand; merged `pi-agent-teams.{scout,teammate}` → `pi-workbench.teams-{scout,teammate}`; migrate-settings.mjs rewrites `agentOverrides` keys
- [x] Fixed mode/file-name asymmetry (`review-fast.chain.json`→`fast.chain.json`, `deliver-compact.chain.json`→`compact.chain.json`); validator rules are catalog-driven
- [x] teamsRoot honors `getAgentDir()`; core/config `defaultAgentDir()` deleted in favor of pi's `getAgentDir()` (new `core/paths.ts` owns all state locations)

## Phase 4 — contract hardening ✅ DONE
- [x] Register `pi-subagents/background-work` provider for dynamic workflow runs (headless auto-drain/subagent_wait visibility); injected from the composition root so strip-types tests never load node_modules TS
- [x] Self-healing lease acquire: blocking lease's runId checked via RPC status, terminal leases reaped + acquire retried once (in `beginGuardedSpawn`)
- [x] Memoize `findOwnIdentity()` in child sessions (successful resolutions)
- [x] Pinned-agent janitor: `sweepStalePinnedAgents` reaps `pi-workbench-dynamic-runtime-*.md` whose owning pid is dead, on dynamic runtime init
- [x] Surface dynamic runtime init errors at session_start (UI notify + recorded cause rethrown by tool calls)
- [x] Drop router's hardcoded `context:` override; agent frontmatter `defaultContext` governs
- [x] promptSnippet/promptGuidelines for shipyard tools (`shipyard_findings`, `shipyard_repo`, `shipyard_context*`); renderCall/renderResult for workbench_route

Validation: 156 tests green, `npm run check`, `npm pack --dry-run`, `pi -e . --list-models` all pass.
