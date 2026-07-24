import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSubagents from "pi-subagents";
import { registerBackgroundWorkProvider } from "pi-subagents/background-work";
import { loadWorkbenchConfig } from "./core/config.ts";
import { isChildSession } from "./core/env.ts";
import { runIdFromAsyncComplete } from "./core/run-lifecycle.ts";
import { SubagentRpcClient } from "./core/subagent-rpc.ts";
import { WriterCoordinator } from "./core/writer-coordinator.ts";
import { reconcileWriterLeases } from "./core/writer-reconciliation.ts";
import registerDynamicWorkflows from "./dynamic/index.ts";
import registerRouter from "./router.ts";
import registerShipyard, { type ShipyardService } from "./shipyard/index.ts";
import registerTeams from "./teams/index.ts";

const SUBAGENTS_PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.resolve("pi-subagents")));
const SUBAGENTS_SKILL = path.join(SUBAGENTS_PACKAGE_ROOT, "skills", "pi-subagents");

export default function piWorkbench(pi: ExtensionAPI): void {
	// pi-subagents is an upstream dependency pinned by Workbench's lockfile.
	// Register it first so its public RPC and delegation bridges exist before
	// Workbench modules construct their single shared client.
	registerSubagents(pi);

	const config = loadWorkbenchConfig();
	const writerCoordinator = new WriterCoordinator({ enabled: config.writerGuard.enabled });
	const isChild = isChildSession();
	const rpc = isChild ? undefined : new SubagentRpcClient(pi.events, {
		label: "Pi Workbench",
		source: "@danish/pi-workbench",
	});
	let shipyard: ShipyardService | undefined;

	// Shipyard's repo and findings tools and Teams' mailbox/task tools are useful
	// inside their leaf children. Their orchestration entry points gate themselves.
	if (config.modules.shipyard) {
		shipyard = registerShipyard(pi, {
			agentBindings: config.shipyard.agentBindings,
			writerCoordinator,
			rpc,
		});
	}
	if (config.modules.agentTeams) registerTeams(pi, { writerCoordinator, rpc });

	const discoveredSkills = [SUBAGENTS_SKILL];
	if (!isChild && rpc) {
		if (config.modules.dynamicWorkflows) {
			registerDynamicWorkflows(pi, {
				writerCoordinator,
				dynamicConfig: config.dynamic,
				registerBackgroundWork: (provider) => registerBackgroundWorkProvider(provider),
			});
			discoveredSkills.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../skills/dynamic-workflows"));
		}
		registerRouter(pi, { config, shipyard, writerCoordinator, rpc });

		const unsubscribe = pi.events.on("subagent:async-complete", (payload) => {
			const runId = runIdFromAsyncComplete(payload);
			if (runId) writerCoordinator.releaseRun(runId);
		});

		pi.on("session_start", (_event, ctx) => {
			writerCoordinator.setSessionId(ctx.sessionManager.getSessionId() ?? undefined);
			queueMicrotask(() => void reconcileWriterLeases(writerCoordinator, rpc));
		});

		pi.on("session_shutdown", () => {
			if (typeof unsubscribe === "function") unsubscribe();
			rpc.dispose();
		});
	}

	pi.on("resources_discover", () => ({ skillPaths: discoveredSkills }));
}
