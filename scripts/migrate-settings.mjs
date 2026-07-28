#!/usr/bin/env node
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, fsyncSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, "..");
const OLD_SOURCES = new Set([
	"./packages/pi-shipyard",
	"./packages/pi-agent-teams",
	"./packages/pi-dynamic-workflows",
]);
const ENGINEERING_SOURCE = "./packages/pi-workbench";
const LEGACY_RUNTIME = "npm:pi-subagents@0.35.1";
const EMBEDDED_RUNTIME_COMMIT = "105c1399d36517292cc7dbe1f56f4724de39bd10";
const REMOVED_AGENT_OVERRIDES = new Set([
	"pi-agent-teams.scout",
	"pi-agent-teams.teammate",
	"pi-workbench.deep-reader",
	"pi-workbench.oracle",
	"pi-workbench.researcher",
	"pi-workbench.teams-scout",
	"pi-workbench.teams-teammate",
]);
const KNOWN_DEFAULT_FALLBACK_MODELS = {
	"pi-workbench.planner": [
		["openai-codex/gpt-5.6-terra"],
	],
	"pi-workbench.worker": [
		["openai-codex/gpt-5.6-sol", "kimi-coding/k3"],
		["openai-codex/gpt-5.6-sol:high", "kimi-coding/k3:high"],
		["kimi-coding/k3:high"],
	],
	"pi-workbench.reviewer": [
		["kimi-coding/k3", "google-vertex/gemini-3.6-flash"],
		["kimi-coding/k3:high", "google-vertex/gemini-3.6-flash:low"],
		["openai-codex/gpt-5.5:high"],
	],
};
const KNOWN_DEFAULT_PRIMARY_MODELS = {
	"pi-workbench.planner": "openai-codex/gpt-5.6-sol",
	"pi-workbench.worker": "openai-codex/gpt-5.6-terra",
	"pi-workbench.reviewer": "openai-codex/gpt-5.6-sol",
};

function removeObsoleteAgentOverrides(overrides) {
	return Object.fromEntries(Object.entries(overrides).filter(([key]) => (
		!REMOVED_AGENT_OVERRIDES.has(key) && !key.startsWith("pi-shipyard.")
	)));
}

function sameStrings(left, right) {
	return Array.isArray(left)
		&& Array.isArray(right)
		&& left.length === right.length
		&& left.every((value, index) => value === right[index]);
}

/** Preserve every existing override except exact primary/fallback combinations
 * shipped by older Pi Engineering profiles and their known xhigh reasoning.
 * Customized fleets, reasoning choices, and every other field stay put. */
function mergeAgentOverrides(profileOverrides, existingOverrides) {
	const recommended = removeObsoleteAgentOverrides(profileOverrides);
	const existing = removeObsoleteAgentOverrides(existingOverrides);
	const merged = { ...recommended, ...existing };
	for (const [agent, knownDefaultFallbacks] of Object.entries(KNOWN_DEFAULT_FALLBACK_MODELS)) {
		const current = existing[agent];
		const next = recommended[agent];
		if (
			current && typeof current === "object" && !Array.isArray(current)
			&& next && typeof next === "object" && !Array.isArray(next)
			&& current.model === KNOWN_DEFAULT_PRIMARY_MODELS[agent]
			&& knownDefaultFallbacks.some((fallbacks) => sameStrings(current.fallbackModels, fallbacks))
			&& Array.isArray(next.fallbackModels)
		) {
			merged[agent] = {
				...current,
				fallbackModels: [...next.fallbackModels],
				...(current.thinking === "xhigh"
					&& typeof next.thinking === "string"
					? { thinking: next.thinking }
					: {}),
			};
		}
	}
	return merged;
}

export function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function packageSource(entry) {
	return typeof entry === "string" ? entry : entry && typeof entry === "object" && !Array.isArray(entry) ? entry.source : undefined;
}

function isStandaloneRuntime(entry) {
	const source = packageSource(entry);
	return typeof source === "string" && (
		source === "pi-subagents"
		|| source.startsWith("npm:pi-subagents@")
		|| /(?:github\.com[/:]nicobailon\/pi-subagents|^github:nicobailon\/pi-subagents)/.test(source)
	);
}

function parseJsonFile(file) {
	const text = readFileSync(file, "utf8");
	return { text, value: JSON.parse(text) };
}

