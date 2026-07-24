---
name: shipyard-validation
description: Define and execute evidence-based validation for code changes, climbing from static checks to changed-path behavior and directly observed user flows. Use during planning, implementation, review, fixing, and shipping.
---

# Shipyard validation

Validation must demonstrate that the changed behavior executed. Exit code alone is evidence only for what the command actually exercised.

## Validation ladder

Climb only as high as the risk requires:

1. syntax, formatting, lint, type, and focused unit checks;
2. focused changed-module or changed-package tests;
3. integration, dry-run, migration, or protocol tests;
4. direct CLI/API/browser/user-flow exercise;
5. realistic end-to-end or live probe for high-risk behavior.

Capture the exact command or interaction, exit status, relevant output, and what behavior it proves. If a check cannot run, state why and run the strongest available substitute.

## Baseline and deltas

When practical, characterize the baseline before editing. After changes:

- distinguish pre-existing failures from regressions;
- confirm the target branch or behavior executed;
- inspect generated artifacts, screenshots, logs, or persisted state directly;
- rerun affected checks after review fixes;
- do not weaken assertions or skip required checks to obtain green output.

## Validation contract

Before implementation, define:

- expected behavior;
- negative and edge cases;
- commands or flows to exercise;
- required evidence in the worker handoff;
- acceptable residual risks.

Reviewers validate against this contract rather than the implementation's own assumptions.
