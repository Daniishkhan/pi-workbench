# Pi Workbench contributor instructions

## Architecture

Pi Workbench owns role prompts, reusable skills, routing, fixed Shipyard policy, team coordination, and bounded dynamic workflow policy. It does not reimplement the pi-subagents process/session runtime.

Use only documented Pi APIs and documented pi-subagents event protocols. Keep modules separate behind `extensions/index.ts`; a unified package is not permission to merge their state machines.

## Invariants

- Keep `pi-subagents` as an immutable upstream dependency registered by Workbench; never vendor or silently patch its source.
- Keep one mutation-capable owner per active worktree in Workbench-controlled launches.
- Never nest Shipyard, Agent Teams, or Dynamic Workflows inside one another.
- Keep generic one-off agents independent from Shipyard ledger-only roles.
- Keep role prompts model-agnostic; model and thinking choices belong in profiles/settings.
- Shipyard first-wave reviewers remain independent and use capability-scoped findings.
- Dynamic workflows remain disabled by default until explicitly enabled.
- Agent Teams defaults to one writer; parallel teammates should be read-only unless isolated externally.
- Never commit, push, publish, deploy, or create remotes without explicit authorization.

## Validation

Run before handoff:

```bash
npm test
npm run verify:runtime
npm pack --dry-run
pi -e . --list-models
```
