import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const warnings = [];
const fail = (message) => errors.push(message);

function walk(dir, predicate) {
	const output = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) output.push(...walk(file, predicate));
		else if (predicate(file)) output.push(file);
	}
	return output.sort();
}

function relative(file) {
	return path.relative(root, file);
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

const packageJson = readJson(path.join(root, "package.json"));
if (packageJson) {
	if (packageJson.name !== "@danish/pi-workbench") fail("package.json: unexpected package name");
	if (!packageJson.keywords?.includes("pi-package")) fail("package.json: keywords must include pi-package");
	const runtimeSource = "https://codeload.github.com/nicobailon/pi-subagents/tar.gz/105c1399d36517292cc7dbe1f56f4724de39bd10";
	if (packageJson.dependencies?.["pi-subagents"] !== runtimeSource) {
		fail("package.json: pi-subagents must be an immutable upstream dependency owned by the Workbench lockfile");
	}
	if (packageJson.bundledDependencies?.includes?.("pi-subagents")) fail("package.json: do not vendor pi-subagents source into the Workbench tarball");
	if (!packageJson.files?.includes?.("THIRD_PARTY.md") || !existsSync(path.join(root, "THIRD_PARTY.md"))) fail("package.json: third-party provenance must ship with Workbench");
	for (const [kind, entries] of Object.entries({
		extensions: packageJson.pi?.extensions,
		skills: packageJson.pi?.skills,
		prompts: packageJson.pi?.prompts,
		agents: packageJson.pi?.subagents?.agents,
		chains: packageJson.pi?.subagents?.chains,
	})) {
		if (!Array.isArray(entries) || entries.length === 0) fail(`package.json: pi manifest missing ${kind}`);
		for (const entry of entries ?? []) if (!existsSync(path.resolve(root, entry))) fail(`package.json: missing ${kind} path ${entry}`);
	}
}

const agentFiles = walk(path.join(root, "agents"), (file) => file.endsWith(".md"));
const agentNames = new Set();
const agentMeta = new Map();
for (const file of agentFiles) {
	const fm = parseFrontmatter(file);
	if (!fm.name) fail(`${relative(file)}: missing name`);
	if (!fm.description) fail(`${relative(file)}: missing description`);
	if (!fm.package || !["pi-workbench", "pi-shipyard", "pi-agent-teams"].includes(fm.package)) fail(`${relative(file)}: unexpected package namespace ${fm.package}`);
	const runtimeName = `${fm.package}.${fm.name}`;
	if (agentNames.has(runtimeName)) fail(`${relative(file)}: duplicate runtime name ${runtimeName}`);
	agentNames.add(runtimeName);
	agentMeta.set(runtimeName, { file, fm });
	for (const field of ["model", "fallbackModels", "thinking"]) {
		if (Object.hasOwn(fm, field)) fail(`${relative(file)}: ${field} belongs in profiles/settings, not role frontmatter`);
	}
	if (fm.acceptanceRole === "read-only" && /(?:^|,\s*)(?:edit|write)(?:,|$)/.test(fm.tools ?? "")) {
		fail(`${relative(file)}: read-only agent exposes edit/write`);
	}
	if (runtimeName.startsWith("pi-workbench.") && fm.acceptanceRole === "read-only" && /(?:^|,\s*)bash(?:,|$)/.test(fm.tools ?? "")) {
		fail(`${relative(file)}: general Workbench read-only roles must not expose unrestricted bash`);
	}
	if ((fm.tools ?? "").includes("review_findings") && (Object.hasOwn(fm, "extensions") || Object.hasOwn(fm, "subagentOnlyExtensions"))) {
		fail(`${relative(file)}: findings roles must use the installed package provider, not relative extension paths`);
	}
}

const skillFiles = walk(path.join(root, "skills"), (file) => path.basename(file) === "SKILL.md");
const skillNames = new Set();
for (const file of skillFiles) {
	const fm = parseFrontmatter(file);
	if (!fm.name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fm.name)) fail(`${relative(file)}: invalid skill name`);
	if (!fm.description) fail(`${relative(file)}: missing skill description`);
	if (skillNames.has(fm.name)) fail(`${relative(file)}: duplicate skill ${fm.name}`);
	skillNames.add(fm.name);
}
for (const file of agentFiles) {
	const fm = parseFrontmatter(file);
	for (const skill of (fm.skills ?? "").split(",").map((value) => value.trim()).filter(Boolean)) {
		if (!skillNames.has(skill)) fail(`${relative(file)}: unknown selected skill ${skill}`);
	}
}

const profile = readJson(path.join(root, "profiles", "recommended-agent-overrides.json"));
if (profile?.schemaVersion !== 1 || !profile?.agentOverrides) fail("profiles/recommended-agent-overrides.json: invalid profile");
for (const agent of agentNames) if (!profile?.agentOverrides?.[agent]) fail(`profile: missing model policy for ${agent}`);
for (const agent of Object.keys(profile?.agentOverrides ?? {})) if (!agentNames.has(agent)) fail(`profile: unknown agent ${agent}`);

