---
description: Launch Shipyard's read-plan-write-review-fix-validate delivery workflow
argument-hint: "<approved implementation task>"
---

Treat the following as authorization to implement within its stated scope, but not authorization to commit, push, publish, deploy, or open a PR:

$@

Call `shipyard_workflow` with workflow `deliver` and the complete task above. Do not launch additional writers against the same active worktree while it runs. Return the launch ID and ledger path; normal async notifications will deliver the final handoff.
