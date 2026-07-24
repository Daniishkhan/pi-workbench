---
name: shipyard-delivery
description: Deliver approved code changes with one writer, bounded scope, repository-rule compliance, useful handoffs, review-driven fixes, and conservative commit/push boundaries. Use for implementation, fix, and shipping roles.
---

# Shipyard delivery

## One writer

Only one agent edits the active worktree at a time. Parallelize reading, review, and validation, not normal writes. Do not modify source files while another writer owns the same worktree.

## Before editing

Read repository instructions and the supplied scope/plan artifacts. Confirm:

- approved behavior and non-goals;
- likely files and integration seams;
- validation contract;
- decisions that remain user-owned.

Decide reversible choices yourself: pick the conservative option that best matches existing patterns for product, public API, architecture, migration, cost, or security tradeoffs, and record each in a `Decisions made` section of the handoff. Escalate through the supervisor channel only before irreversible or destructive actions: data loss, deleting branches/tables/volumes, force-push, publish/deploy, credential or secret changes, altering remotes.

## During implementation

- use existing patterns and source-of-truth types;
- keep changes inside approved scope;
- preserve useful error signals and cleanup semantics;
- add or update focused tests at the appropriate layer;
- inspect the diff as it grows;
- never loosen an assertion merely to make validation pass.

When applying review feedback, read the shared findings ledger. Apply verified fixes worth doing now. Do not implement rejected, deferred, speculative, or optional findings unless explicitly authorized.

## Handoff

Return:

- changed files and behavior;
- tests or validation added;
- commands run with exit status;
- direct evidence observed;
- findings resolved, with IDs;
- work left undone;
- surprises, residual risks, and decisions needing approval;
- git status, including staged state.

## Shipping boundary

Do not commit, push, publish, deploy, open a PR, sync issue databases, or alter remotes unless the task explicitly authorizes that action. Preparing a shipping handoff is not authorization to perform remote or irreversible actions.
