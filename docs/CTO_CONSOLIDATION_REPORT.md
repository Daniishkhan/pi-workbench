# Pi Workbench Consolidation and Security-Hardening Report

**Prepared for:** CTO / Engineering Review  
**Prepared:** 24 July 2026  
**Canonical Git checkout:** `/Users/danish/Desktop/pi-workbench`  
**Pi activation link:** `/Users/danish/.pi/agent/packages/pi-workbench`  
**Status:** Implemented, migrated, locally validated, and placed in a local Git repository  

---

## 1. Executive summary

Pi’s local orchestration setup was consolidated into one top-level package named **Pi Workbench**. Workbench now composes four distinct execution modes behind a shared policy and safety layer:

1. **One-off delegation** for a single specialist task.
2. **Shipyard** for fixed software-development workflows such as exploration, review, debugging, delivery, and shipping readiness.
3. **Agent Teams** for long-running peers that coordinate through shared tasks, mailboxes, and notes.
4. **Dynamic Workflows** for bounded, data-dependent fanout, branches, and loops.

The child-process runtime remains the upstream open-source `pi-subagents` project. It was not forked or modified. Workbench pins and registers an immutable upstream snapshot as its own dependency, so it is no longer a separate top-level Pi package.

The final settings contain **one orchestration package entry**:

```text
./packages/pi-workbench
```

The former standalone Agent Teams, Dynamic Workflows, Shipyard, and top-level `pi-subagents` installations were removed after source comparison, backups, full tests, and isolated runtime smoke tests.

### Final validation result

- **121 automated tests passed**.
- TypeScript type checking passed.
- Package invariants and runtime provenance checks passed.
- Workbench’s production dependency audit reported **0 vulnerabilities**.
- Parent, child-session, default-disabled Dynamic, and opt-in Dynamic smoke tests passed.
- `pi list` shows Workbench as the only orchestration package.
- A local Git repository was initialized on the Desktop after explicit owner authorization.
- No commit, push, publish, deployment, or remote was created.

---

## 2. Objectives and constraints

The work followed these requirements:

- Preserve current customization, models, role overrides, state, and compatibility names during implementation and migration.
- Keep Shipyard as the preferred fixed software-engineering workflow system.
- Keep Shipyard, Teams, Dynamic Workflows, and one-off delegation as non-nested alternatives rather than one large state machine.
- Permit only one mutation-capable owner for a canonical worktree.
- Keep Dynamic Workflows disabled by default.
- Keep prompts model-agnostic; model selection and thinking levels remain in settings/profiles.
- Do not vendor or modify `pi-subagents`.
- Use the latest standalone Agent Teams and Dynamic Workflows sources as authoritative before removing them.
- Do not commit, push, publish, deploy, or create a remote without explicit authorization. Repository initialization was later authorized separately.

---

## 3. Final architecture

```text
Pi
└── Pi Workbench                         one top-level orchestration package
    ├── upstream pi-subagents            pinned child execution/runtime lifecycle
    ├── shared core
    │   ├── configuration
    │   ├── route selection
    │   ├── role/capability policy
    │   ├── shared RPC client
    │   ├── durable writer coordinator
    │   └── writer-lease reconciliation
    ├── one-off delegation
    ├── Shipyard                         fixed engineering workflows
    ├── Agent Teams                      coordinated peers
    └── Dynamic Workflows                bounded programmable workflows; off by default
```

### Composition root

The package composition root is:

```text
/Users/danish/Desktop/pi-workbench/extensions/index.ts
```

Pi resolves the existing settings entry through:

```text
/Users/danish/.pi/agent/packages/pi-workbench -> /Users/danish/Desktop/pi-workbench
```

It performs the following in order:

1. Registers the pinned upstream `pi-subagents` extension.
2. Loads Workbench configuration.
3. Creates the shared durable `WriterCoordinator`.
4. Creates the shared versioned RPC client in parent sessions.
5. Registers Shipyard and Teams.
6. Registers Dynamic Workflows only when explicitly enabled.
7. Registers `/workbench`, `/work`, and the `workbench_route` policy surface.
8. Reconciles durable writer leases through the upstream runtime.

---

## 4. Third-party runtime boundary

Workbench declares `pi-subagents` through this immutable source:

