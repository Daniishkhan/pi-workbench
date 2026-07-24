---
name: shipyard-review-findings
description: Record, verify, reject, and synthesize evidence-backed software review findings using Shipyard's shared shipyard_findings ledger. Use during Shipyard review, validation, falsification, blind-spot, and synthesis workflows.
---

# Shipyard review findings

Use the `shipyard_findings` tool with the exact absolute `store` path and findings `capability` supplied in the task. Pass the capability unchanged on every ledger call, never copy it into an artifact/finding, and never try to discover another stage's capability. Shipyard constrains the store to a private run directory under the user's Pi agent directory and binds workflow actions, creation stage, and source role to the capability. The store is the cross-agent handoff; do not substitute a repo-local TODO, prose-only summary, or guessed path.

## Finding threshold

Record a finding only when all are true:

1. A concrete behavior, invariant, contract, or safety property can fail.
2. Repository evidence identifies where and why.
3. A plausible failure scenario can be stated.
4. The proposed fix is smaller than or proportional to the defect.

Do not record generic praise, context summaries, formatting preferences, speculative architecture rewrites, or unsupported suspicions. If evidence is incomplete, keep confidence low and say what validation is missing.

## Required finding shape

Every `add` must include:

- `stage`: the immutable review stage named in the task;
- `title`: concise defect statement, not a category label;
- `summary`: why the behavior is wrong and its impact;
- `severity`: `blocker`, `high`, `medium`, or `low`;
- `confidence`: `high`, `medium`, or `low`;
- `category`: stable defect class such as `correctness`, `data-integrity`, `error-handling`, `compatibility`, `security`, `concurrency`, `testing`, or `ux`;
- `sourceRole`: the exact assigned namespaced reviewer role;
- `evidence`: at least one path, line/range when available, and an explanation of what it proves;
- `failureScenario`: a reproducible or logically complete trigger and observed consequence;
- `suggestedFix`: the smallest safe correction;
- `validation`: the best focused check when known;
- `tags`: useful search terms, including the review phase when applicable.

## Severity

- `blocker`: data loss/corruption, security boundary break, unusable primary flow, build/release failure, or guaranteed critical regression.
- `high`: material incorrect behavior with a realistic trigger and no safe workaround.
- `medium`: bounded bug, validation gap, or maintainability defect likely to cause incorrect changes.
- `low`: real but low-impact issue. Do not use this for taste.

## Status lifecycle

Reviewers add findings as `proposed`.

At each chain barrier, the next role creates a named `snapshot` before mutating the ledger. A falsifier or validator may then update findings:

- `verified`: evidence or reproduction confirms the defect;
- `rejected`: claim is false, already handled, outside approved scope, or unsupported;
- `deferred`: real but intentionally not fixed now; include the scope/risk reason;
- `resolved`: the fix is present and focused validation supports it.

Always call `get` immediately before `update` and pass `expectedRevision`. On revision conflict, re-read and reconsider; never blindly overwrite another agent's disposition.

## Duplicate handling and first-wave independence

When the task identifies an independent or first-wave review, do **not** call `list`, `get`, `stats`, `snapshot`, or `update` before completing your own discovery. Add your evidence directly; duplicate proposals are acceptable and are resolved after the barrier. This preserves reviewer independence and prevents anchoring on whichever peer finishes first.

After the independent barrier, call `list` and scan for the same failure mechanism before adding. If an existing finding covers it, do not add a paraphrase. Update it only when your role is authorized to strengthen evidence or set a disposition.

## Completion receipt

Your final response should stay compact because the runtime persists it as an artifact. Report:

- areas inspected;
- finding IDs added or changed;
- targeted validation performed;
- meaningful coverage gaps.

The ledger, not the final prose, is authoritative for individual findings.
