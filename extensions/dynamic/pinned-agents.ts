import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROLE_POLICIES } from "../core/role-policy.ts";

/** Logical read-only roles a dynamic workflow may reference are derived from
 * the shared role policy: read-only capability plus the dynamic surface.
 * pi-workbench.reviewer is excluded — it maps to the verifier definition. */
export const DYNAMIC_READER_ROLES: readonly string[] = Object.entries(ROLE_POLICIES)
	.filter(([name, policy]) => policy.capability === "read-only" && policy.surfaces.includes("dynamic") && name !== "pi-workbench.reviewer")
	.map(([name]) => name);

export const DYNAMIC_VERIFIER_ROLES: readonly string[] = ["pi-workbench.reviewer"];

export interface PinnedReadOnlyAgents {
	map: Readonly<Record<string, string>>;
	files: string[];
	dispose(): void;
}

function writeAgent(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

export function createPinnedReadOnlyAgents(agentDir: string): PinnedReadOnlyAgents {
	const token = `${process.pid}-${randomUUID().replaceAll("-", "")}`;
	const packageName = "pi-workbench-dynamic-runtime";
	const agentsDir = path.join(agentDir, "agents");
	const definitions = [
		{
			logical: DYNAMIC_READER_ROLES,
			name: `reader-${token}`,
			description: "Ephemeral strictly read-only Workbench dynamic-workflow reader",
			prompt: [
				"You are a strictly read-only leaf agent inside a deterministic Pi Workbench dynamic workflow.",
				"Investigate the assigned question using targeted repository reads/searches and, when requested, web research.",
				"Return concise evidence-backed results in exactly the requested format.",
				"Never edit, write, create, move, or delete files. Never execute shell commands.",
				"Never launch subagents, agent teams, Shipyard, or workflows.",
				"If JSON is requested, return only schema-conforming JSON with no Markdown fence or prose.",
			].join("\n"),
		},
		{
			logical: DYNAMIC_VERIFIER_ROLES,
			name: `verifier-${token}`,
			description: "Ephemeral strictly read-only Workbench dynamic-workflow verifier",
			prompt: [
				"You are a strictly read-only adversarial verifier inside a deterministic Pi Workbench dynamic workflow.",
				"Challenge supplied claims against primary evidence and reject unsupported conclusions.",
				"Return only evidence-backed findings in exactly the requested format.",
				"Never edit, write, create, move, or delete files. Never execute shell commands.",
				"Never launch subagents, agent teams, Shipyard, or workflows.",
				"If JSON is requested, return only schema-conforming JSON with no Markdown fence or prose.",
			].join("\n"),
		},
	];
	const files: string[] = [];
	const map: Record<string, string> = {};
	try {
		for (const definition of definitions) {
			const file = path.join(agentsDir, `pi-workbench-dynamic-runtime-${definition.name}.md`);
			writeAgent(file, [
				"---",
				`name: ${definition.name}`,
				`package: ${packageName}`,
				`description: ${definition.description}`,
				"tools: read, grep, find, ls, web_search, fetch_content, get_search_content",
				"systemPromptMode: replace",
				"defaultContext: fresh",
				"acceptanceRole: read-only",
				"inheritProjectContext: true",
				"inheritSkills: false",
				"---",
				"",
				definition.prompt,
				"",
			].join("\n"));
			files.push(file);
			const runtimeName = `${packageName}.${definition.name}`;
			for (const logical of definition.logical) map[logical] = runtimeName;
		}
	} catch (error) {
		for (const file of files) {
			try { fs.unlinkSync(file); } catch { /* Best-effort rollback. */ }
		}
		throw error;
	}
	return {
		map: Object.freeze(map),
		files,
		dispose() {
			for (const file of files) {
				try { fs.unlinkSync(file); } catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Failed to remove ephemeral workflow agent '${file}':`, error);
				}
			}
		},
	};
}
