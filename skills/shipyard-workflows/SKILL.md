---
name: shipyard-workflows
description: Orchestrate Pi code work through Shipyard's deterministic explore, debug, review, deliver, and ship workflows. Use for codebase questions, failure triage, deep review, agentic delivery, implementation-to-shipping, or the Shipyard workflow family.
---

# Shipyard workflows

Shipyard layers opinionated workflows on `pi-subagents`; it does not replace the subagent runtime.

## Preferred entry points

For natural-language orchestration, call `shipyard_workflow`:

- `explore`: grep-driven codebase Q&A, call-path tracing, history, and reusable repository context;
- `debug`: scope, safely reproduce, localize, establish root cause, and propose the smallest fix;
- `fast`: two independent bug-finding angles followed by compact synthesis;
- `review`: scope mapping, four independent reviewers, falsifier, blind-spot hunter, and synthesis;
- `security`: the review mesh with a dedicated security boundary reviewer;
- `ui`: UI behavior, state-flow, interaction, accessibility, and visual-risk review;
- `compact`: slice-sized delivery — implement, two-angle review, falsification, fixes, and readiness handoff;
- `deliver`: read, plan, implement, run a focused two-angle review, apply verified fixes, and prepare a validated shipping handoff;
- `ship`: review and fix an existing diff, revalidate, and prepare a shipping handoff.

Humans use one command: `/shipyard <mode> [task]`. Run `/shipyard` without arguments for the compact mode list.

## Context discipline

- Intermediate review and debug outputs use `outputMode: "file-only"`.
- `shipyard_context` is reusable orientation bound to the repository root and HEAD; stale context must be verified and never overrides current source.
- Review findings live in a private, extension-created run directory; never use `{chain_dir}` as an async artifact path.
- Workflow placeholders are resolved before pi-subagents RPC launch, so children receive exact absolute store paths.
- Only the final synthesis or shipping receipt returns inline.
- Read detailed artifacts only when needed to verify or act on a specific claim.
- Do not substitute `output: false`; it disables persistence but still returns full child output inline.

## Review independence

The first review wave stays independent to avoid anchoring. A second wave deliberately shares findings:

1. falsifier snapshots the first-wave ledger, then verifies or rejects proposed findings;
2. blind-spot hunter runs after falsification, snapshots that state, then searches uncovered risk classes and sibling defects;
3. synthesizer snapshots the final discovery state and adjudicates a compact report.

Do not enable unstructured live peer discussion as a replacement for this staged exchange.

## Workflow selection

- Use `explore` for repository questions, symbol/caller tracing, architecture mapping, and history-backed explanations.
- Use `debug` for failures, stack traces, failing checks, regressions, or root-cause triage. It investigates and proposes a fix but does not edit source.
- Use `fast` for small, isolated, low-risk changes.
- Use `review` for normal features, bug fixes, refactors, or broad diffs.
- Use `security` whenever trust boundaries, auth, commands, secrets, privileged operations, or untrusted input are involved.
- Use `ui` for user-facing state, interactions, responsiveness, and accessibility.
- Use `compact` for pre-approved, well-specified slices that need implementation plus a fast verified review.
- Use `deliver` when implementation is authorized and should proceed end to end.
- Use `ship` when code already exists and needs review/fix/validation before handoff.

Reviewer failure is a hard gate: the chain does not synthesize a partial review when a required reviewer fails. All writer workflows retain one active-worktree writer. Shipyard never commits, pushes, publishes, deploys, or opens a PR automatically.
