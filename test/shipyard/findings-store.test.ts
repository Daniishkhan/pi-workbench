import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	addFinding,
	exportFindings,
	getFinding,
	initializeStore,
	listFindings,
	resolveStorePath,
	snapshotFindings,
	summarizeFindings,
	updateFinding,
} from "../../extensions/shipyard/findings-store.ts";
import { resolveSafeExportPath } from "../../extensions/shipyard/path-safety.ts";

const fixture = {
	stage: "wave-1-runtime",
	title: "Cancellation leaks the temporary file",
	summary: "The cancellation branch returns before cleanup and leaves a stale file that later runs consume.",
	severity: "high" as const,
	confidence: "high" as const,
	category: "cleanup",
	sourceRole: "pi-shipyard.runtime-reviewer",
	evidence: [{ path: "src/run.ts", lineStart: 42, lineEnd: 45, detail: "The early return precedes cleanup." }],
	failureScenario: "Cancel after the temporary file is written; the next invocation reads the stale file.",
	suggestedFix: "Move cleanup into a finally block around the cancellable operation.",
	validation: "Run the focused cancellation test and assert the temporary path is absent.",
	tags: ["runtime", "cleanup"],
};

async function withStore(run: (store: string, root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-shipyard-test-"));
	const store = path.join(root, "S-test", "R-test-run", "findings");
	try {
		await initializeStore(store, { runId: "R-test-run", workflow: "review-mesh", now: new Date("2026-01-01T00:00:00Z") });
		await run(store, root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("creates, lists, updates, snapshots, and exports findings", async () => {
	await withStore(async (store, root) => {
		const finding = await addFinding(store, fixture, new Date("2026-01-01T00:01:00Z"));
		assert.equal(finding.runId, "R-test-run");
		assert.equal(finding.workflow, "review-mesh");
		assert.equal(finding.stage, fixture.stage);
		assert.equal(finding.revision, 1);
		assert.equal(finding.status, "proposed");

		assert.deepEqual((await listFindings(store)).map((entry) => entry.id), [finding.id]);
		const updated = await updateFinding(
			store,
			finding.id,
			{ status: "verified", dispositionReason: "Focused reproduction failed as predicted." },
			1,
			new Date("2026-01-01T00:02:00Z"),
		);
		assert.equal(updated.revision, 2);
		assert.equal(updated.status, "verified");
		assert.equal(updated.stage, fixture.stage, "creation stage remains immutable");
		assert.equal(updated.sourceRole, fixture.sourceRole, "origin role remains immutable");

		await assert.rejects(
			() => updateFinding(store, finding.id, { status: "rejected" }, 1),
			/Revision conflict/,
		);

		const snapshot = await snapshotFindings(store, "post-falsification", new Date("2026-01-01T00:03:00Z"));
		assert.equal(snapshot.findings.length, 1);
		assert.equal(snapshot.findings[0]?.revision, 2);
		assert.match(snapshot.sha256, /^[a-f0-9]{64}$/);

		const output = path.join(root, "S-test", "R-test-run", "findings.md");
		const exported = await exportFindings(store, output, "Test review");
		assert.equal(exported.count, 1);
		const markdown = await readFile(output, "utf8");
		assert.match(markdown, /# Test review/);
		assert.match(markdown, /Status: verified/);
		assert.match(markdown, /src\/run\.ts:42-45/);

		const stats = summarizeFindings(await listFindings(store));
		assert.equal(stats.total, 1);
		assert.equal(stats.bySeverity.high, 1);
		assert.equal(stats.byStatus.verified, 1);
	});
});

test("preserves an existing named workflow when init only verifies the run id", async () => {
	await withStore(async (store) => {
		const manifest = await initializeStore(store, { runId: "R-test-run" });
		assert.equal(manifest.workflow, "review-mesh");
	});
});

test("rejects malformed records instead of silently dropping them", async () => {
	await withStore(async (store) => {
		await writeFile(path.join(store, "F-bad.json"), "{not-json}\n", "utf8");
		await assert.rejects(() => listFindings(store), /JSON/);
	});
});

test("restricts resolved stores to a run-specific child of the allowed root", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-shipyard-path-"));
	try {
		const valid = path.join(root, "S-test", "R-test", "findings");
		assert.equal(resolveStorePath("/tmp", valid, root), valid);
		assert.throws(() => resolveStorePath("/tmp", root, root), /run-specific/);
		assert.throws(() => resolveStorePath("/tmp", path.join(root, "..", "escape"), root), /run-specific/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects findings copied from another run or workflow", async () => {
	await withStore(async (store, root) => {
		const finding = await addFinding(store, fixture);
		const otherStore = path.join(root, "S-test", "R-other-run", "findings");
		await initializeStore(otherStore, { runId: "R-other-run", workflow: "review-fast" });
		await copyFile(path.join(store, `${finding.id}.json`), path.join(otherStore, `${finding.id}.json`));
		await assert.rejects(() => listFindings(otherStore), /identity mismatch/);
		await assert.rejects(() => getFinding(otherStore, finding.id), /identity mismatch/);
	});
});

test("rejects unsafe export targets and in-run symlinks", async () => {
	await withStore(async (store, root) => {
		const external = path.join(root, "external");
		const runDir = path.dirname(store);
		await symlink(external, path.join(runDir, "escape"));
		await assert.rejects(() => resolveSafeExportPath(store, "escape/findings.md"), /Symlinked Shipyard path component/);
		await assert.rejects(() => resolveSafeExportPath(store, "findings/ledger.md"), /may not overwrite the findings store/);
		await assert.rejects(() => resolveSafeExportPath(store, "workflow.json"), /must use a \.md file/);
		assert.equal(await resolveSafeExportPath(store, "reports/findings.md"), path.join(runDir, "reports", "findings.md"));
	});
});

test("publishes concurrent creates as complete records without visible temp files", async () => {
	await withStore(async (store) => {
		await Promise.all(Array.from({ length: 24 }, (_, index) => addFinding(store, {
			...fixture,
			title: `${fixture.title} ${index}`,
			sourceRole: `pi-shipyard.test-${index}`,
		})));
		assert.equal((await listFindings(store)).length, 24);
		const names = await readdir(store);
		assert.equal(names.some((name) => name.endsWith(".tmp")), false);
	});
});

test("serializes cross-process updates with an optimistic revision", async () => {
	await withStore(async (store) => {
		const finding = await addFinding(store, fixture);
		const worker = fileURLToPath(new URL("./update-worker.mjs", import.meta.url));
		const launch = (summary: string) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
			const child = spawn(process.execPath, ["--experimental-strip-types", worker, store, finding.id, summary, "1"], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let output = "";
			let error = "";
			child.stdout.on("data", (chunk) => { output += String(chunk); });
			child.stderr.on("data", (chunk) => { error += String(chunk); });
			child.on("error", reject);
			child.on("close", (code) => resolve({ code, output: output || error }));
		});
		const results = await Promise.all([launch("winner-a"), launch("winner-b")]);
		assert.equal(results.filter((result) => result.code === 0).length, 1, JSON.stringify(results));
		assert.equal(results.filter((result) => result.code === 2).length, 1, JSON.stringify(results));
		assert.match(results.find((result) => result.code === 2)?.output ?? "", /Revision conflict/);
		const current = await getFinding(store, finding.id);
		assert.equal(current.revision, 2);
		assert.ok(current.summary === "winner-a" || current.summary === "winner-b");
	});
});
