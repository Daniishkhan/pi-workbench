# Pi Engineering contributor instructions

## Architecture

Pi Engineering is one bounded assignment layer over the immutable upstream `pi-subagents` runtime. It owns four specialist prompts, two fixed workflows, explicit assignment, read-only repository inspection, and one write lock per worktree. It does not reimplement the upstream process or session runtime.

The public actions are exactly `status`, `inspect`, `plan`, `implement`, `review`, `deliver`, and `audit`. `/engineering` and `/eng` are canonical; `/workbench` and `/work` are temporary compatibility aliases. `assign_engineering` is the only model-facing assignment tool.

## Invariants

- Keep `pi-subagents` pinned and register it before constructing the shared RPC client. Never vendor, patch, or deep-import its source.
- Replace upstream's unrestricted `subagent` model tool immediately after registration. Pi Engineering uses the retained RPC bridge internally; models must launch through `assign_engineering`.
- Keep exactly four package agents: `fast-scout`, `planner`, `worker`, and `reviewer` in the `pi-workbench` namespace.
- Keep exactly two package chains: `chains/workbench/deliver.chain.json` and `chains/workbench/audit.chain.json`.
- Specialists are leaves. Do not add recursive delegation, peer mailboxes, programmable graphs, or additional orchestration entry points.
- Keep one mutation-capable implementer per canonical Git worktree. Read-only specialists may run independently.
- Keep role prompts model-agnostic. Models, fallbacks, and thinking levels belong in profiles or settings.
- Expose only `skills/pi-engineering`; do not rediscover the upstream `pi-subagents` policy skill.
- Keep the engineering playbook adaptive: causal debugging, proportional planning, evidence-valued testing, fresh verification, and independent review. Do not turn it into a mandatory spec/TDD ceremony for every change.
- Keep all assignments bounded by the central effort table. `standard` preserves the original ceilings: inspect 5 minutes, plan/review 15 minutes, implement/deliver 45 minutes, and audit 20 minutes. `quick` is smaller. Human-selected `deep` may run read-only specialists for two hours, implementation/delivery for four hours, and audit for three hours.
- Effort changes only the ceiling for an already-selected action. It never adds specialists, phases, or authority. Keep `deep` unavailable to the model-facing assignment tool so only an explicit human command can escalate effort.
- Do not add hard turn cutoffs to mutation-capable work. Its hard runtime and write lock remain mandatory.
- Never commit, push, publish, deploy, modify remotes or credentials, or perform destructive Git/data operations without explicit authorization.

## Change discipline

Prefer the smallest coherent change and the existing Pi and `pi-subagents` public APIs. Keep action selection and adaptive method guidance in `skills/pi-engineering/SKILL.md`, specialist execution discipline in the four agent prompts, assignment policy in `extensions/core/routing.ts`, launch/lock choreography in `extensions/core/guarded-spawn.ts`, static workflow execution in `extensions/workflows.ts`, and composition in `extensions/index.ts`.

Do not add new execution actions for a specialized prompt. Improve one of the four specialists or keep the specialization in the engineering manager's task instead.

For behavior changes and bugs, prefer a focused failing regression or contract test when it can express the observable contract. For risky behavior-preserving refactors, use characterization coverage. For prose, generated output, mechanical configuration, or code without a suitable harness, use the strongest relevant validation without manufacturing tests. Completion evidence must describe checks run after the last mutation.

## Validation

Run before handoff:

```bash
npm test
npm run verify:runtime
npm pack --dry-run
pi -e . --list-models
```
