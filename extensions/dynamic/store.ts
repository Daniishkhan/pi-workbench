import * as fs from "node:fs";
import * as path from "node:path";
import { ensurePrivateDir, writeJsonAtomic, writeTextAtomic } from "../core/json.ts";
import { dynamicStateRoots, legacyDynamicStateRoots } from "../core/paths.ts";
import { safePathSegment } from "../core/sanitize.ts";
import { normalizeWorkflowName, workflowSourceHash } from "./manifest.ts";
import type { WorkflowManifest, WorkflowRunSnapshot, WorkflowScope, WorkflowSource } from "./types.ts";

export { writeJsonAtomic };

interface StoredMetadata {
	version: 1;
	name: string;
	hash: string;
	manifest: WorkflowManifest;
	updatedAt: number;
}

interface TrustFile {
	version: 1;
	entries: Record<string, { hash: string; trustedAt: number }>;
}

export interface WorkflowStoreOptions {
	agentDir: string;
	cwd: string;
	configDirName: string;
	sessionId: string;
	projectTrusted: boolean;
}

function readJson<T>(file: string): T {
	return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function sourcePaths(root: string, name: string): { sourcePath: string; metadataPath: string } {
	return {
		sourcePath: path.join(root, `${name}.workflow.js`),
		metadataPath: path.join(root, `${name}.workflow.json`),
	};
}

function listWorkflowNames(root: string): string[] {
	try {
		return fs.readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".workflow.js"))
			.map((entry) => entry.name.slice(0, -".workflow.js".length))
			.filter((name) => /^[a-z][a-z0-9-]{1,47}$/.test(name));
	} catch {
		return [];
	}
}

export class WorkflowStore {
	readonly agentDir: string;
	readonly cwd: string;
	readonly sessionId: string;
	readonly projectTrusted: boolean;
	readonly userRoot: string;
	readonly projectRoot: string;
	readonly draftRoot: string;
	readonly runsRoot: string;
	readonly trustPath: string;
	readonly legacyUserRoot?: string;
	readonly legacyDraftRoot?: string;
	readonly legacyRunsRoot?: string;
	readonly legacyTrustPath?: string;

	constructor(options: WorkflowStoreOptions) {
		this.agentDir = path.resolve(options.agentDir);
		this.cwd = path.resolve(options.cwd);
		this.sessionId = safePathSegment(options.sessionId);
		this.projectTrusted = options.projectTrusted;
		const roots = dynamicStateRoots(this.agentDir);
		const legacy = legacyDynamicStateRoots(this.agentDir);
		this.userRoot = roots.savedRoot;
		this.projectRoot = path.join(this.cwd, options.configDirName, "workflows");
		this.draftRoot = path.join(roots.draftsRoot, this.sessionId);
		this.runsRoot = path.join(roots.runsRoot, this.sessionId);
		this.trustPath = roots.trustPath;
		this.legacyUserRoot = legacy.savedRoot;
		this.legacyDraftRoot = path.join(legacy.draftsRoot, this.sessionId);
		this.legacyRunsRoot = path.join(legacy.runsRoot, this.sessionId);
		this.legacyTrustPath = legacy.trustPath;
	}

	stage(nameInput: string, source: string, manifest: WorkflowManifest): WorkflowSource {
		const name = normalizeWorkflowName(nameInput);
		if (manifest.name !== name) {
			throw new Error(`Workflow source defines '${manifest.name}', but dynamic_create requested '${name}'.`);
		}
		const normalizedSource = source.endsWith("\n") ? source : `${source}\n`;
		const hash = workflowSourceHash(normalizedSource);
		const paths = sourcePaths(this.draftRoot, name);
		writeTextAtomic(paths.sourcePath, normalizedSource);
		writeJsonAtomic(paths.metadataPath, {
			version: 1,
			name,
			hash,
			manifest,
			updatedAt: Date.now(),
		} satisfies StoredMetadata);
		return { name, source: normalizedSource, hash, manifest, scope: "draft", path: paths.sourcePath };
	}

	private readFromRoot(root: string, scope: WorkflowScope, nameInput: string): WorkflowSource | undefined {
		const name = normalizeWorkflowName(nameInput);
		const paths = sourcePaths(root, name);
		try {
			const source = fs.readFileSync(paths.sourcePath, "utf8");
			const metadata = readJson<StoredMetadata>(paths.metadataPath);
			if (metadata.version !== 1 || metadata.name !== name) return undefined;
			const hash = workflowSourceHash(source);
			return { name, source, hash, manifest: metadata.manifest, scope, path: paths.sourcePath };
		} catch {
			return undefined;
		}
	}

	resolve(name: string): WorkflowSource {
		const draft = this.readFromRoot(this.draftRoot, "draft", name)
			?? (this.legacyDraftRoot ? this.readFromRoot(this.legacyDraftRoot, "draft", name) : undefined);
		if (draft) return draft;
		return this.resolveSaved(name);
	}

	resolveSaved(name: string): WorkflowSource {
		const project = this.projectTrusted ? this.readFromRoot(this.projectRoot, "project", name) : undefined;
		if (project) return project;
		const user = this.readFromRoot(this.userRoot, "user", name)
			?? (this.legacyUserRoot ? this.readFromRoot(this.legacyUserRoot, "user", name) : undefined);
		if (user) return user;
		throw new Error(`Saved workflow '${name}' was not found in project or user workflows.`);
	}

