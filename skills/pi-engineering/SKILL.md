---
name: pi-engineering
description: Select and sequence bounded Pi Engineering actions for repository questions, debugging, features, refactors, implementation, review, and release readiness. Use when software-engineering work should be assigned through the lightest safe combination of inspect, plan, implement, review, deliver, or audit.
---

# Pi Engineering

Use Pi Engineering as the sole execution control plane. Scale the method to uncertainty and risk instead of forcing every task through the largest workflow. The engineering manager frames work, obtains material decisions, selects actions, and verifies the final claim; every specialist is a leaf.

## Select the smallest action

| Need | Action |
|---|---|
| Manager or write-lock state | `status` |
| Bounded repository question, unfamiliar control flow, or diagnosis without mutation | `inspect` |
| Clear, local, approved, low-risk patch | `implement` |
| Material behavior, scope, interface, migration, or product ambiguity | `plan` |
| Existing change needing independent verification | `review` |
| Approved bounded feature, cross-cutting fix, or risky refactor that benefits from plan, one implementation owner, and fresh review | `deliver` |
| Release-critical compatibility, migration, security, or operational readiness | `audit` |

Use `inspect` before `plan` only when a concrete repository unknown blocks planning. Use `plan` before a separate `implement` when the user should approve the approach. Use `review` after a one-off implementation when regression risk warrants independent evidence. `audit` is read-only; assign supported findings through a later `implement` or bounded `deliver`.

Do not turn routine work into `deliver` or `audit`. Do not automatically execute an open-ended plan task by task. Each writing action owns one coherent approved scope and returns within its hard runtime.

## Keep phase changes manager-led

Implicit assistance may inspect, organize, and recommend the next action. Creating a durable work plan, launching multi-specialist `deliver` or `audit`, selecting deep effort, writing files, or advancing a workflow phase requires direct user authorization. A clear natural-language request to fix or implement something authorizes one bounded implementer when the scope is already coherent; a slash command is not mandatory. Suggest explicit planning or review when it would materially improve the result, but do not silently escalate topology, persistence, effort, or authority.

## Carry durable work plans

Use a durable work plan only when work clearly spans multiple bounded writing runs, milestones, sessions, or owners. The stable compatibility marker is `artifact: pi-workbench-feature-ledger`. If broad work has no plan, recommend explicit use of `split-work` when that skill is available, or ask for confirmation before creating an equivalent single-file plan; do not force this ceremony onto a small task.

When a work plan exists, include its path and the stable task or milestone ID in every assignment. Treat its Execution brief, Spec baseline, named acceptance criteria, dependencies, and review gate as the governing scope. Each writing action owns one `ready` task or coherent milestone, never the whole open backlog. The sole implementer keeps task status, Evidence, and Handoff aligned with the current repository state and marks work done only after fresh verification. If evidence invalidates the remaining plan, mark the affected work blocked and return control instead of silently widening scope.

At a work-plan review gate, use `audit`: two independent reviewers inspect the implementation against the same specification and acceptance criteria, then the synthesis reviewer verifies their findings and returns `READY` or `NOT READY` plus a plan disposition. Because `audit` is read-only, the next authorized implementer records that gate result before advancing. A `NOT READY` result becomes a later bounded writing action; it does not start an autonomous retry loop.

## Adapt the engineering method

Include only the disciplines relevant to the task:

1. **Ground in evidence.** Read repository instructions and current source. Separate confirmed facts, hypotheses, and material decisions.
2. **Debug causally.** For failures, establish expected versus observed behavior and trace to the first bad state. Fix the causal seam rather than masking a downstream symptom. If the cause is already proven and the patch is local, `implement` directly; otherwise start with `inspect`.
3. **Plan proportionally.** For nontrivial work, state behavior, non-goals, global constraints, affected interfaces, compatibility and cleanup invariants, risks, and exact validation. Offer alternatives only when the choice is consequential.
4. **Choose test strategy by evidence value.** For a stable behavior change or bug, prefer a focused regression or contract test that fails for the intended reason before implementation. For a behavior-preserving refactor, establish characterization coverage. For prose, generated output, mechanical configuration, exploratory work, or code without a suitable harness, do not manufacture a test; run the strongest relevant validation and state the limitation.
5. **Implement minimally.** Preserve unrelated behavior, avoid speculative infrastructure, and do not weaken assertions merely to make checks pass.
6. **Verify the current state.** Run fresh focused checks after the last mutation, broaden validation in proportion to blast radius, inspect the diff, and treat child reports as claims until evidence confirms them.
7. **Review once, then converge.** Treat findings as hypotheses. Apply supported fixes in one bounded pass and verify the post-fix state. Surface remaining material defects instead of starting an autonomous retry loop.

Scope searches to likely paths, file types, and symbols. Narrow and rerun truncated or capped results; never infer absence from incomplete output. Before writing, prewalk the approved change through its governing symbols, real consumers or dispatchers, and owning tests. Remove unnecessary files and resolve plan contradictions instead of expanding scope by accident.

Keep plans and implementer handoffs readable Markdown. Make receipts proportional: for substantial work, state artifact and stable ID, scope, final state, changed behavior and files, fresh validation with outcomes, decisions, remaining work, residual risks, and the next ready task. Omit empty ceremony for small work. Intermediate reviewer steps use validated structured envelopes so later steps can consume findings without parsing prose; the terminal reviewer returns a human-readable READY or NOT READY result in the async completion summary.

For wide or risky work, recommend an isolated linked worktree when it improves safety or permits genuinely independent work. Never create, switch, merge, or use a worktree to evade the write lock without user authority.

## Action limits

Choose the action before its effort. The model-facing `assign_engineering` tool always uses `standard`; only a human slash command may explicitly select `quick`, `standard`, or `deep`. Deep effort permits long-running work inside the chosen action but never adds specialists, phases, persistence, or authority.

Standard ceilings:

- `inspect`: 5 minutes, 8 turns plus 2 grace.
- `plan`: 15 minutes, 18 turns plus 2 grace.
- `implement`: 45 minutes.
- `review`: 15 minutes, 18 turns plus 2 grace.
- `deliver`: 45 minutes and one write lock.
- `audit`: 20 minutes.

Humans use `/engineering` or `/eng`. Models call `assign_engineering`.

## Hard boundaries

- Do not nest engineering actions or ask a specialist to launch another agent.
- Only one Pi Engineering implementer may hold the canonical Git worktree's write lock.
- Read-only work may remain independent; do not create peer coordination or shared mailboxes.
- `deliver` and `audit` are fixed chains, not programmable workflow graphs.
- No action grants authority to commit, push, publish, deploy, alter remotes or credentials, or perform destructive Git/data operations.
