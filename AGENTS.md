# Pi Workbench contributor instructions

## Architecture

Pi Workbench is one bounded orchestration layer over the immutable upstream `pi-subagents` runtime. It owns four role prompts, two fixed chains, explicit routing, read-only repository inspection, and one-writer-per-worktree leases. It does not reimplement the upstream process or session runtime.

The public modes are exactly `status`, `inspect`, `plan`, `implement`, `review`, `deliver`, and `audit`. `/workbench` and `/work` are the only package commands; `workbench_route` is the only model-facing router.

## Invariants

- Keep `pi-subagents` pinned and register it before constructing the shared RPC client. Never vendor, patch, or deep-import its source.
- Replace upstream's unrestricted `subagent` model tool immediately after registration. Workbench uses the retained RPC bridge internally; models must launch through `workbench_route`.
- Keep exactly four package agents: `fast-scout`, `planner`, `worker`, and `reviewer` in the `pi-workbench` namespace.
- Keep exactly two package chains: `chains/workbench/deliver.chain.json` and `chains/workbench/audit.chain.json`.
- Children are leaf workers. Do not add recursive delegation, peer mailboxes, programmable graphs, or additional orchestration entry points.
- Keep one mutation-capable owner per canonical Git worktree. Read-only roles may run independently.
- Keep role prompts model-agnostic. Models, fallbacks, and thinking levels belong in profiles or settings.
- Expose only `skills/pi-workbench`; do not rediscover the upstream `pi-subagents` policy skill.
- Keep the engineering playbook adaptive: causal debugging, proportional planning, evidence-valued testing, fresh verification, and independent review. Do not turn it into a mandatory spec/TDD ceremony for every change.
- Keep all launches bounded by the central route table:
  - inspect: 5 minutes, 8 turns plus 2 grace;
  - plan: 15 minutes, 18 turns plus 2 grace;
  - implement: 45 minutes;
  - review: 15 minutes, 18 turns plus 2 grace;
  - deliver: 45 minutes;
  - audit: 20 minutes.
- Do not add hard turn cutoffs to mutation-capable work. Its hard runtime and writer lease remain mandatory.
- Never commit, push, publish, deploy, modify remotes or credentials, or perform destructive Git/data operations without explicit authorization.

## Change discipline

Prefer the smallest coherent change and the existing Pi and `pi-subagents` public APIs. Keep route selection and adaptive method guidance in `skills/pi-workbench/SKILL.md`, role-specific execution discipline in the four agent prompts, routing policy in `extensions/core/routing.ts`, launch/lease choreography in `extensions/core/guarded-spawn.ts`, static workflow execution in `extensions/workflows.ts`, and composition in `extensions/index.ts`.

Do not add new execution modes for a specialized prompt. Improve one of the four roles or keep the specialization in the parent task instead.

For behavior changes and bugs, prefer a focused failing regression or contract test when it can express the observable contract. For risky behavior-preserving refactors, use characterization coverage. For prose, generated output, mechanical configuration, or code without a suitable harness, use the strongest relevant validation without manufacturing tests. Completion evidence must describe checks run after the last mutation.

## Validation

Run before handoff:

```bash
npm test
npm run verify:runtime
npm pack --dry-run
pi -e . --list-models
```
