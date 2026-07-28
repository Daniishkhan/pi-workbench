# Pi Engineering

Pi Engineering is a small, bounded software-engineering team for Pi. The main session acts as engineering manager: it frames the task, chooses one action, assigns focused specialists, and verifies the result. Five specialist roles and two fixed workflows rely on the immutable upstream `pi-subagents` package for process and session execution.

The design deliberately has one assignment layer. There are no nested teams, user-programmable workflow graphs, recursive delegations, or alternate policy skills. The playbook changes the method—not the team size—so a documentation edit, a causal bug investigation, and a release audit do not receive the same ceremony.

## Execution model

```text
/engineering or assign_engineering
  ├─ inspect   → one read-only inspector
  ├─ plan      → one read-only planner
  ├─ implement → one write-locked implementer
  ├─ review    → one fresh read-only reviewer
  ├─ deliver   → plan/write/dual-review; one critical repair when required
  └─ audit     → two-model read-only audit and synthesis
                       │
             pinned pi-subagents runtime
```

The engineering manager owns task framing, assignment, and final synthesis. Specialists complete one bounded assignment and cannot delegate. Pi Engineering permits only one implementer to hold a worktree's write lock; read-only work remains independent.

## Requirements

- Pi 0.81.1 or newer
- Node.js 24 or newer
- Network access during installation to fetch the integrity-locked `pi-subagents` snapshot

The upstream source and lock are documented in [THIRD_PARTY.md](./THIRD_PARTY.md). Pi Engineering registers that runtime before its own RPC client, but exposes only the `pi-engineering` policy skill.

The upstream runtime's unrestricted `subagent` model tool is replaced with a small rejection boundary. Its RPC bridge remains internal, so model-initiated launches must pass through `assign_engineering` and its fixed limits. Upstream slash commands remain an explicit human-operated escape hatch; they are outside the bounded model-routing contract.

## Install from this checkout

```bash
cd /path/to/pi-workbench
npm ci
npm run verify:runtime
```

Link the checkout from Pi's package directory, then run `/reload`. The repository also contains `scripts/migrate-settings.mjs` for an existing local installation; run it with `--check` before `--apply`.

## Front door

Humans use `/engineering` or its `/eng` shorthand:

```text
/engineering status
/engineering status <run-id>
/engineering inspect <question or target>
/engineering plan <approved problem>
/engineering implement <approved task>
/engineering review <change or target>
/engineering deliver Artifact: plans/feature.md; Task: T1
/engineering audit Artifact: plans/feature.md; Gate: G1
/engineering --deep review <large or unusually difficult target>
```

Models call `assign_engineering` with the same seven actions and the standard effort profile. Selection is explicit; there is no keyword router, free-form model override, or silent escalation to deep effort. Model and thinking selection remains in profiles/settings. Humans may place `--quick`, `--standard`, or `--deep` immediately before or after an action.

Model-launched `plan` and `implement`, plus every `deliver` and `audit`, start fresh contexts. Their task must therefore use `Objective:`, `Scope:`, `Constraints:`, and `Done when:` fields, or `Artifact: <path>` with a stable `Task:`, `Milestone:`, or `Gate:` ID. Semicolon-separated fields work in one-line slash commands. Inline briefs are capped at 8 KiB; longer specifications belong in a repository artifact. Referential assignments such as “all the above fixes” are not valid fresh-context handoffs.

| Action | Specialist | Capability | Hard runtime | Turn budget |
|---|---|---:|---:|---:|
| `status` | Manager and write-lock status | Read-only | None | None |
| `inspect` | Inspector | Read-only | 5 minutes | 8 + 2 grace |
| `plan` | Planner | Read-only | 15 minutes | 18 + 2 grace |
| `implement` | Implementer | Writer | 45 minutes | Runtime bound only |
| `review` | Reviewer | Read-only | 15 minutes | 18 + 2 grace |
| `deliver` | Fixed delivery chain | One implementer at a time | 60 minutes | Runtime bound only |
| `audit` | Fixed audit chain | Read-only | 20 minutes | Runtime bound only |