```text
https://codeload.github.com/nicobailon/pi-subagents/tar.gz/105c1399d36517292cc7dbe1f56f4724de39bd10
```

Runtime details:

- Upstream commit: `105c1399d36517292cc7dbe1f56f4724de39bd10`
- Upstream version: `0.35.1`
- Provenance file: `pi-workbench/THIRD_PARTY.md`
- Integrity lock: `pi-workbench/package-lock.json`
- Verification command: `npm run verify:runtime`
- Verifier: `pi-workbench/scripts/verify-runtime.mjs`

The installed nested dependency was verified byte-for-byte against the selected upstream snapshot. Workbench imports it only through its public package entry point and does not maintain a fork.

---

## 5. Shared policy and writer safety

### Role and surface policy

`extensions/core/role-policy.ts` centralizes whether an agent is:

- read-only or writer-capable; and
- allowed on one-off, Shipyard, Team, or Dynamic surfaces.

Unknown agents fail closed as writers. Packaged capabilities cannot be downgraded by a caller. Dynamic Workflows validate the logical role against this shared policy before any runtime remapping.

### Durable writer coordination

`extensions/core/writer-coordinator.ts` enforces one Workbench-managed writer per canonical worktree.

Important properties:

- Worktree paths are resolved through real paths, so symlink aliases cannot obtain a second writer lease.
- Leases are durable and cross-process.
- Cross-process lease changes use operation locks.
- Stale lease tokens cannot mutate or release replacement leases.
- Dead pre-launch owners can be reclaimed.
- Uncertain launches retain the lease rather than risk a second writer.
- Active runtime IDs are attached to leases.
- Completion and runtime reconciliation release only known-safe ownership.

A lease is acquired for:

- Shipyard `compact`, `deliver`, and `ship`;
- the general `implement` route;
- write-capable Team members; and
- Dynamic Workflows whose compiled manifest declares write permission.

The guard covers Workbench-managed launches. It does not claim control over arbitrary direct calls made through unrelated third-party extensions.

---

## 6. Shipyard

Shipyard remains the core fixed software-development workflow system.

Workbench contains nine package-qualified chains:

```text
pi-shipyard.debug
pi-shipyard.deliver
pi-shipyard.deliver-compact
pi-shipyard.explore
pi-shipyard.review-fast
pi-shipyard.review-mesh
pi-shipyard.review-security
pi-shipyard.review-ui
pi-shipyard.ship
```

Shipyard retains:

- fixed workflow policy;
- package-qualified roles;
- capability-bound review findings;
- safe Git inspection;
- run-scoped artifact directories;
- repository context storage;
- one-writer delivery; and
- explicit no-commit/no-push boundaries.

Existing Shipyard state was preserved:

```text
~/.pi/agent/shipyard-runs/
~/.pi/agent/shipyard-context/
```

---

## 7. Agent Teams

The current standalone Agent Teams source was compared against Workbench using the previous snapshot as a merge base.

Result:

- `extensions/index.ts`: all newer standalone behavior was already present in Workbench.
- `extensions/rpc.ts`: all newer standalone behavior was already present in Workbench.
- `extensions/store.ts`: identical.
- Team agents and the Agent Teams skill: identical.
- Existing Workbench-specific shared RPC and writer-coordination adaptations were retained.

Team safety behavior includes:

- packaged role capability enforcement;
- unknown custom agents defaulting to writers unless explicitly declared read-only;
- one writer lease per canonical worktree;
- ownership checks for shared tasks;
- dependency-aware task claiming;
- bounded inboxes and cursor-based delivery;
- direct peer/lead messaging; and
- parent-only spawn/disband orchestration with child-only mailbox/task tools.

Existing Team state was preserved:

```text
~/.pi/agent/teams/
```

---

## 8. Dynamic Workflows hardening

Dynamic Workflows received the largest security and correctness update.

### 8.1 Compiler and DSL hardening

The compiler now rejects:

- arbitrary JavaScript, imports, native loops, callbacks, and member calls;
- forged raw workflow nodes;
- forged or malformed reference objects;
- nested phases;
- non-finite numbers;
- unsupported run fields such as undeclared `skill` or `acceptance` payloads;
- invalid turn/tool budgets;
- future output references;
- fanout-local references used outside their scope;
- branch-conditional values used as if always available;
- invalid item/iteration scope; and
- missing final result references.

