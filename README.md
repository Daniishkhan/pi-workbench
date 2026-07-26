# Pi Workbench

Pi Workbench is a small, bounded software-engineering harness for Pi. It gives one accountable parent agent four focused roles, two fixed workflows, and one adaptive engineering playbook while relying on the immutable upstream `pi-subagents` package for process and session execution.

The design deliberately has one orchestration layer. There are no agent teams, programmable workflow graphs, recursive delegations, or alternate policy skills. The playbook changes the method—not the topology—so a documentation edit, a causal bug investigation, and a release audit do not receive the same ceremony.

## Execution model

```text
/workbench or workbench_route
  ├─ inspect   → one read-only scout
  ├─ plan      → one read-only planner
  ├─ implement → one leased writer
  ├─ review    → one fresh read-only reviewer
  ├─ deliver   → fixed plan/write/review workflow
  └─ audit     → fixed read-only audit workflow
                       │
             pinned pi-subagents runtime
```

The parent owns task framing, routing, and final synthesis. Children complete one bounded assignment and cannot launch more orchestration. Workbench permits only one managed writer per Git worktree; read-only work remains independent.

## Requirements

- Pi 0.81.1 or newer
- Node.js 24 or newer
- Network access during installation to fetch the integrity-locked `pi-subagents` snapshot

The upstream source and lock are documented in [THIRD_PARTY.md](./THIRD_PARTY.md). Workbench registers that runtime before its own RPC client, but exposes only the `pi-workbench` policy skill.

The upstream runtime's unrestricted `subagent` model tool is replaced with a small rejection boundary. Its RPC bridge remains internal, so model-initiated launches must pass through `workbench_route` and its fixed limits. Upstream slash commands remain an explicit human-operated escape hatch; they are outside the bounded model-routing contract.

## Install from this checkout

```bash
cd /path/to/pi-workbench
npm ci
npm run verify:runtime
```

Link the checkout from Pi's package directory, then run `/reload`. The repository also contains `scripts/migrate-settings.mjs` for an existing local installation; run it with `--check` before `--apply`.

## Front door

Humans use `/workbench` or its `/work` alias:

```text
/workbench status
/workbench inspect <question or target>
/workbench plan <approved problem>
/workbench implement <approved task>
/workbench review <change or target>
/workbench deliver <approved end-to-end task>
/workbench audit <release-critical target>
```

Models call `workbench_route` with the same seven modes. Selection is explicit; there is no keyword router.

| Mode | Execution | Capability | Hard runtime | Turn budget |
|---|---|---:|---:|---:|
| `status` | Parent-only harness and writer-lease status | Read-only | None | None |
| `inspect` | `pi-workbench.fast-scout` | Read-only | 5 minutes | 8 + 2 grace |
| `plan` | `pi-workbench.planner` | Read-only | 15 minutes | 18 + 2 grace |
| `implement` | `pi-workbench.worker` | Writer | 45 minutes | Runtime bound only |
| `review` | `pi-workbench.reviewer` | Read-only | 15 minutes | 18 + 2 grace |
| `deliver` | Fixed delivery chain | One writer | 45 minutes | Runtime bound only |
| `audit` | Fixed audit chain | Read-only | 20 minutes | Runtime bound only |

The writing routes intentionally use a hard runtime without a turn cutoff so a mutation is not interrupted merely because it crossed a conversational turn count. Every launch is still time-bounded.

## Adaptive playbooks

The single `pi-workbench` skill selects the lightest safe route or short route sequence:

- A repository question or diagnosis without mutation uses `inspect`.
- A clear, local, approved patch uses `implement`; add `review` when behavior or regression risk warrants independent evidence.
- An unclear failure uses `inspect` to trace expected versus observed behavior to the first bad state, followed by one bounded implementation when the cause is supported.
- A material design, interface, migration, or product decision uses `plan` before mutation.
- A bounded feature, cross-cutting fix, or risky refactor that benefits from plan, one writer, and fresh review uses `deliver`.
- Release-critical compatibility, migration, security, or operational readiness uses the read-only `audit` route. Findings are fixed later through `implement` or `deliver`.

The method is evidence-scaled. Stable behavior changes and bugs prefer a focused regression or contract test that demonstrably fails before the fix. Risky behavior-preserving refactors use characterization coverage. Prose, generated output, and mechanical configuration use their strongest relevant validators instead of synthetic tests. Every completion claim requires fresh validation after the last mutation and inspection of the current diff.

Workbench does not automatically execute an open-ended plan task by task or start review/fix retry loops. Each writing route owns one coherent approved scope and returns within its hard runtime. For substantial work, the parent can obtain plan approval and route a bounded implementation slice explicitly.

Use the smallest mode that can finish the work:

- `inspect` answers a bounded repository question and locates the governing code.
- `plan` turns verified repository evidence into an implementation-ready plan.
- `implement` performs one already-approved change with focused validation.
- `review` independently inspects a change and reports only evidence-backed findings.
- `deliver` is the normal end-to-end path when planning, one implementation owner, and fresh review all add value.
- `audit` is the explicit release-critical read-only path. It is not a routine precondition for implementation.

`deliver` and `audit` are static package chains, not user-programmable graphs. They do not branch into teams, retry meshes, or nested workflows.

## Roles and models

The package contains exactly four model-agnostic leaf roles. Their prompts share the adaptive evidence discipline while retaining distinct capabilities:

- `pi-workbench.fast-scout`
- `pi-workbench.planner`
- `pi-workbench.worker`
- `pi-workbench.reviewer`

Recommended model, fallback, and thinking assignments live in `profiles/recommended-agent-overrides.json`. Change those settings without editing role prompts.

## Configuration

Configuration lives at:

```text
~/.pi/agent/extensions/pi-workbench/config.json
```

The complete schema is:

```json
{
  "writerGuard": {
    "enabled": true
  }
}
```

Unknown keys and invalid value types are rejected. A missing or invalid file falls back to the safe default with the writer guard enabled. Changes take effect after `/reload`.

## Writer guard

Workbench acquires a durable lease before `implement` or the write phase of `deliver`. The lease key is the canonical Git worktree root, so linked worktrees remain independent. Async completion releases the matching lease; session startup reconciles terminal runs left behind by an interruption.

Leases live under:

```text
~/.pi/agent/workbench/writer-leases/
```

Inspect them with `/workbench status`. `/workbench release-writer` is an interactive recovery operation, not an execution mode; use it only after confirming the recorded writer is no longer active.

The guard applies to Workbench-managed launches, not unrelated extension tools called directly.

## Repository inspection

Workbench registers `workbench_repo`, a read-only repository inspection tool shared by its four roles. Mutation remains confined to the worker's normal editing surface. Intermediate chain receipts use upstream `pi-subagents` run storage under `.pi-subagents/chain-runs/<runId>`; Workbench adds no custom run database, findings ledger, context cache, team mailbox, or dynamic workflow store.

## Validation

Run the full local contract before handoff:

```bash
npm test
npm run verify:runtime
npm pack --dry-run
pi -e . --list-models
```

After `/reload`, confirm `/workbench`, `/work`, and `workbench_route` are present and legacy Shipyard, Teams, or Dynamic Workflow entry points are absent.

## Authority boundary

No mode grants authority to commit, push, publish, deploy, create or alter remotes, change credentials, or perform destructive Git or data operations. Those actions require an explicit user request.