const outputReferencePattern = /\{outputs\.([A-Za-z_][A-Za-z0-9_]*)\}/g;
const allowedStepKeys = new Set([
	"agent", "task", "phase", "label", "as", "outputSchema", "cwd", "output", "outputMode", "reads", "progress",
	"skill", "model", "toolBudget", "acceptance", "parallel", "expand", "collect", "concurrency", "failFast", "worktree",
]);
const allowedParallelTaskKeys = new Set([
	"agent", "task", "phase", "label", "as", "outputSchema", "cwd", "count", "output", "outputMode", "reads", "progress",
	"skill", "model", "toolBudget", "acceptance",
]);

function inspectTask(chainLabel, stepNumber, task, available, produced, isParallel = false) {
	const prefix = `${chainLabel} step ${stepNumber}${isParallel ? " parallel task" : ""}`;
	const allowed = isParallel ? allowedParallelTaskKeys : allowedStepKeys;
	for (const key of Object.keys(task)) if (!allowed.has(key)) fail(`${prefix}: unsupported key ${key}`);
	if (!task.agent || !agentNames.has(task.agent)) fail(`${prefix}: unknown agent ${task.agent}`);
	if (typeof task.task !== "string" || !task.task.trim()) fail(`${prefix}: task must be non-empty`);
	for (const match of task.task?.matchAll(outputReferencePattern) ?? []) {
		if (!available.has(match[1])) fail(`${prefix}: forward or unknown output reference ${match[1]}`);
	}
	if ([...(task.task?.matchAll(outputReferencePattern) ?? [])].length > 0 && !task.task.includes("Open and read every referenced output artifact before reasoning")) {
		fail(`${prefix}: file-only consumer must explicitly open referenced artifacts`);
	}
	if (["contracts", "runtime", "adversarial", "integration", "security", "ui"].includes(task.as ?? "")
		&& !task.task.includes("Independent-wave rule: do not call review_findings list")) {
		fail(`${prefix}: first-wave reviewer must prohibit peer-ledger reads`);
	}
	if (task.as) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(task.as)) fail(`${prefix}: invalid as name ${task.as}`);
		if (available.has(task.as) || produced.has(task.as)) fail(`${prefix}: duplicate as name ${task.as}`);
		produced.add(task.as);
	}
	if (task.outputMode === "file-only" && typeof task.output !== "string") fail(`${prefix}: file-only requires output`);
	if (typeof task.output === "string" && path.isAbsolute(task.output)) fail(`${prefix}: package chain outputs must be relative`);
	if (task.task?.includes("{chain_dir}")) fail(`${prefix}: Shipyard async chains may not rely on {chain_dir}`);
}

function validateDeliveryTopology(chain, label) {
	const implementationIndex = chain.chain.findIndex((step) => step.agent === "pi-shipyard.implementation-worker" && step.as === "implementation");
	const reviewIndex = chain.chain.findIndex((step) => Array.isArray(step.parallel));
	const falsifierIndex = chain.chain.findIndex((step) => step.agent === "pi-shipyard.falsifier");
	const fixesIndex = chain.chain.findIndex((step) => step.agent === "pi-shipyard.implementation-worker" && step.as === "fixes");
	const finalIndex = chain.chain.length - 1;
	if (!(implementationIndex >= 0 && implementationIndex < reviewIndex && reviewIndex < falsifierIndex && falsifierIndex < fixesIndex && fixesIndex < finalIndex)) {
		fail(`${label}: invalid delivery topology`);
	}
	if (!Array.isArray(chain.chain[reviewIndex]?.parallel) || chain.chain[reviewIndex].parallel.length !== 2) fail(`${label}: delivery requires exactly two independent reviewers`);
	if (chain.chain[finalIndex]?.agent !== "pi-shipyard.shipwright" || chain.chain[finalIndex]?.outputMode !== "inline") fail(`${label}: delivery must end with inline shipwright`);
}

