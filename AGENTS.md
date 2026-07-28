# Pi Engineering contributor instructions

## Architecture

Pi Engineering is one bounded assignment layer over the immutable upstream `pi-subagents` runtime. It owns five specialist prompts, two fixed workflows, explicit assignment, read-only repository inspection, and one write lock per worktree. It does not reimplement the upstream process or session runtime.

The public actions are exactly `status`, `inspect`, `plan`, `implement`, `review`, `deliver`, and `audit`. `/engineering` and `/eng` are canonical; `/workbench` and `/work` are temporary compatibility aliases. `assign_engineering` is the only model-facing assignment tool.

## Invariants

- Keep `pi-subagents` pinned and register it before constructing the shared RPC client. Never vendor, patch, or deep-import its source.
- Replace upstream's unrestricted `subagent` model tool immediately after registration. Pi Engineering uses the retained RPC bridge internally; models must launch through `assign_engineering`.
- Keep exactly five package agents: `fast-scout`, `planner`, `worker`, `reviewer`, and workflow-only `risk-reviewer` in the `pi-workbench` namespace.
- Keep exactly two package chains: `chains/workbench/deliver.chain.json` and `chains/workbench/audit.chain.json`.
- Keep `deliver` exactly planner → worker → two independent review angles → synthesis, followed only when that validated synthesis contains P0/P1 findings by one conditional repair worker and one conditional post-repair reviewer. Both conditional fan-outs must be capped at one item and the workflow must stop after the re-review. Keep `audit` exactly two independent reviewers plus synthesis.
- Specialists are leaves. Do not add recursive delegation, peer mailboxes, user-programmable graphs, additional conditional branches, or additional orchestration entry points. The two closed one-item fan-outs in `deliver` are the only package-controlled conditional topology.
- Keep one mutation-capable implementer per canonical Git worktree. Read-only specialists may run independently.
- Keep role prompts model-agnostic. Models, fallbacks, and thinking levels belong in profiles or settings.
- Keep the worker, functional reviewer, and risk reviewer model/fallback pools pairwise disjoint in the recommended profile. Review synthesis must preserve explicit functional, non-functional, and security coverage; security may be not applicable only with a concrete reason.
- Expose only `skills/pi-engineering`; do not rediscover the upstream `pi-subagents` policy skill.
- Keep the engineering playbook adaptive: causal debugging, proportional planning, evidence-valued testing, fresh verification, and independent review. Do not turn it into a mandatory spec/TDD ceremony for every change.
- Keep all assignments bounded by the central effort table. `standard` preserves these ceilings: inspect 5 minutes, plan/review 15 minutes, implement 45 minutes, deliver 60 minutes, and audit 20 minutes. `quick` is smaller. Human-selected `deep` may run read-only specialists for two hours, implementation/delivery for four hours, and audit for three hours.
- Effort changes only the ceiling for an already-selected action. It never adds specialists, phases, or authority. Keep `deep` unavailable to the model-facing assignment tool so only an explicit human command can escalate effort.
- Do not add hard turn cutoffs to mutation-capable work. Its hard runtime and write lock remain mandatory.
- Keep every fresh workflow and every model-launched plan or implementation self-contained and bounded. The initial authorization for `deliver` includes its one possible in-run critical repair; workflow completion remains a manager handoff boundary and extension-triggered completion must not authorize another assignment.
- Chain tasks do not inherit agent-level acceptance defaults. Every read-only chain task must explicitly disable generic acceptance with a reason, while its workflow receipt remains the completion contract.
- Keep the five base review schemas identical and every review/decision narrative and list practically bounded; downstream steps must never multiply unbounded reviewer prose.
- Preserve the child-only structured-output finalization shim until pinned upstream regression coverage proves that a valid terminating structured result supersedes earlier recovered tool errors.
- Never commit, push, publish, deploy, modify remotes or credentials, or perform destructive Git/data operations without explicit authorization.

## Change discipline

Prefer the smallest coherent change and the existing Pi and `pi-subagents` public APIs. Keep action selection and adaptive method guidance in `skills/pi-engineering/SKILL.md`, specialist execution discipline in the five agent prompts, assignment policy in `extensions/core/routing.ts`, launch/lock choreography in `extensions/core/guarded-spawn.ts`, static workflow execution in `extensions/workflows.ts`, and composition in `extensions/index.ts`.

Do not add new execution actions for a specialized prompt. Improve one of the five specialists or keep the specialization in the engineering manager's task instead.

For behavior changes and bugs, prefer a focused failing regression or contract test when it can express the observable contract. For risky behavior-preserving refactors, use characterization coverage. For prose, generated output, mechanical configuration, or code without a suitable harness, use the strongest relevant validation without manufacturing tests. Completion evidence must describe checks run after the last mutation.

## Validation

Run before handoff:

```bash
npm test
npm run verify:runtime
npm pack --dry-run
pi -e . --list-models
```