Workflow nodes carry builder provenance and must be produced by supported DSL builders.

### 8.2 JSON schema correctness

The schema implementation now:

- rejects unsupported root and nested keywords;
- validates schema structure and supported types;
- performs structural JSON equality independent of object key order;
- supports compiler-created null-prototype values;
- applies `anyOf` without bypassing sibling constraints;
- validates numeric, object, array, and additional-property constraints; and
- excludes regex `pattern`, avoiding that ReDoS surface.

### 8.3 Exact source review and saved-command isolation

The reviewed source bytes are the bytes that execute.

The flow now:

1. Opens untrusted source in an editor.
2. Normalizes and recompiles the edited bytes.
3. Verifies that the workflow name did not change.
4. Restages the exact edited draft or constructs an exact in-memory saved source.
5. Confirms the compiled hash, permissions, phases, limits, input, and cwd.
6. Acquires any writer lease from the compiled manifest, not mutable metadata.
7. Executes the reviewed source.

Saved slash commands use `resolveSaved()` and cannot be hijacked by a same-name session draft. Save operations also re-open, compile, restage, hash, and trust the exact reviewed source.

### 8.4 Input, intermediate, aggregate, and final limits

Protections now cover:

- input JSON serialization and a fixed 4 KiB input limit;
- non-finite numbers, BigInt, and undefined JSON roots;
- raw individual agent output;
- parsed structured output;
- stored variables;
- incremental and final fanout collections;
- repeat collections;
- persisted agent artifacts; and
- the selected final workflow result.

Default Dynamic limits include:

- small/medium/large/unrestricted agent caps of 5/15/50/200;
- default intermediate-value limit of 200 KiB;
- default final-result limit of 50 KiB;
- default maximum concurrency of 4; and
- default maximum runtime of 30 minutes.

Unrestricted workflows remain disabled unless explicitly configured.

### 8.5 Delegation protocol

Workbench deliberately does not use the legacy unversioned batch bridge.

Read-only fanout uses concurrent calls to the public versioned single-agent protocol. Tests assert that requests:

- include `version: 1`;
- never contain a legacy `tasks` batch payload;
- do not forward workflow-selected skills or acceptance commands; and
- reject `worktree:true` rather than creating or merging temporary worktrees.

Parallel writers are rejected even when old source requests worktree isolation. Dynamic Workflows support one serialized writer followed by read-only verification.

### 8.6 Cancellation, shutdown, and lease timing

Cancellation now waits for terminal acknowledgement from the child runtime.

- A versioned cancel event is emitted.
- Listeners remain active until a terminal response arrives.
- Cancellation acknowledgement has a bounded force-close timer.
- Manager shutdown waits through a grace period and force-closes only when necessary.
- `started.done` does not settle—and the writer lease is not released—while a child is merely terminating.

A dedicated integration test proves that the lease remains held after cancellation is requested and is released only after the terminal `cancelled` response.

### 8.7 Runtime agent pinning

Approved logical read-only Dynamic roles are remapped, after shared-policy validation, to randomly named per-session runtime agents.

These definitions:

- are stored in a random package namespace;
- use `0700` directories and `0600` files;
- allow only read/search/web tools;
- exclude shell, edit, and write tools;
- replace rather than extend the system prompt;
- force fresh context;
- disable skill inheritance; and
- forbid subagents, Teams, Shipyard, and workflows.

Writers are never remapped and continue through the normal shared role policy and durable writer coordinator.

### 8.8 Durable history and startup failure handling

Persisted statuses from the current session root remain inspectable. A nonterminal status found after reload is reconciled to failed rather than silently resumed.

An independent runtime review found a startup edge case: `WorkflowManager.start()` previously published its in-memory active run before all initial persistence completed. A disk or permission failure could therefore leave an unreachable, nonterminal promise that blocked future workflows and shutdown.

This was corrected by:

1. Persisting source/input, compiled IR, initial status, and the created event first.
2. Publishing `#runs`, `#history`, and `#activeRunId` only after all initial writes succeed.
3. Isolating UI/update observer exceptions from workflow lifecycle.
4. Adding a regression test that injects an initial persistence failure, verifies empty history, starts another workflow successfully, and shuts down.

A separate read-only reviewer verified the finding as resolved with no new concrete regression.

### 8.9 State preservation

Dynamic state paths were not changed:

