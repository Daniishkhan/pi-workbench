import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSubagents from "pi-subagents";
import { AssignmentBoundary } from "./core/assignment-boundary.ts";
import { loadEngineeringConfig } from "./core/config.ts";
import { isChildSession } from "./core/env.ts";
import { PlannotatorPresenter } from "./core/plannotator-presenter.ts";
import registerRawSubagentBoundary from "./core/runtime-boundary.ts";
import { runIdFromAsyncComplete } from "./core/run-lifecycle.ts";
import { SubagentRpcClient } from "./core/subagent-rpc.ts";
import registerStructuredOutputRecovery from "./core/structured-output-recovery.ts";
import { WriterCoordinator } from "./core/writer-coordinator.ts";
import { reconcileWriterLeases } from "./core/writer-reconciliation.ts";
import registerInspectRepoTool from "./core/repo-tool.ts";
import registerRouter from "./router.ts";
import createWorkflowService from "./workflows.ts";

export default function piEngineering(pi: ExtensionAPI): void {
	// Register the immutable upstream runtime before constructing its shared RPC
	// client. Pi Engineering deliberately does not rediscover the upstream policy skill.
	registerSubagents(pi);
	registerRawSubagentBoundary(pi);
	registerInspectRepoTool(pi);

	// Leaf sessions need the runtime and repository inspection tool, but never a
	// second orchestration front door.
	if (isChildSession()) {
		registerStructuredOutputRecovery(pi);
		return;
	}

	const config = loadEngineeringConfig();
	const assignmentBoundary = new AssignmentBoundary();
	const reportPresenter = new PlannotatorPresenter({
		events: pi.events,
		assignmentBoundary,
		sendUserMessage: (content, options) => pi.sendUserMessage(content, options),
	});
	const writerCoordinator = new WriterCoordinator({ enabled: config.writeLock.enabled });
	const rpc = new SubagentRpcClient(pi.events, {
		label: "Pi Engineering",
		source: "@danish/pi-engineering",
	});
	const workflows = createWorkflowService({ writerCoordinator, rpc });
	registerRouter(pi, { assignmentBoundary, config, workflows, writerCoordinator, rpc });

	pi.on("input", (event) => {
		assignmentBoundary.observeInput(event.source);
	});

	const unsubscribe = pi.events.on("subagent:async-complete", (payload) => {
		const runId = runIdFromAsyncComplete(payload);
		if (runId) {
			assignmentBoundary.completeWorkflow(runId, payload);
			writerCoordinator.releaseRun(runId);
			reportPresenter.present(payload);
		}
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
