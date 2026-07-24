import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { compileWorkflowSource } from "../../extensions/dynamic/compiler.ts";
import { WorkflowStore, writeJsonAtomic } from "../../extensions/dynamic/store.ts";
import { workflowSourceHash } from "../../extensions/dynamic/manifest.ts";
import type { WorkflowRunSnapshot } from "../../extensions/dynamic/types.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function source(name = "store-flow"): string {
	return `workflow({
  version: 1,
  name: "${name}",
  description: "Store test.",
  size: "small",
  permissions: ["read"],
  phases: ["Run"],
  steps: [phase("Run", [run("review", { agent: "pi-workbench.reviewer", saveAs: "report", task: "Review" })])],
  result: output("report")
});`;
}

function makeStore(projectTrusted: boolean): { root: string; store: WorkflowStore } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-store-test-"));
	roots.push(root);
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "project");
	fs.mkdirSync(cwd, { recursive: true });
	return {
		root,
		store: new WorkflowStore({ agentDir, cwd, configDirName: ".pi", sessionId: "session-1", projectTrusted }),
	};
}

test("stages exact normalized source bytes and resolves drafts first", () => {
	const { store } = makeStore(true);
	const raw = source();
	const compiled = compileWorkflowSource(raw);
	const staged = store.stage("store-flow", raw, compiled.manifest);
	assert.ok(staged.source.endsWith("\n"));
	assert.equal(staged.hash, workflowSourceHash(fs.readFileSync(staged.path, "utf8")));
	assert.equal(store.resolve("store-flow").scope, "draft");
});

test("preserves Workbench workflow, draft, run, and trust roots", () => {
	const { root, store } = makeStore(true);
	assert.equal(store.userRoot, path.join(root, "agent", "workbench", "dynamic", "saved"));
	assert.equal(store.projectRoot, path.join(root, "project", ".pi", "workflows"));
	assert.equal(store.draftRoot, path.join(root, "agent", "workbench", "dynamic", "drafts", "session-1"));
	assert.equal(store.runsRoot, path.join(root, "agent", "workbench", "dynamic", "runs", "session-1"));
	assert.equal(store.trustPath, path.join(root, "agent", "workbench", "dynamic", "trust.json"));
	assert.equal(store.legacyUserRoot, path.join(root, "agent", "workflows"));
	assert.equal(store.legacyDraftRoot, path.join(root, "agent", "workflow-drafts", "session-1"));
	assert.equal(store.legacyRunsRoot, path.join(root, "agent", "workflow-runs", "session-1"));
	assert.equal(store.legacyTrustPath, path.join(root, "agent", "workflow-trust.json"));
});

test("saved-only resolution and listings cannot be shadowed by drafts", () => {
	const { store } = makeStore(true);
	const savedRaw = source("saved-flow");
	store.stage("saved-flow", savedRaw, compileWorkflowSource(savedRaw).manifest);
	const saved = store.saveDraft("saved-flow", "user");
	const changedRaw = savedRaw.replace("Store test.", "Draft shadow.");
	store.stage("saved-flow", changedRaw, compileWorkflowSource(changedRaw).manifest);
	const draftOnlyRaw = source("draft-only");
	store.stage("draft-only", draftOnlyRaw, compileWorkflowSource(draftOnlyRaw).manifest);

	assert.equal(store.resolve("saved-flow").scope, "draft");
	assert.equal(store.resolveSaved("saved-flow").scope, "user");
	assert.equal(store.resolveSaved("saved-flow").source, saved.source);
	assert.deepEqual(store.listSaved().map((entry) => [entry.name, entry.scope]), [["saved-flow", "user"]]);
});

test("saves and trusts an exact user hash", () => {
	const { store } = makeStore(true);
	const raw = source();
	const staged = store.stage("store-flow", raw, compileWorkflowSource(raw).manifest);
	const saved = store.saveDraft("store-flow", "user");
	assert.equal(saved.scope, "user");
	assert.equal(store.isTrusted(saved), false);
	store.trust(saved);
	assert.equal(store.isTrusted(saved), true);
	fs.appendFileSync(saved.path, "// changed\n");
	const changed = { ...saved, hash: workflowSourceHash(fs.readFileSync(saved.path, "utf8")) };
	assert.equal(store.isTrusted(changed), false);
	assert.equal(staged.name, saved.name);
});

test("does not read or write project workflows when project is untrusted", () => {
	const { store } = makeStore(false);
	const raw = source("project-flow");
	const projectRoot = store.projectRoot;
	fs.mkdirSync(projectRoot, { recursive: true });
	fs.writeFileSync(path.join(projectRoot, "project-flow.workflow.js"), `${raw}\n`);
	writeJsonAtomic(path.join(projectRoot, "project-flow.workflow.json"), {
		version: 1,
		name: "project-flow",
		hash: workflowSourceHash(`${raw}\n`),
		manifest: compileWorkflowSource(raw).manifest,
		updatedAt: Date.now(),
	});
	assert.equal(store.list().some((entry) => entry.name === "project-flow"), false);
	assert.throws(() => store.resolve("project-flow"), /not found/);
	assert.throws(() => store.saveDraft("project-flow", "project"), /trusted project/);
	assert.throws(() => store.deleteSaved("project-flow", "project"), /trusted project/);
});