	listSaved(): WorkflowSource[] {
		const byName = new Map<string, WorkflowSource>();
		for (const [root, scope] of [
			...(this.legacyUserRoot ? [[this.legacyUserRoot, "user"] as const] : []),
			[this.userRoot, "user"],
			...(this.projectTrusted ? [[this.projectRoot, "project"] as const] : []),
		] as Array<readonly [string, "user" | "project"]>) {
			for (const name of listWorkflowNames(root)) {
				const workflow = this.readFromRoot(root, scope, name);
				if (workflow) byName.set(name, workflow);
			}
		}
		return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	list(): WorkflowSource[] {
		const byName = new Map<string, WorkflowSource>();
		const roots: Array<readonly [string, WorkflowScope]> = [
			...(this.legacyUserRoot ? [[this.legacyUserRoot, "user"] as const] : []),
			[this.userRoot, "user"],
			...(this.projectTrusted ? [[this.projectRoot, "project"] as const] : []),
			...(this.legacyDraftRoot ? [[this.legacyDraftRoot, "draft"] as const] : []),
			[this.draftRoot, "draft"],
		];
		for (const [root, scope] of roots) {
			for (const name of listWorkflowNames(root)) {
				const workflow = this.readFromRoot(root, scope, name);
				if (workflow) byName.set(name, workflow);
			}
		}
		return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	saveDraft(nameInput: string, scope: "user" | "project", overwrite = false): WorkflowSource {
		const name = normalizeWorkflowName(nameInput);
		if (scope === "project" && !this.projectTrusted) throw new Error("Project workflow storage requires a trusted project.");
		const draft = this.readFromRoot(this.draftRoot, "draft", name);
		if (!draft) throw new Error(`No session draft named '${name}' exists.`);
		const root = scope === "user" ? this.userRoot : this.projectRoot;
		const paths = sourcePaths(root, name);
		if (!overwrite && (fs.existsSync(paths.sourcePath) || fs.existsSync(paths.metadataPath))) {
			throw new Error(`A ${scope} workflow named '${name}' already exists. Set overwrite=true to replace it.`);
		}
		writeTextAtomic(paths.sourcePath, draft.source.endsWith("\n") ? draft.source : `${draft.source}\n`);
		writeJsonAtomic(paths.metadataPath, {
			version: 1,
			name,
			hash: draft.hash,
			manifest: draft.manifest,
			updatedAt: Date.now(),
		} satisfies StoredMetadata);
		return { ...draft, scope, path: paths.sourcePath };
	}

	deleteSaved(nameInput: string, scope: "user" | "project"): boolean {
		const name = normalizeWorkflowName(nameInput);
		if (scope === "project" && !this.projectTrusted) throw new Error("Project workflow storage requires a trusted project.");
		const root = scope === "user" ? this.userRoot : this.projectRoot;
		const paths = sourcePaths(root, name);
		let removed = false;
		for (const file of [paths.sourcePath, paths.metadataPath]) {
			try {
				fs.unlinkSync(file);
				removed = true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		return removed;
	}

	createRunDir(id: string): string {
		const dir = path.join(this.runsRoot, safePathSegment(id));
		ensurePrivateDir(dir);
		ensurePrivateDir(path.join(dir, "agents"));
		ensurePrivateDir(path.join(dir, "artifacts"));
		return dir;
	}

	writeRunSource(runDir: string, source: string, input: unknown): void {
		writeTextAtomic(path.join(runDir, "source.workflow.js"), source.endsWith("\n") ? source : `${source}\n`);
		writeJsonAtomic(path.join(runDir, "input.json"), input ?? null);
	}

	writeRunStatus(snapshot: WorkflowRunSnapshot): void {
		writeJsonAtomic(path.join(snapshot.runDir, "status.json"), snapshot);
	}

	appendRunEvent(runDir: string, event: unknown): void {
		fs.appendFileSync(path.join(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
	}

	readRunStatus(id: string): WorkflowRunSnapshot | undefined {
		for (const root of [this.runsRoot, ...(this.legacyRunsRoot ? [this.legacyRunsRoot] : [])]) {
			try {
				return readJson<WorkflowRunSnapshot>(path.join(root, safePathSegment(id), "status.json"));
			} catch {
				// Try the next root.
			}
		}
		return undefined;
	}

	listRunStatuses(): WorkflowRunSnapshot[] {
		const byId = new Map<string, WorkflowRunSnapshot>();
		for (const root of [...(this.legacyRunsRoot ? [this.legacyRunsRoot] : []), this.runsRoot]) {
			let entries: fs.Dirent[];
			try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
			for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
				const status = this.readRunStatus(entry.name);
				if (status) byId.set(status.id, status);
			}
		}
		return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
	}

	private readTrust(): TrustFile {
		for (const file of [this.trustPath, ...(this.legacyTrustPath ? [this.legacyTrustPath] : [])]) {
			try {
				const trust = readJson<TrustFile>(file);
				if (trust.version === 1 && trust.entries && typeof trust.entries === "object") return trust;
			} catch {
				// Try the next trust location.
			}
		}
		return { version: 1, entries: {} };
	}

	isTrusted(workflow: Pick<WorkflowSource, "path" | "hash">): boolean {
		const entry = this.readTrust().entries[path.resolve(workflow.path)];
		return entry?.hash === workflow.hash;
	}

	trust(workflow: Pick<WorkflowSource, "path" | "hash">): void {
		const trust = this.readTrust();
		trust.entries[path.resolve(workflow.path)] = { hash: workflow.hash, trustedAt: Date.now() };
		writeJsonAtomic(this.trustPath, trust);
	}
}
