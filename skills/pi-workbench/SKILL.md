---
name: pi-workbench
description: Select and sequence bounded Pi Workbench modes for repository questions, debugging, features, refactors, implementation, review, and release readiness. Use when software-engineering work should be routed through the lightest safe combination of inspect, plan, implement, review, deliver, or audit.
---

# Pi Workbench

Use Workbench as the sole execution control plane. Scale the method to uncertainty and risk instead of forcing every task through the largest workflow. The parent frames work, obtains material decisions, selects routes, and verifies the final claim; every child is a leaf.

## Select the smallest playbook

| Need | Route |
|---|---|
| Harness or writer-lease state | `status` |
| Bounded repository question, unfamiliar control flow, or diagnosis without mutation | `inspect` |
| Clear, local, approved, low-risk patch | `implement` |
| Material behavior, scope, interface, migration, or product ambiguity | `plan` |
| Existing change needing independent verification | `review` |
| Approved bounded feature, cross-cutting fix, or risky refactor that benefits from plan, one implementation owner, and fresh review | `deliver` |
| Release-critical compatibility, migration, security, or operational readiness | `audit` |

Use `inspect` before `plan` only when a concrete repository unknown blocks planning. Use `plan` before a separate `implement` when the user should approve the approach. Use `review` after a one-off implementation when regression risk warrants independent evidence. `audit` is read-only; route supported findings through a later `implement` or bounded `deliver`.

Do not turn routine work into `deliver` or `audit`. Do not automatically execute an open-ended plan task by task. Each writing route owns one coherent approved scope and returns within its hard runtime.

## Adapt the engineering method

Include only the disciplines relevant to the task:

1. **Ground in evidence.** Read repository instructions and current source. Separate confirmed facts, hypotheses, and material decisions.
2. **Debug causally.** For failures, establish expected versus observed behavior and trace to the first bad state. Fix the causal seam rather than masking a downstream symptom. If the cause is already proven and the patch is local, `implement` directly; otherwise start with `inspect`.
3. **Plan proportionally.** For nontrivial work, state behavior, non-goals, global constraints, affected interfaces, compatibility and cleanup invariants, risks, and exact validation. Offer alternatives only when the choice is consequential.
4. **Choose test strategy by evidence value.** For a stable behavior change or bug, prefer a focused regression or contract test that fails for the intended reason before implementation. For a behavior-preserving refactor, establish characterization coverage. For prose, generated output, mechanical configuration, exploratory work, or code without a suitable harness, do not manufacture a test; run the strongest relevant validation and state the limitation.
5. **Implement minimally.** Preserve unrelated behavior, avoid speculative infrastructure, and do not weaken assertions merely to make checks pass.
6. **Verify the current state.** Run fresh focused checks after the last mutation, broaden validation in proportion to blast radius, inspect the diff, and treat child reports as claims until evidence confirms them.
7. **Review once, then converge.** Treat findings as hypotheses. Apply supported fixes in one bounded pass and verify the post-fix state. Surface remaining material defects instead of starting an autonomous retry loop.

For wide or risky work, recommend an isolated linked worktree when it improves safety or permits genuinely independent work. Never create, switch, merge, or use a worktree to evade the writer lease without user authority.

## Route limits

- `inspect`: 5 minutes, 8 turns plus 2 grace.
- `plan`: 15 minutes, 18 turns plus 2 grace.
- `implement`: 45 minutes.
- `review`: 15 minutes, 18 turns plus 2 grace.
- `deliver`: 45 minutes and one writer lease.
- `audit`: 20 minutes.

Humans use `/workbench` or `/work`. Models call `workbench_route`.

## Hard boundaries

- Do not nest Workbench routes or ask a child to launch another agent.
- Only one Workbench-managed writer may own a canonical Git worktree.
- Read-only work may remain independent; do not create peer coordination or shared mailboxes.
- `deliver` and `audit` are fixed chains, not programmable workflow graphs.
- No mode grants authority to commit, push, publish, deploy, alter remotes or credentials, or perform destructive Git/data operations.