export function atomicWriteJson(file, value) {
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
	const fd = openSync(temp, "wx", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	JSON.parse(readFileSync(temp, "utf8"));
	renameSync(temp, file);
}

function loadProfile(profilePath = path.join(packageRoot, "profiles", "recommended-agent-overrides.json")) {
	const profile = JSON.parse(readFileSync(profilePath, "utf8"));
	if (profile.schemaVersion !== 1 || !profile.agentOverrides || typeof profile.agentOverrides !== "object") {
		throw new Error(`Invalid Pi Engineering agent profile: ${profilePath}`);
	}
	return profile.agentOverrides;
}

export function buildMigratedSettings(settings, profileOverrides = loadProfile()) {
	if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("settings.json root must be an object.");
	if (!Array.isArray(settings.packages)) throw new Error("settings.json packages must be an array.");
	const runtimeEntries = settings.packages.filter(isStandaloneRuntime);
	if (runtimeEntries.length > 1) throw new Error("settings.json contains duplicate standalone pi-subagents runtime entries.");
	if (runtimeEntries.length === 1 && packageSource(runtimeEntries[0]) !== LEGACY_RUNTIME) {
		throw new Error(`Refusing to replace unexpected standalone runtime ${packageSource(runtimeEntries[0])}; expected ${LEGACY_RUNTIME}.`);
	}
	const engineeringEntries = settings.packages.filter((entry) => packageSource(entry) === ENGINEERING_SOURCE);
	if (engineeringEntries.length > 1) throw new Error("settings.json contains duplicate Pi Engineering package entries.");
	const candidateIndices = settings.packages.flatMap((entry, index) => (
		isStandaloneRuntime(entry) || OLD_SOURCES.has(packageSource(entry)) || packageSource(entry) === ENGINEERING_SOURCE ? [index] : []
	));
	if (candidateIndices.length === 0) throw new Error("No known orchestration package entry was found to migrate.");
	const runtimeIndex = settings.packages.findIndex(isStandaloneRuntime);
	const engineeringIndex = settings.packages.findIndex((entry) => packageSource(entry) === ENGINEERING_SOURCE);
	const insertAt = runtimeIndex >= 0 ? runtimeIndex : engineeringIndex >= 0 ? engineeringIndex : Math.min(...candidateIndices);
	const packages = settings.packages.filter((entry) => (
		!isStandaloneRuntime(entry) && !OLD_SOURCES.has(packageSource(entry)) && packageSource(entry) !== ENGINEERING_SOURCE
	));
	packages.splice(Math.min(Math.max(0, insertAt), packages.length), 0, ENGINEERING_SOURCE);
	const existingSubagents = settings.subagents && typeof settings.subagents === "object" && !Array.isArray(settings.subagents)
		? settings.subagents
		: {};
	const existingOverrides = existingSubagents.agentOverrides && typeof existingSubagents.agentOverrides === "object" && !Array.isArray(existingSubagents.agentOverrides)
		? existingSubagents.agentOverrides
		: {};
	return {
		...settings,
		packages,
		subagents: {
			...existingSubagents,
			agentOverrides: mergeAgentOverrides(profileOverrides, existingOverrides),
		},
	};
}

function parseArgs(argv) {
	const args = { mode: "check", force: false };
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (value === "--check") args.mode = "check";
		else if (value === "--apply") args.mode = "apply";
		else if (value === "--rollback") { args.mode = "rollback"; args.manifest = argv[++index]; }
		else if (value === "--settings") args.settings = argv[++index];
		else if (value === "--legacy-scout") args.legacyScout = argv[++index];
		else if (value === "--force") args.force = true;
		else throw new Error(`Unknown argument: ${value}`);
	}
	return args;
}

function defaultSettings() {
	return path.join(os.homedir(), ".pi", "agent", "settings.json");
}

function defaultScout() {
	return path.join(os.homedir(), ".agents", "scout.md");
}

export function migrationPreview(settingsFile, scoutFile) {
	const current = parseJsonFile(settingsFile);
	const migrated = buildMigratedSettings(current.value);
	return {
		current,
		migrated,
		oldPackages: current.value.packages.map(packageSource),
		newPackages: migrated.packages.map(packageSource),
		legacyScoutExists: existsSync(scoutFile),
		newOverrideCount: Object.keys(migrated.subagents.agentOverrides).length,
		embeddedRuntimeCommit: EMBEDDED_RUNTIME_COMMIT,
	};
}

