import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentRpcClient } from "../core/subagent-rpc.ts";
import type { WriterCoordinator } from "../core/writer-coordinator.ts";
import registerRepoContext from "./repo-context.ts";
import registerReviewFindings from "./review-findings.ts";
import registerWorkflows, { type ShipyardWorkflowService } from "./workflows.ts";

export interface RegisterShipyardOptions {
	agentBindings?: Record<string, string>;
	writerCoordinator?: WriterCoordinator;
	rpc?: SubagentRpcClient;
}

export interface ShipyardService {
	workflows: ShipyardWorkflowService;
}

export default function registerShipyard(pi: ExtensionAPI, options: RegisterShipyardOptions = {}): ShipyardService {
	registerRepoContext(pi);
	registerReviewFindings(pi);
	return {
		workflows: registerWorkflows(pi, options),
	};
}