test("rejects non-finite and undefined JSON persistence instead of coercing values", () => {
	const { root } = makeStore(true);
	const file = path.join(root, "unsafe.json");
	assert.throws(() => writeJsonAtomic(file, { bad: Number.NaN }), /non-finite JSON number/);
	assert.throws(() => writeJsonAtomic(file, { bad: Number.POSITIVE_INFINITY }), /non-finite JSON number/);
	assert.throws(() => writeJsonAtomic(file, undefined), /undefined JSON root/);
	assert.equal(fs.existsSync(file), false);
});

test("reads legacy pre-unification saved workflows, run statuses, and trust as a fallback", () => {
	const { root, store } = makeStore(true);
	const raw = source("legacy-flow");
	const normalized = `${raw}\n`;
	const manifest = compileWorkflowSource(raw).manifest;
	const hash = workflowSourceHash(normalized);

	// Seed the legacy (pre-unification) saved-workflow root directly.
	const legacySaved = path.join(root, "agent", "workflows");
	fs.mkdirSync(legacySaved, { recursive: true });
	const legacySourcePath = path.join(legacySaved, "legacy-flow.workflow.js");
	fs.writeFileSync(legacySourcePath, normalized);
	writeJsonAtomic(path.join(legacySaved, "legacy-flow.workflow.json"), {
		version: 1,
		name: "legacy-flow",
		hash,
		manifest,
		updatedAt: Date.now(),
	});

	const resolved = store.resolveSaved("legacy-flow");
	assert.equal(resolved.scope, "user");
	assert.equal(resolved.path, legacySourcePath);
	assert.deepEqual(store.listSaved().map((entry) => entry.name), ["legacy-flow"]);

	// Legacy trust entries keyed by the legacy path are honored.
	writeJsonAtomic(path.join(root, "agent", "workflow-trust.json"), {
		version: 1,
		entries: { [path.resolve(legacySourcePath)]: { hash, trustedAt: Date.now() } },
	});
	assert.equal(store.isTrusted({ path: legacySourcePath, hash }), true);
	assert.equal(store.isTrusted({ path: legacySourcePath, hash: "tampered" }), false);

	// Legacy run statuses remain inspectable.
	const legacyRunDir = path.join(root, "agent", "workflow-runs", "session-1", "wf-legacy");
	fs.mkdirSync(legacyRunDir, { recursive: true });
	const snapshot = {
		version: 1, id: "wf-legacy", name: "legacy-flow", state: "completed", scope: "user",
		sourcePath: legacySourcePath, sourceHash: hash, runDir: legacyRunDir, cwd: store.cwd,
		sessionId: "session-1", manifest, policy: { maxAgents: 1, maxConcurrency: 1, timeoutMs: 1, maxIntermediateBytes: 1, maxResultBytes: 1 },
		createdAt: 1, phases: [], agentsLaunched: 0, agentsCompleted: 0, activeAgents: [], background: false,
	};
	writeJsonAtomic(path.join(legacyRunDir, "status.json"), snapshot);
	assert.equal(store.readRunStatus("wf-legacy")?.state, "completed");
	assert.deepEqual(store.listRunStatuses().map((entry) => entry.id), ["wf-legacy"]);

	// A same-named workflow in the unified root shadows the legacy copy.
	const staged = store.stage("legacy-flow", raw, manifest);
	store.saveDraft("legacy-flow", "user");
	assert.equal(store.resolveSaved("legacy-flow").path, path.join(store.userRoot, "legacy-flow.workflow.js"));
	assert.equal(store.listSaved().length, 1);
	assert.equal(staged.scope, "draft");
});

test("persists private run state and can read it back", () => {
	const { store } = makeStore(true);
	const dir = store.createRunDir("wf-test");
	const stat = fs.statSync(dir);
	if (process.platform !== "win32") assert.equal(stat.mode & 0o777, 0o700);
	assert.ok(fs.existsSync(path.join(dir, "agents")));
	assert.ok(fs.existsSync(path.join(dir, "artifacts")));
});

test("lists durable run statuses newest first and ignores malformed entries", () => {
	const { store } = makeStore(true);
	function snapshot(id: string, createdAt: number): WorkflowRunSnapshot {
		const runDir = store.createRunDir(id);
		return {
			version: 1,
			id,
			name: "store-flow",
			state: "completed",
			scope: "draft",
			sourcePath: path.join(store.draftRoot, "store-flow.workflow.js"),
			sourceHash: "hash",
			runDir,
			cwd: store.cwd,
			sessionId: store.sessionId,
			manifest: compileWorkflowSource(source()).manifest,
			policy: { maxAgents: 1, maxConcurrency: 1, timeoutMs: 1_000, maxIntermediateBytes: 1_024, maxResultBytes: 1_024 },
			createdAt,
			phases: [{ name: "Run", status: "completed" }],
			agentsLaunched: 1,
			agentsCompleted: 1,
			activeAgents: [],
			background: false,
		};
	}
	store.writeRunStatus(snapshot("wf-old", 10));
	store.writeRunStatus(snapshot("wf-new", 20));
	const malformed = store.createRunDir("wf-bad");
	fs.writeFileSync(path.join(malformed, "status.json"), "not-json\n");
	assert.deepEqual(store.listRunStatuses().map((entry) => entry.id), ["wf-new", "wf-old"]);
});