```text
~/.pi/agent/workflows/
~/.pi/agent/workflow-drafts/<session>/
~/.pi/agent/workflow-runs/<session>/
~/.pi/agent/workflow-trust.json
~/.pi/agent/extensions/dynamic-workflows/config.json
```

---

## 9. Parent/child orchestration boundaries

`PI_SUBAGENT_CHILD=1` prevents a child from becoming another orchestrator.

Child smoke testing confirmed that child sessions do not expose:

- the `subagent` execution tool;
- Workbench routing;
- Shipyard workflow launches;
- Team spawning/disbanding;
- Dynamic workflow creation/execution; or
- Dynamic slash commands.

Leaf children retain only the scoped read/repository/findings or Team mailbox/task tools required by their role.

---

## 10. Settings migration and physical cutover

The migration script is:

```text
pi-workbench/scripts/migrate-settings.mjs
```

It:

- preserves unrelated settings;
- removes known standalone orchestration entries;
- inserts exactly one Workbench entry;
- preserves existing user role overrides;
- writes settings atomically;
- records old/new hashes;
- backs up and archives the legacy scout when present; and
- supports hash-guarded rollback.

Final orchestration entry:

```json
[
  "./packages/pi-workbench"
]
```

This is the orchestration subset; unrelated packages such as web access, MCP, Chrome, annotation, Herdr, and subagent panes remain installed.

Removed after validation:

```text
~/.pi/agent/packages/pi-shipyard
~/.pi/agent/packages/pi-agent-teams
~/.pi/agent/packages/pi-dynamic-workflows
~/.pi/agent/npm/node_modules/pi-subagents
```

The canonical source is the Desktop Git checkout:

```text
~/Desktop/pi-workbench
```

The existing Pi package path is now a symbolic link to that checkout:

```text
~/.pi/agent/packages/pi-workbench -> ~/Desktop/pi-workbench
```

The standalone root runtime dependency was removed from `~/.pi/agent/npm/package.json`; Workbench’s independently locked nested runtime remains present.

---

## 11. Validation evidence

### Automated test result

```text
Core:       20 passed
Shipyard:   37 passed
Teams:      13 passed
Dynamic:    51 passed
Total:     121 passed
```

Command:

```bash
cd /Users/danish/Desktop/pi-workbench
npm test
```

### Package validation

```text
Validated 24 agents, 10 skills, 9 chains, 6 prompts,
and shared orchestration invariants.
```

### Runtime provenance

```text
Verified pi-subagents upstream snapshot
105c1399d36517292cc7dbe1f56f4724de39bd10
version 0.35.1 with locked SHA-512 integrity.
```

### Workbench dependency audit

```text
npm audit --omit=dev
found 0 vulnerabilities
```

### Package dry-run

```text
Package:       @danish/pi-workbench@0.1.0
Files:         97
Packed size:   127,894 bytes
Unpacked size: 520,909 bytes
```

### Discovery smoke test

Isolated Workbench-only discovery found:

```text
Upstream built-in agents:  9
Workbench package agents: 24
Total isolated agents:    33
Workbench chains:          9
```

The actual user environment additionally retained four pre-existing custom user agents, producing 37 total discovered agents.

### Runtime surface smoke tests

Default configuration:

- `/workbench`, `/work`, `/shipyard`, `/team`, and `/subagents-doctor` registered successfully.
- Dynamic commands and tools were absent.
- No command collision was reported.

Opt-in Dynamic configuration:

- `/workflow`, `/workflows`, and `/ultracode` registered.
- `workflow_create`, `workflow_run`, and `workflow_control` registered.
- `skill:dynamic-workflows` registered.
- Ephemeral pinned-agent package files were removed at session shutdown.

Child configuration:

- orchestration entry points were absent;
- leaf-only tools remained.

`/subagents-doctor` completed with exit code 0 in a new post-cutover Pi process.

---

## 12. Repository and backup disposition

After the migration and validation were complete, the owner explicitly directed that the package be placed in a Desktop Git repository and that the migration/skill backups be removed.

Canonical source:

```text
/Users/danish/Desktop/pi-workbench
```

Activation link:

```text
/Users/danish/.pi/agent/packages/pi-workbench -> /Users/danish/Desktop/pi-workbench
```

The repository is initialized on branch `main`. At the time of this report it has no commit and no remote.