const chainFiles = walk(path.join(root, "chains"), (file) => file.endsWith(".chain.json"));
for (const file of chainFiles) {
	const chain = readJson(file);
	const label = relative(file);
	if (!chain?.name || !chain?.description || !Array.isArray(chain.chain)) { fail(`${label}: invalid chain root`); continue; }
	if (chain.package !== "pi-shipyard") fail(`${label}: compatibility namespace must remain pi-shipyard`);
	const available = new Set();
	const outputPaths = new Set();
	for (let index = 0; index < chain.chain.length; index += 1) {
		const step = chain.chain[index];
		const produced = new Set();
		const tasks = Array.isArray(step.parallel) ? step.parallel : [step];
		for (const task of tasks) {
			if (typeof task.output === "string") {
				if (outputPaths.has(task.output)) fail(`${label} step ${index + 1}: duplicate output ${task.output}`);
				outputPaths.add(task.output);
			}
		}
		if (Array.isArray(step.parallel)) {
			for (const key of Object.keys(step)) if (!allowedStepKeys.has(key)) fail(`${label} step ${index + 1}: unsupported group key ${key}`);
			if (step.parallel.some((task) => agentMeta.get(task.agent)?.fm.acceptanceRole === "writer" || task.agent === "pi-shipyard.implementation-worker")) {
				fail(`${label} step ${index + 1}: writer agents may not run in parallel`);
			}
			for (const task of step.parallel) inspectTask(label, index + 1, task, available, produced, true);
		} else inspectTask(label, index + 1, step, available, produced, false);
		for (const output of produced) available.add(output);
	}
	if ((chain.name.startsWith("review-") || ["ship", "deliver", "deliver-compact"].includes(chain.name)) && !JSON.stringify(chain).includes("{{SHIPYARD_STORE}}")) {
		fail(`${label}: review/delivery workflow must use Shipyard store placeholder`);
	}
	if (["deliver", "deliver-compact"].includes(chain.name)) validateDeliveryTopology(chain, label);
	if (chain.chain.at(-1)?.outputMode !== "inline") warnings.push(`${label}: final step is not inline`);
}

const shipyardSource = readFileSync(path.join(root, "extensions", "shipyard", "workflows.ts"), "utf8");
if (!shipyardSource.includes("artifacts: false") || shipyardSource.includes("artifacts: true")) fail("Shipyard launches must disable project-local pi-subagents artifacts");
const workflowPolicySource = readFileSync(path.join(root, "extensions", "shipyard", "workflow-policy.ts"), "utf8");
if (!shipyardSource.includes("bindWorkflowAgents") || !workflowPolicySource.includes("export function bindWorkflowAgents")) fail("Shipyard must support canonical role bindings");
const teamsRpc = readFileSync(path.join(root, "extensions", "teams", "rpc.ts"), "utf8");
const shipyardRpc = readFileSync(path.join(root, "extensions", "shipyard", "rpc-client.ts"), "utf8");
if (!teamsRpc.includes("../core/subagent-rpc.ts") || !shipyardRpc.includes("../core/subagent-rpc.ts")) fail("Shipyard and Teams must share the core RPC implementation");
const dynamicDelegation = readFileSync(path.join(root, "extensions", "dynamic", "delegation.ts"), "utf8");
if (dynamicDelegation.includes("parallelResults") || dynamicDelegation.includes("LegacyResponse")) fail("Dynamic workflows must not use the unversioned legacy batch bridge");
if (!dynamicDelegation.includes("this.runSingle")) fail("Dynamic read-only fanout must use versioned single delegations");
const configSource = readFileSync(path.join(root, "extensions", "core", "config.ts"), "utf8");
if (!configSource.includes("dynamicWorkflows: false")) fail("Dynamic Workflows must be disabled by default");
const entrySource = readFileSync(path.join(root, "extensions", "index.ts"), "utf8");
for (const required of ["registerSubagents", "loadWorkbenchConfig", "WriterCoordinator", "SubagentRpcClient", "reconcileWriterLeases", "registerShipyard", "registerTeams", "registerRouter"]) {
	if (!entrySource.includes(required)) fail(`Workbench entry point must compose ${required}`);
}
if ((entrySource.match(/new SubagentRpcClient\(/g) ?? []).length !== 1) fail("Workbench composition root must construct exactly one shared RPC client");
if (!entrySource.includes("registerSubagents(pi)")) fail("Workbench must register its pinned pi-subagents dependency");
if (entrySource.indexOf("registerSubagents(pi)") > entrySource.indexOf("new SubagentRpcClient")) fail("pi-subagents must register before Workbench constructs its RPC client");
if (!entrySource.includes("SUBAGENTS_SKILL")) fail("Workbench must rediscover the upstream pi-subagents skill");
for (const relativePath of ["extensions/router.ts", "extensions/shipyard/workflows.ts", "extensions/teams/index.ts"]) {
	const source = readFileSync(path.join(root, relativePath), "utf8");
	if (/new (?:SubagentRpcClient|ShipyardRpcClient|TeamsRpcClient)\(/.test(source)) fail(`${relativePath} must use the shared RPC client`);
}
const allSource = walk(path.join(root, "extensions"), (file) => file.endsWith(".ts")).map((file) => readFileSync(file, "utf8")).join("\n");
if (/from\s+["'][^"']*pi-subagents\/src\//.test(allSource)) fail("Extensions must not deep-import pi-subagents internals");

const promptFiles = walk(path.join(root, "prompts"), (file) => file.endsWith(".md"));
for (const file of promptFiles) if (!parseFrontmatter(file).description) fail(`${relative(file)}: missing prompt description`);

if (errors.length) {
	console.error("Pi Workbench validation failed:");
	for (const error of errors) console.error(`- ${error}`);
	process.exit(1);
}
console.log(`Validated ${agentFiles.length} agents, ${skillFiles.length} skills, ${chainFiles.length} chains, ${promptFiles.length} prompts, and shared orchestration invariants.`);
for (const warning of warnings) console.warn(`Warning: ${warning}`);
