import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { initializeStore, type FindingStatus } from "./findings-store.ts";

const CAPABILITY_SCHEMA_VERSION = 1;
const CAPABILITY_FILE = ".findings-capabilities.json";
const ALL_ACTIONS = ["init", "add", "get", "list", "update", "stats", "snapshot", "export"] as const;

export type FindingAction = typeof ALL_ACTIONS[number];
export type FindingUpdateField = "title" | "summary" | "severity" | "confidence" | "status" | "category" | "evidence" | "failureScenario" | "suggestedFix" | "validation" | "dispositionReason" | "tags";

export interface CapabilityPolicy {
	stage: string;
	sourceRole: string;
	actions: FindingAction[];
	updateFields?: FindingUpdateField[];
	updateStatuses?: FindingStatus[];
}

interface StoredCapability extends CapabilityPolicy {
	digest: string;
}

interface CapabilityRegistry {
	schemaVersion: number;
	kind: "pi-shipyard-findings-capabilities";
	runId: string;
	workflow: string;
	createdAt: string;
	capabilities: StoredCapability[];
}

export interface CapabilityGrant extends CapabilityPolicy {
	token: string;
}

export interface FindingAuthorization extends CapabilityPolicy {
	manual: boolean;
}

function digestToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function constantTimeEqual(left: string, right: string): boolean {
	const a = Buffer.from(left, "hex");
	const b = Buffer.from(right, "hex");
	return a.length === b.length && timingSafeEqual(a, b);
}

function registryPath(storePath: string): string {
	return path.join(path.dirname(storePath), CAPABILITY_FILE);
}

function validatePolicy(policy: CapabilityPolicy): void {
	if (!policy.stage.trim() || !policy.sourceRole.trim()) throw new Error("Findings capability stage and sourceRole are required.");
	if (policy.actions.length === 0 || policy.actions.some((action) => !ALL_ACTIONS.includes(action))) {
		throw new Error("Findings capability must allow at least one known action.");
	}
}

export async function createCapabilityRegistry(
	storePath: string,
	runId: string,
	workflow: string,
	policies: CapabilityPolicy[],
): Promise<CapabilityGrant[]> {
	const grants = policies.map((policy) => {
		validatePolicy(policy);
		return { ...policy, token: randomBytes(32).toString("base64url") };
	});
	const registry: CapabilityRegistry = {
		schemaVersion: CAPABILITY_SCHEMA_VERSION,
		kind: "pi-shipyard-findings-capabilities",
		runId,
		workflow,
		createdAt: new Date().toISOString(),
		capabilities: grants.map(({ token, ...policy }) => ({ ...policy, digest: digestToken(token) })),
	};
	await writeFile(registryPath(storePath), `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
	return grants;
}

function validateRegistry(value: CapabilityRegistry, runId: string, workflow: string): CapabilityRegistry {
	if (
		value.schemaVersion !== CAPABILITY_SCHEMA_VERSION
		|| value.kind !== "pi-shipyard-findings-capabilities"
		|| value.runId !== runId
		|| value.workflow !== workflow
		|| !Array.isArray(value.capabilities)
	) {
		throw new Error("Invalid or mismatched Shipyard findings capability registry.");
	}
	for (const policy of value.capabilities) {
		validatePolicy(policy);
		if (!/^[a-f0-9]{64}$/.test(policy.digest)) throw new Error("Invalid Shipyard findings capability digest.");
	}
	return value;
}

export async function authorizeFindingAction(
	storePath: string,
	token: string | undefined,
	action: FindingAction,
): Promise<FindingAuthorization> {
	const manifest = await initializeStore(storePath);
	let registry: CapabilityRegistry;
	try {
		registry = validateRegistry(JSON.parse(await readFile(registryPath(storePath), "utf8")) as CapabilityRegistry, manifest.runId, manifest.workflow);
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
		if (code === "ENOENT") {
			throw new Error("This findings store has no capability registry. Initialize a manual store or check the exact workflow store path.");
		}
		throw error;
	}
	if (!token?.trim()) throw new Error("A run-scoped findings capability is required for this workflow action.");
	const digest = digestToken(token.trim());
	const policy = registry.capabilities.find((candidate) => constantTimeEqual(candidate.digest, digest));
	if (!policy) throw new Error("Invalid findings capability for this Shipyard run.");
	if (!policy.actions.includes(action)) throw new Error(`Findings capability for ${policy.sourceRole} does not allow ${action}.`);
	const { digest: _digest, ...authorization } = policy;
	return { ...authorization, manual: manifest.workflow === "manual" };
}