The prior directories under `~/.pi/agent/backups/` and the archived legacy scout backup were intentionally deleted on owner instruction. Therefore, there is no retained archive-based rollback to the former standalone packages. Reproducibility now depends on this checkout, its lockfile, and the immutable upstream runtime URL/integrity record.

Cleanup also removed the superseded package copy and its duplicate `node_modules`, old subagent artifacts, stale ephemeral Dynamic runtime-agent files, npm/npx caches, and temporary merge/smoke-test directories. Active Pi state such as settings, sessions, Shipyard runs/context, Team state, and Dynamic workflow state was not deleted.

---

## 13. Known residual risks and follow-up recommendations

### 13.1 Current process reload

The interactive Pi process that performed the migration was started before the final settings cutover. It must run:

```text
/reload
```

New Pi processes were already smoke-tested successfully. Reload is required before relying on the current process’s extension/runtime inventory.

### 13.2 Shared Pi npm tree advisories

Workbench itself reports zero vulnerabilities. Separately, the shared package tree at:

```text
~/.pi/agent/npm
```

currently reports:

```text
12 moderate
1 high
13 total
```

The high advisory is in transitive package `fast-uri`; moderate advisories include dependency paths through existing unrelated packages such as Herdr, Plannotator, Chrome, MCP, and web access. No automatic `npm audit fix` was applied because it could upgrade or break unrelated user packages.

**Recommendation:** review and upgrade the affected shared extensions in a separate controlled maintenance task.

### 13.3 Repository has no baseline commit or remote

A local Git repository now exists at `~/Desktop/pi-workbench`, but it has no commit, signed history, pull request, branch protection, or remote.

**Recommendation:** after CTO review, authorize an initial baseline commit and private remote, then add CI for `npm test`, runtime verification, audit, and package dry-run.

### 13.4 Dynamic runtime leftovers after hard process termination

Normal Dynamic shutdown removes ephemeral pinned-agent package files. A hard process termination could leave an unreferenced random read-only runtime package directory. Random naming, strict permissions, replacement prompts, and the lack of mutation tools reduce the impact.

**Recommendation:** add PID/creation metadata and conservative dead-owner cleanup in a future hardening pass.

### 13.5 Dynamic execution is intentionally non-resumable

Interrupted Dynamic executions are marked failed and remain inspectable; they are not resumed automatically.

**Recommendation:** retain this fail-closed behavior unless a future design can prove idempotence and ownership across every node.

### 13.6 Writer coordination scope

The durable writer guard covers Workbench-managed execution. A user can still bypass it by directly invoking a separate third-party mutation tool.

**Recommendation:** document Workbench as the approved orchestration entry point and restrict unrelated mutation-capable extensions if stronger organizational enforcement is required.

---

## 14. Suggested CTO review checklist

1. Review `AGENTS.md` and `README.md` for intended operating policy.
2. Review `THIRD_PARTY.md`, `package.json`, `package-lock.json`, and `scripts/verify-runtime.mjs` for supply-chain provenance.
3. Review `extensions/index.ts` for registration order and child gating.
4. Review `extensions/core/role-policy.ts` for capability and surface decisions.
5. Review `extensions/core/writer-coordinator.ts` and reconciliation tests.
6. Review `extensions/dynamic/compiler.ts`, `schema.ts`, `delegation.ts`, `manager.ts`, `pinned-agents.ts`, and `index.ts`.
7. Review Dynamic integration tests, especially cancellation/lease timing, exact-source execution, stale metadata, startup persistence, output limits, and saved-command isolation.
8. Run the validation commands below on a clean shell.
9. Decide whether to authorize the initial commit, a private remote, and CI baseline.
10. Schedule separate remediation of the shared Pi npm advisories.

Recommended commands:

```bash
cd /Users/danish/Desktop/pi-workbench
npm ci
npm test
npm run verify:runtime
npm audit --omit=dev
npm pack --dry-run
PI_OFFLINE=1 pi list
```

---

## 15. Change authority and shipping boundary

This work changed local files and settings and, after explicit owner authorization, initialized a local Git repository. It did **not**:

- create a commit;
- push to a remote;
- publish an npm package;
- deploy software;
- create a remote repository; or
- modify the upstream `pi-subagents` source.

Those remaining actions require separate explicit authorization.
