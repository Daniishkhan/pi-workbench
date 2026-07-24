---
description: Launch Shipyard's staged, context-efficient deep review mesh
argument-hint: "[review target or focus]"
---

Use the `shipyard_workflow` tool with workflow `review` for this review target:

${@:-Review the current worktree diff against the current request, repository instructions, and existing behavior.}

This is a deterministic async launch. Do not recreate a shallow parallel-review fanout manually. Return the launch ID and ledger path, then let the normal completion notification deliver the compact synthesis.
