#!/usr/bin/env node
/** Validate the lean Pi Workbench package contract. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_WORKBENCH_CONFIG, resolveWorkbenchConfig } from "../extensions/core/config.ts";
import { ROLE_POLICIES } from "../extensions/core/role-policy.ts";
import { ONE_OFF_AGENTS, ROUTE_LIMITS, WORKBENCH_MODES } from "../extensions/core/routing.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const fail = (message) => errors.push(message);

function walk(dir, predicate) {
	if (!existsSync(dir)) return [];
	const output = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) output.push(...walk(file, predicate));
		else if (predicate(file)) output.push(file);
	}
	return output.sort();
}

function relative(file) {
	return path.relative(root, file).split(path.sep).join("/");
}

function readJson(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		fail(`${relative(file)}: invalid JSON: ${error.message}`);
		return null;
	}
}

function parseFrontmatter(file) {
	const text = readFileSync(file, "utf8");
	const match = text.match(/^---\n([\s\S]*?)\n---\n/);
	if (!match) {
		fail(`${relative(file)}: missing YAML frontmatter`);
		return {};
	}
	const values = {};
	for (const line of match[1].split("\n")) {
		const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/);
		if (field) values[field[1]] = field[2] ?? "";
	}
	return values;
}

function assertExactSet(actual, expected, label) {
	const actualSorted = [...actual].sort();
	const expectedSorted = [...expected].sort();
	if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
		fail(`${label}: expected ${expectedSorted.join(", ")}; found ${actualSorted.join(", ") || "none"}`);
	}
}

const expectedAgents = {
	"pi-workbench.fast-scout": "read-only",
	"pi-workbench.planner": "read-only",
	"pi-workbench.worker": "writer",
	"pi-workbench.reviewer": "read-only",
};
const expectedAgentFiles = [
	"agents/core/fast-scout.md",
	"agents/core/planner.md",
	"agents/core/reviewer.md",
	"agents/core/worker.md",
];
const expectedChainFiles = [
	"chains/workbench/audit.chain.json",
	"chains/workbench/deliver.chain.json",
];
const expectedModes = ["status", "inspect", "plan", "implement", "review", "deliver", "audit"];
const pinnedRuntime = "https://codeload.github.com/nicobailon/pi-subagents/tar.gz/105c1399d36517292cc7dbe1f56f4724de39bd10";

// Package and public discovery surface.
const packageJson = readJson(path.join(root, "package.json"));
if (packageJson) {
	if (packageJson.name !== "@danish/pi-workbench") fail("package.json: unexpected package name");
	if (!packageJson.keywords?.includes("pi-package")) fail("package.json: keywords must include pi-package");
	if (packageJson.dependencies?.["pi-subagents"] !== pinnedRuntime) {
		fail("package.json: pi-subagents must remain pinned to the reviewed immutable source");
	}
	if (packageJson.bundledDependencies?.includes?.("pi-subagents")) fail("package.json: do not vendor pi-subagents");
	if (!packageJson.files?.includes?.("THIRD_PARTY.md") || !existsSync(path.join(root, "THIRD_PARTY.md"))) {
		fail("package.json: third-party provenance must ship with Workbench");
	}
	if (packageJson.files?.includes?.("examples/")) fail("package.json: examples/ is not part of the lean harness");
	if (Array.isArray(packageJson.pi?.prompts) && packageJson.pi.prompts.length > 0) {
		fail("package.json: prompt templates create alternate command surfaces");
	}
	const expectedManifest = {
		extensions: ["./extensions/index.ts"],
		skills: ["./skills/pi-workbench"],
		agents: ["./agents"],
		chains: ["./chains"],
	};
	for (const [kind, expected] of Object.entries(expectedManifest)) {
		const actual = kind === "agents" || kind === "chains"
			? packageJson.pi?.subagents?.[kind]
			: packageJson.pi?.[kind];
		if (JSON.stringify(actual) !== JSON.stringify(expected)) {
			fail(`package.json: expected pi.${kind} to be ${JSON.stringify(expected)}`);
		}
		for (const entry of actual ?? []) if (!existsSync(path.resolve(root, entry))) fail(`package.json: missing ${kind} path ${entry}`);
	}
	for (const obsolete of ["test:shipyard", "test:teams", "test:dynamic"]) {
		if (packageJson.scripts?.[obsolete]) fail(`package.json: obsolete script ${obsolete} remains`);
	}
	if (!packageJson.scripts?.["test:workflows"]?.includes("test/workflows/*.test.ts")) {
		fail("package.json: test:workflows must run the fixed workflow tests");
	}
}

// Minimal strict configuration.
if (JSON.stringify(resolveWorkbenchConfig({})) !== JSON.stringify(DEFAULT_WORKBENCH_CONFIG)) {
	fail("config: empty input must resolve to the safe default");
}
if (JSON.stringify(readJson(path.join(root, "config.example.json"))) !== JSON.stringify(DEFAULT_WORKBENCH_CONFIG)) {
	fail("config.example.json: must contain only the default writerGuard policy");
}
for (const invalid of [
	{ modules: {} },
	{ shipyard: {} },
	{ dynamic: {} },
	{ writerGuard: { enabled: "yes" } },
]) {
	try {
		resolveWorkbenchConfig(invalid);
		fail(`config: invalid input was accepted: ${JSON.stringify(invalid)}`);
	} catch {
		// Expected strict rejection.
	}
}

// Exactly four leaf agents.
const agentFiles = walk(path.join(root, "agents"), (file) => file.endsWith(".md"));
assertExactSet(agentFiles.map(relative), expectedAgentFiles, "agents");
const agentNames = new Set();
for (const file of agentFiles) {
	const fm = parseFrontmatter(file);
	const runtimeName = `${fm.package}.${fm.name}`;
	agentNames.add(runtimeName);
	if (!fm.description) fail(`${relative(file)}: missing description`);
	if (!Object.hasOwn(expectedAgents, runtimeName)) fail(`${relative(file)}: unexpected runtime name ${runtimeName}`);
	if (fm.acceptanceRole !== expectedAgents[runtimeName]) {
		fail(`${relative(file)}: acceptanceRole '${fm.acceptanceRole}' must be '${expectedAgents[runtimeName]}'`);
	}
	for (const field of ["model", "fallbackModels", "thinking", "skills", "skillPath", "output"]) {
		if (Object.hasOwn(fm, field)) fail(`${relative(file)}: ${field} does not belong in the lean role prompt`);
	}
	const tools = new Set((fm.tools ?? "").split(",").map((value) => value.trim()).filter(Boolean));
	for (const required of ["read", "grep", "find", "ls", "workbench_repo"]) {
		if (!tools.has(required)) fail(`${relative(file)}: missing required tool ${required}`);
	}
	for (const tool of tools) {
		if (/^(?:subagent|team_|dynamic_|shipyard_)/.test(tool) || tool === "workbench_route") {
			fail(`${relative(file)}: leaf role exposes orchestration/legacy tool ${tool}`);
		}
	}
	if (fm.acceptanceRole === "read-only") {
		for (const forbidden of ["bash", "edit", "write"]) if (tools.has(forbidden)) fail(`${relative(file)}: read-only role exposes ${forbidden}`);
	} else {
		for (const required of ["bash", "edit", "write"]) if (!tools.has(required)) fail(`${relative(file)}: writer role is missing ${required}`);
	}
}
assertExactSet(agentNames, Object.keys(expectedAgents), "agent runtime names");

// Role policy, routing, and limits remain centralized and exact.
assertExactSet(Object.keys(ROLE_POLICIES), Object.keys(expectedAgents), "role policy");
for (const [agent, capability] of Object.entries(expectedAgents)) {
	if (ROLE_POLICIES[agent]?.capability !== capability) fail(`role-policy: ${agent} must be ${capability}`);
	if (!ROLE_POLICIES[agent]?.surfaces?.length) fail(`role-policy: ${agent} has no allowed surface`);
}
if (JSON.stringify(WORKBENCH_MODES) !== JSON.stringify(expectedModes)) fail("routing: public mode list changed");
const expectedOneOffAgents = {
	inspect: "pi-workbench.fast-scout",
	plan: "pi-workbench.planner",
	implement: "pi-workbench.worker",
	review: "pi-workbench.reviewer",
};
if (JSON.stringify(ONE_OFF_AGENTS) !== JSON.stringify(expectedOneOffAgents)) fail("routing: one-off agent map changed");
const expectedLimits = {
	inspect: { timeoutMs: 5 * 60_000, turnBudget: { maxTurns: 8, graceTurns: 2 } },
	plan: { timeoutMs: 15 * 60_000, turnBudget: { maxTurns: 18, graceTurns: 2 } },
	implement: { timeoutMs: 45 * 60_000 },
	review: { timeoutMs: 15 * 60_000, turnBudget: { maxTurns: 18, graceTurns: 2 } },
	deliver: { timeoutMs: 45 * 60_000 },
	audit: { timeoutMs: 20 * 60_000 },
};
if (JSON.stringify(ROUTE_LIMITS) !== JSON.stringify(expectedLimits)) fail("routing: bounded route limits changed");

// Exactly one public skill; upstream pi-subagents policy is intentionally not rediscovered.
const skillFiles = walk(path.join(root, "skills"), (file) => path.basename(file) === "SKILL.md");
assertExactSet(skillFiles.map(relative), ["skills/pi-workbench/SKILL.md"], "skills");
if (skillFiles.length === 1) {
	const fm = parseFrontmatter(skillFiles[0]);
	if (fm.name !== "pi-workbench" || !fm.description) fail("skills/pi-workbench/SKILL.md: invalid frontmatter");
}

// Profile must cover exactly the four packaged roles.
const profile = readJson(path.join(root, "profiles", "recommended-agent-overrides.json"));
if (profile?.schemaVersion !== 1 || !profile?.agentOverrides) fail("profiles/recommended-agent-overrides.json: invalid profile");
assertExactSet(Object.keys(profile?.agentOverrides ?? {}), Object.keys(expectedAgents), "profile agents");

// Two small static chains, with no parallel writer and no forward artifact references.
const chainFiles = walk(path.join(root, "chains"), (file) => file.endsWith(".chain.json"));
assertExactSet(chainFiles.map(relative), expectedChainFiles, "chains");
const allowedTaskKeys = new Set(["agent", "task", "phase", "label", "as", "output", "outputMode", "progress"]);
const allowedGroupKeys = new Set(["phase", "label", "parallel", "concurrency", "failFast"]);
const outputReferencePattern = /\{outputs\.([A-Za-z_][A-Za-z0-9_]*)\}/g;

function inspectTask(label, stepNumber, task, available, produced, outputPaths) {
	const prefix = `${label} step ${stepNumber}`;
	for (const key of Object.keys(task)) if (!allowedTaskKeys.has(key)) fail(`${prefix}: unsupported task key ${key}`);
	if (!agentNames.has(task.agent)) fail(`${prefix}: unknown agent ${task.agent}`);
	if (!ROLE_POLICIES[task.agent]?.surfaces.includes("workflow")) fail(`${prefix}: agent ${task.agent} is not approved for workflows`);
	if (typeof task.task !== "string" || !task.task.trim()) fail(`${prefix}: task must be non-empty`);
	const references = [...(task.task?.matchAll(outputReferencePattern) ?? [])].map((match) => match[1]);
	for (const reference of references) if (!available.has(reference)) fail(`${prefix}: forward or unknown output reference ${reference}`);
	if (references.length > 0 && !task.task.includes("Open and read")) fail(`${prefix}: artifact consumer must explicitly open referenced outputs`);
	if (task.as) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(task.as)) fail(`${prefix}: invalid as name ${task.as}`);
		if (available.has(task.as) || produced.has(task.as)) fail(`${prefix}: duplicate as name ${task.as}`);
		produced.add(task.as);
	}
	if (task.outputMode === "file-only" && typeof task.output !== "string") fail(`${prefix}: file-only requires output`);
	if (typeof task.output === "string") {
		if (path.isAbsolute(task.output)) fail(`${prefix}: output must be relative`);
		if (outputPaths.has(task.output)) fail(`${prefix}: duplicate output path ${task.output}`);
		outputPaths.add(task.output);
	}
}

for (const file of chainFiles) {
	const chain = readJson(file);
	const label = relative(file);
	const expectedName = path.basename(file, ".chain.json");
	if (chain?.name !== expectedName || chain?.package !== "pi-workbench" || !chain?.description || !Array.isArray(chain?.chain) || chain.chain.length === 0) {
		fail(`${label}: invalid chain root`);
		continue;
	}
	const available = new Set();
	const outputPaths = new Set();
	const topology = [];
	for (let index = 0; index < chain.chain.length; index += 1) {
		const step = chain.chain[index];
		const produced = new Set();
		if (Array.isArray(step.parallel)) {
			for (const key of Object.keys(step)) if (!allowedGroupKeys.has(key)) fail(`${label} step ${index + 1}: unsupported group key ${key}`);
			if (step.parallel.length !== 2 || step.concurrency !== 2) fail(`${label} step ${index + 1}: parallel review must contain exactly two concurrent tasks`);
			if (step.parallel.some((task) => expectedAgents[task.agent] === "writer")) fail(`${label} step ${index + 1}: writers may not run in parallel`);
			topology.push(step.parallel.map((task) => task.agent));
			for (const task of step.parallel) inspectTask(label, index + 1, task, available, produced, outputPaths);
		} else {
			topology.push(step.agent);
			inspectTask(label, index + 1, step, available, produced, outputPaths);
		}
		for (const output of produced) available.add(output);
	}
	if (chain.chain.at(-1)?.outputMode !== "inline") fail(`${label}: final step must return inline`);
	if (JSON.stringify(chain).includes("SHIPYARD") || JSON.stringify(chain).includes("team_")) fail(`${label}: legacy orchestration marker remains`);
	if (expectedName === "audit") {
		const expected = [["pi-workbench.reviewer", "pi-workbench.reviewer"], "pi-workbench.reviewer"];
		if (JSON.stringify(topology) !== JSON.stringify(expected)) fail(`${label}: audit topology changed`);
	}
	if (expectedName === "deliver") {
		const expected = [
			"pi-workbench.planner",
			"pi-workbench.worker",
			["pi-workbench.reviewer", "pi-workbench.reviewer"],
			"pi-workbench.worker",
			"pi-workbench.reviewer",
		];
		if (JSON.stringify(topology) !== JSON.stringify(expected)) fail(`${label}: delivery topology changed`);
	}
}

// Composition and command/tool surface.
const entrySource = readFileSync(path.join(root, "extensions", "index.ts"), "utf8");
const composition = [
	"registerSubagents(pi)",
	"registerRawSubagentBoundary(pi)",
	"registerWorkbenchRepoTool(pi)",
	"if (isChildSession()) return",
	"loadWorkbenchConfig()",
	"new WriterCoordinator(",
	"new SubagentRpcClient(",
	"createWorkflowService({",
	"registerRouter(pi",
];
let previous = -1;
for (const marker of composition) {
	const index = entrySource.indexOf(marker);
	if (index < 0) fail(`extensions/index.ts: missing composition marker ${marker}`);
	else if (index < previous) fail(`extensions/index.ts: ${marker} is registered out of order`);
	previous = Math.max(previous, index);
}
if ((entrySource.match(/new SubagentRpcClient\(/g) ?? []).length !== 1) fail("extensions/index.ts: must construct exactly one shared RPC client");
if (!entrySource.includes('pi.events.on("subagent:async-complete"') || !entrySource.includes("writerCoordinator.releaseRun(runId)")) {
	fail("extensions/index.ts: async completion must release writer leases");
}
if (!entrySource.includes("reconcileWriterLeases(writerCoordinator, rpc)")) fail("extensions/index.ts: session startup must reconcile writer leases");
for (const forbidden of ["resources_discover", "SUBAGENTS_SKILL", "registerTeams", "registerDynamic", "registerShipyard"]) {
	if (entrySource.includes(forbidden)) fail(`extensions/index.ts: obsolete or alternate policy surface ${forbidden}`);
}

const extensionFiles = walk(path.join(root, "extensions"), (file) => file.endsWith(".ts"));
const extensionPaths = extensionFiles.map(relative);
for (const legacy of ["extensions/teams/", "extensions/dynamic/", "extensions/shipyard/"]) {
	if (extensionPaths.some((file) => file.startsWith(legacy))) fail(`${legacy}: legacy module remains`);
}
for (const file of extensionFiles) {
	if (file === path.join(root, "extensions", "index.ts")) continue;
	const source = readFileSync(file, "utf8");
	if (/new (?:SubagentRpcClient|ShipyardRpcClient|TeamsRpcClient)\(/.test(source)) fail(`${relative(file)}: must use the shared RPC client`);
	if (file !== path.join(root, "extensions", "router.ts") && source.includes(".registerCommand(")) {
		fail(`${relative(file)}: only the router may register commands`);
	}
}
const allSource = extensionFiles.map((file) => readFileSync(file, "utf8")).join("\n");
if (/from\s+["'][^"']*pi-subagents\/src\//.test(allSource)) fail("extensions: must not deep-import pi-subagents internals");
const registeredTools = [...allSource.matchAll(/registerTool\(\{[\s\S]{0,160}?name:\s*["']([^"']+)["']/g)].map((match) => match[1]);
assertExactSet(registeredTools, ["subagent", "workbench_repo", "workbench_route"], "registered Workbench tools");
const routerSource = readFileSync(path.join(root, "extensions", "router.ts"), "utf8");
const routerCommands = [...routerSource.matchAll(/\.registerCommand\(["']([^"']+)["']/g)].map((match) => match[1]);
assertExactSet(routerCommands, ["work", "workbench"], "router commands");

const promptFiles = walk(path.join(root, "prompts"), (file) => file.endsWith(".md"));
if (promptFiles.length > 0) fail("prompts/: alternate command templates are not allowed");
const exampleFiles = walk(path.join(root, "examples"), () => true);
if (exampleFiles.length > 0) fail("examples/: programmable workflow examples are not part of the lean harness");

if (errors.length > 0) {
	console.error("Pi Workbench validation failed:");
	for (const error of errors) console.error(`- ${error}`);
	process.exit(1);
}

console.log(`Validated ${agentFiles.length} agents, ${skillFiles.length} skill, ${chainFiles.length} chains, ${registeredTools.length} tools, and the lean orchestration contract.`);