These are the `standard` ceilings. `quick` selects a smaller ceiling for routine work. Human-selected `deep` permits two-hour inspection, planning, and review; four-hour implementation and delivery; and three-hour audit. Deep work has a wall-clock ceiling but no conversational turn cutoff. Effort changes only time available to the selected topology—it never adds agents, workflow phases, or authority.

The writing actions intentionally use a hard runtime without a turn cutoff so a mutation is not interrupted merely because it crossed a conversational turn count. Every assignment is still time-bounded. A long run is appropriate when its scope and expected artifact justify it; duration alone never adds specialists or workflow phases.

## Adaptive playbooks

The single `pi-engineering` skill selects the lightest safe action or short action sequence:

- A repository question or diagnosis without mutation uses `inspect`.
- A clear, local, approved patch uses `implement`; add `review` when behavior or regression risk warrants independent evidence.
- An unclear failure uses `inspect` to trace expected versus observed behavior to the first bad state, followed by one bounded implementation when the cause is supported.
- A material design, interface, migration, or product decision uses `plan` before mutation.
- A bounded feature, cross-cutting fix, or risky refactor that benefits from planning, one implementer, and fresh review uses `deliver`.
- Release-critical compatibility, migration, security, or operational readiness uses the read-only `audit` action. Findings are fixed later through `implement` or `deliver`.

The method is evidence-scaled. Stable behavior changes and bugs prefer a focused regression or contract test that demonstrably fails before the fix. Risky behavior-preserving refactors use characterization coverage. Prose, generated output, and mechanical configuration use their strongest relevant validators instead of synthetic tests. Every completion claim requires fresh validation after the last mutation and inspection of the current diff.

Pi Engineering does not automatically execute an open-ended plan task by task or start review/fix retry loops. Each writing action owns one coherent approved scope and returns within its hard runtime. An authorized `deliver` may make one conditional P0/P1 repair and re-review it once inside the same write-locked run; no other severity triggers automatic mutation, and the workflow cannot repeat that repair. For substantial work, the engineering manager can obtain plan approval and assign one bounded implementation slice explicitly.

An async `deliver` or `audit` completion wakes the manager to report the result, not to launch more recovery. The in-memory assignment boundary blocks another model-initiated engineering action until direct user input, submitted Plannotator feedback, or an explicit non-status `/engineering` command authorizes the next phase. This applies equally to success, failure, and `NOT READY`; it does not shorten or interrupt the active run.

The operating rule is to choose the action before its effort. A local low-risk fix normally uses `implement`, even if the investigation was difficult. `deliver` pays for independent functional and non-functional/security review only when an end-to-end guarded change is warranted. `audit` provides the same two-model separation without write authority for a release or named review gate.

Use the smallest action that can finish the work:

- `inspect` answers a bounded repository question and locates the governing code.
- `plan` turns verified repository evidence into an implementation-ready plan.
- `implement` performs one already-approved change with focused validation.
- `review` independently inspects a change and reports only evidence-backed findings.
- `deliver` is the normal end-to-end path when planning, one implementation owner, and fresh review all add value.
- `audit` is the explicit release-critical read-only path. It is not a routine precondition for implementation.

`deliver` is a closed planner → worker → two independent review angles → synthesis path. A validated synthesis containing P0/P1 creates one repair batch, one worker, and one post-repair review; P2/P3-only or `READY` results skip both conditional steps. The run then stops regardless of the final verdict. `audit` remains two independent reviewers plus synthesis. Neither workflow permits user-programmable topology, nested workflows, or retry meshes.

## Automatic final reports

Every terminal `deliver` and `audit` report is sent to Plannotator through its public extension event API when Plannotator is installed. `READY` opens as a visual receipt; `NOT READY`, malformed output, and runtime failure open with an attention gate. Transient status updates never open a browser. The normal inline completion remains the unconditional fallback, so missing or unavailable Plannotator support cannot fail a workflow. Approve and Close acknowledge the report; they do not authorize another mutation. Submitted annotations are treated as direct human feedback and return control to the manager.

Structured review and decision receipts cap finding counts, evidence entries, risks, paths, and narrative lengths before later steps interpolate them. This keeps a verbose reviewer from multiplying context across synthesis, repair, and terminal re-review.

## Large features and durable handoffs

