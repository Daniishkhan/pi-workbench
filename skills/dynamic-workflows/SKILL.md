---
name: dynamic-workflows
description: |
  Create and run bounded, human-approved JavaScript workflow DSL programs for
  exhaustive audits, multi-phase fanout, per-item verification, bounded loops,
  branches, migrations, and repeatable engineering pipelines. Use workflows
  when process automation matters more than teammate-to-teammate collaboration.
---

# Dynamic Workflows

Use a dynamic workflow when the task needs deterministic fanout, multiple phases, bounded iteration, branching, or independent verification across many targets. Do not use it for one bounded specialist task (use `subagent`) or a handful of workers that need to communicate (use agent teams).

## Required sequence

1. Create a bounded source program with `dynamic_create`.
2. Inspect the compiler preview and fix validation errors.
3. Call `dynamic_run`; never claim execution before the human approves it.
4. Use `dynamic_control` for monitoring and control; humans enter through `/workbench dynamic <task>`.
5. Save only when the user asks for reuse.

## Safety defaults

- Start with `size: "small"` and `permissions: ["read"]`.
- Use fresh child context unless the task truly requires parent history and the manifest explicitly grants `"fork-context"`.
- Every `forEach` needs `maxItems`; every `repeat` needs `maxIterations` and `until`.
- Prefer read-only discovery/review fanout, then one explicit writer, then read-only verification.
- Parallel writer batches are rejected. Use exactly one serialized writer node followed by read-only verification; Workbench does not create worktrees through the foreground delegation protocol.
- Do not place secrets in source or inputs.
- Do not use custom fanout agents that can launch their own subagents; the workflow owns orchestration.
- Return only the final synthesis with `result`. Intermediate values should stay referenced by downstream nodes.

## DSL constraints

Source must be exactly one `workflow({...})` expression. It is parsed, never evaluated as arbitrary JavaScript. Do not use imports, exports, variables, callbacks, native loops/conditions, member calls, promises, `eval`, filesystem, network, or process APIs.

Supported builders:

- Nodes: `phase`, `run`, `parallel`, `forEach`, `when`, `repeat`, `set`
- References: `input`, `output`, `variable`, `item`
- Conditions: `equals`, `exists`, `notEmpty`, `not`, `and`, `or`

Use strings with workflow placeholders, not JavaScript interpolation:

```text
{{input.request}}
{{outputs.discovery.targets}}
{{target.path}}
{{iteration}}
```

## Minimal source

```js
workflow({
  version: 1,
  name: "review-target",
  description: "Review one target and return a verified report.",
  size: "small",
  permissions: ["read"],
  phases: ["Review", "Verify"],
  maxAgents: 2,
  steps: [
    phase("Review", [
      run("review", {
        agent: "pi-workbench.reviewer",
        saveAs: "findings",
        task: "Review {{input.request}}. Require file:line evidence."
      })
    ]),
    phase("Verify", [
      run("verify", {
        agent: "pi-workbench.reviewer",
        saveAs: "report",
        task: "Challenge these findings against source and return only supported conclusions:\n\n{{outputs.findings}}"
      })
    ])
  ],
  result: output("report")
});
```

## Bounded fanout

Use a schema on discovery so downstream references are deterministic. `forEach` may run its single `run` body as a bounded parallel batch.

```js
phase("Discover", [
  run("discover", {
    agent: "pi-workbench.fast-scout",
    saveAs: "targets",
    task: "Find targets for {{input.request}}.",
    schema: {
      type: "object",
      required: ["items"],
      properties: {
        items: { type: "array", maxItems: 4, items: { type: "string" } }
      }
    }
  })
]),
phase("Review", [
  forEach("review-items", {
    from: output("targets", "/items"),
    as: "target",
    maxItems: 4,
    concurrency: 4,
    collectAs: "reviews",
    steps: [
      run("review-item", {
        agent: "pi-workbench.reviewer",
        saveAs: "review",
        task: "Review {{target}} for {{input.request}}."
      })
    ]
  })
])
```

The complete outer source still needs the workflow manifest, all declared phases, and one `result`.

## Branches and loops

Use reference-based conditions:

```js
when("has-findings", notEmpty(output("findings")), [
  run("synthesize", { agent: "pi-workbench.reviewer", saveAs: "report", task: "Synthesize {{outputs.findings}}" })
], [
  set("report", "No supported findings.")
])
```

Use `repeat` only when a stable output is overwritten each round and the condition can terminate. Reaching the cap without satisfying `until` fails the workflow.

```js
repeat("review-loop", {
  maxIterations: 3,
  until: equals(output("review_state", "/clean"), true),
  collectAs: "rounds",
  steps: [
    run("review-round", {
      agent: "pi-workbench.reviewer",
      saveAs: "review_state",
      task: "Review round {{iteration}} for {{input.request}}. Return JSON with clean:boolean.",
      schema: {
        type: "object",
        required: ["clean"],
        properties: { clean: { type: "boolean" } }
      }
    })
  ]
})
```

Avoid automatic fix loops unless one writer owns the active worktree and the workflow's write permission is explicit.

## Choosing the mechanism

- Use `subagent` for one isolated result.
- Use agent teams for 2–5 long-running workers that need shared tasks or direct messages.
- Use dynamic workflows for a repeatable process: discover → fan out → verify → synthesize, or bounded test/fix/retest.
