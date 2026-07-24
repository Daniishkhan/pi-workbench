# Third-party components

Pi Workbench keeps its orchestration code and externally maintained runtime code separate, even though Workbench is the single top-level Pi package.

## pi-subagents

- Upstream: <https://github.com/nicobailon/pi-subagents>
- License: MIT
- Upstream package version: `0.35.1`
- Snapshot: main commit `105c1399d36517292cc7dbe1f56f4724de39bd10`
- Dependency source: the immutable GitHub codeload archive for that commit
- Locking: `package-lock.json` records the archive URL and SHA-512 integrity

The snapshot is used without source modifications. Workbench imports only the package's public default extension entry point at runtime. Workbench integration uses pi-subagents' public versioned RPC and delegation event contracts; it does not deep-import upstream implementation modules.

To update it, select and review a new upstream commit, update both `package.json` and `scripts/verify-runtime.mjs`, run `npm install`, then run the full Workbench test and Pi discovery suite. Never point a released Workbench version at a floating branch.

`pi-subagents` brings its own declared runtime dependencies (`jiti`, `yaml`, and `typebox`), recorded in the lockfile.

## Acorn

- Upstream: <https://github.com/acornjs/acorn>
- Version: `8.17.0`
- License: MIT

Acorn parses the restricted Dynamic Workflows DSL. Workbench validates the resulting syntax tree and never evaluates arbitrary JavaScript.

## Pi host APIs

`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, and `typebox` are host/peer APIs. They are not Workbench-owned runtime forks. Development versions are pinned locally for type-checking; the active Pi installation supplies the runtime APIs.