Pi Engineering consumes an optional project-owned Markdown work plan; it does not add a task database or another execution action. Use one only when a feature spans multiple bounded writing runs, milestones, sessions, or owners. A compatible work plan uses the stable `artifact: pi-workbench-feature-ledger` marker and carries the execution brief, specification baseline, stable task IDs, dependencies, acceptance and verification criteria, evidence, review gates, and the exact next-task handoff.

If the personal `split-work` skill is installed, invoke it explicitly for genuinely broad work. A normal request may recommend it, but will not silently create a durable work plan. The daily flow is:

```text
/skill:scope-work <idea>                         # optional: produce the execution brief
/skill:split-work Use the execution brief above # create or repair plans/<feature>.md
/engineering deliver Artifact: plans/<feature>.md; Task: T1
/engineering audit Artifact: plans/<feature>.md; Gate: G1
```

Use `implement` instead of `deliver` for a clear low-risk task. Every writing action receives one ready task or coherent current milestone, never the whole backlog. At a gate, `audit` runs two independent specification-aware reviews and a synthesis; because the audit is read-only, its plan disposition is recorded by the next authorized implementer before work advances.

The specialists intentionally keep skill inheritance disabled. The work-plan path and stable ID provide small, explicit, inspectable context instead of copying the user's entire skill catalog into every specialist.

## Roles and models

The package contains exactly five model-agnostic specialists: inspector, planner, implementer, functional reviewer, and workflow-only non-functional/security reviewer. Their stable internal IDs preserve existing model overrides:

- `pi-workbench.fast-scout`
- `pi-workbench.planner`
- `pi-workbench.worker`
- `pi-workbench.reviewer`
- `pi-workbench.risk-reviewer`

Recommended model, fallback, and thinking assignments live in `profiles/recommended-agent-overrides.json`. The worker, functional reviewer, and risk reviewer use pairwise-disjoint primary/fallback pools, so a provider fallback cannot silently collapse implementation and both review angles onto one model. Change those settings without editing role prompts, and preserve that separation.

## Configuration

Configuration keeps its stable compatibility path:

```text
~/.pi/agent/extensions/pi-workbench/config.json
```

The complete schema is:

```json
{
  "writeLock": {
    "enabled": true
  }
}
```

Unknown keys and invalid value types are rejected. A missing or invalid file falls back to the safe default with the write lock enabled. Changes take effect after `/reload`.

## Write lock

Pi Engineering acquires a durable write lock before `implement` or the write phase of `deliver`. The lock key is the canonical Git worktree root, so linked worktrees remain independent. Async completion releases the matching lock; session startup reconciles terminal runs left behind by an interruption.

Write locks use the stable compatibility directory:

```text
~/.pi/agent/workbench/writer-leases/
```

Inspect them with `/engineering status`, which also appends the shared upstream runtime inventory. Inspect a retained run with `/engineering status <run-id>`. `/engineering unlock` is an interactive, token-checked recovery operation; use it only after confirming the recorded implementer is no longer active. A stopped or failed runtime label does not release the lease until its durable terminal artifact confirms that the writer exited.

The lock applies to Pi Engineering-managed assignments, not unrelated extension tools called directly.

## Repository inspection

Pi Engineering registers `inspect_repo`, a read-only repository inspection tool shared by its five specialists. It resolves the canonical worktree root, supports a combined HEAD-to-worktree diff, and uses compact three-line diff context by default with a bounded override. Mutation remains confined to the implementer's normal editing surface. Intermediate workflow receipts use upstream run-scoped storage under `.pi-subagents/`; Pi Engineering adds no custom run database, runtime findings store, context cache, team mailbox, or workflow state store. An optional work plan is ordinary project Markdown and remains portable without Pi Engineering.

## Validation

Run the full local contract before handoff:

```bash
npm test
npm run verify:runtime
npm pack --dry-run
pi -e . --list-models
```

After `/reload`, confirm `/engineering`, `/eng`, and `assign_engineering` are present and legacy Shipyard, Teams, or Dynamic Workflow entry points are absent. `/workbench` and `/work` remain temporary compatibility aliases but are no longer the documented interface.

## Authority boundary

No action grants authority to commit, push, publish, deploy, create or alter remotes, change credentials, or perform destructive Git or data operations. Those operations require an explicit user request.