export function applyMigration(settingsFile, scoutFile) {
	const preview = migrationPreview(settingsFile, scoutFile);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backupDir = path.join(path.dirname(settingsFile), "backups", `pi-workbench-${stamp}`);
	mkdirSync(backupDir, { recursive: true, mode: 0o700 });
	const settingsBackup = path.join(backupDir, "settings.json");
	copyFileSync(settingsFile, settingsBackup);
	let scoutBackup;
	if (existsSync(scoutFile)) {
		scoutBackup = path.join(backupDir, "legacy-scout.md");
		copyFileSync(scoutFile, scoutBackup);
	}
	atomicWriteJson(settingsFile, preview.migrated);
	let archivedScout;
	try {
		if (existsSync(scoutFile)) {
			archivedScout = `${scoutFile}.pre-workbench-${stamp}.bak`;
			renameSync(scoutFile, archivedScout);
		}
	} catch (error) {
		copyFileSync(settingsBackup, settingsFile);
		throw error;
	}
	const appliedText = readFileSync(settingsFile, "utf8");
	const manifest = {
		schemaVersion: 1,
		createdAt: new Date().toISOString(),
		settingsFile,
		settingsBackup,
		originalSettingsHash: sha256(preview.current.text),
		appliedSettingsHash: sha256(appliedText),
		legacyScout: scoutFile,
		scoutBackup: scoutBackup ?? null,
		archivedScout: archivedScout ?? null,
		embeddedRuntimeCommit: preview.embeddedRuntimeCommit,
		oldPackages: preview.oldPackages,
		newPackages: preview.newPackages,
	};
	const manifestPath = path.join(backupDir, "manifest.json");
	atomicWriteJson(manifestPath, manifest);
	return { manifestPath, manifest };
}

export function rollback(manifestPath, force = false) {
	if (!manifestPath) throw new Error("--rollback requires a backup manifest path.");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (manifest.schemaVersion !== 1) throw new Error("Unsupported migration manifest.");
	const currentSettings = readFileSync(manifest.settingsFile, "utf8");
	if (!force && sha256(currentSettings) !== manifest.appliedSettingsHash) {
		throw new Error("Current settings changed after migration. Refusing rollback without --force.");
	}
	if (manifest.archivedScout && existsSync(manifest.archivedScout) && existsSync(manifest.legacyScout) && !force) {
		throw new Error("Legacy scout path is occupied. Refusing rollback without --force.");
	}
	const original = JSON.parse(readFileSync(manifest.settingsBackup, "utf8"));
	atomicWriteJson(manifest.settingsFile, original);
	if (manifest.archivedScout && existsSync(manifest.archivedScout)) {
		if (existsSync(manifest.legacyScout)) unlinkSync(manifest.legacyScout);
		renameSync(manifest.archivedScout, manifest.legacyScout);
	}
	return { settingsFile: manifest.settingsFile, scoutRestored: existsSync(manifest.legacyScout) };
}

export function main(argv = process.argv.slice(2)) {
	const args = parseArgs(argv);
	const settingsFile = path.resolve(args.settings ?? defaultSettings());
	const scoutFile = path.resolve(args.legacyScout ?? defaultScout());
	if (args.mode === "rollback") {
		const result = rollback(path.resolve(args.manifest), args.force);
		console.log(JSON.stringify({ mode: "rollback", ...result }, null, 2));
		return;
	}
	const preview = migrationPreview(settingsFile, scoutFile);
	if (args.mode === "check") {
		console.log(JSON.stringify({
			mode: "check",
			settingsFile,
			legacyScout: scoutFile,
			legacyScoutExists: preview.legacyScoutExists,
			oldPackages: preview.oldPackages,
			newPackages: preview.newPackages,
			embeddedRuntimeCommit: preview.embeddedRuntimeCommit,
			agentOverrideCountAfter: preview.newOverrideCount,
		}, null, 2));
		return;
	}
	const result = applyMigration(settingsFile, scoutFile);
	console.log(JSON.stringify({ mode: "apply", ...result }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
