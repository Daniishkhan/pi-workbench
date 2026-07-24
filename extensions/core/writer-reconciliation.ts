import { classifySubagentStatusText, type ReconciledRunState } from "./run-lifecycle.ts";
import type { SubagentRpcClient } from "./subagent-rpc.ts";
import type { WriterCoordinator, WriterLease } from "./writer-coordinator.ts";

export { classifySubagentStatusText };
export type { ReconciledRunState };

export interface WriterReconciliationResult {
	checked: number;
	active: number;
	released: number;
	uncertain: number;
}

async function reconcileLease(
	coordinator: WriterCoordinator,
	rpc: Pick<SubagentRpcClient, "request">,
	lease: WriterLease,
): Promise<ReconciledRunState> {
	if (!lease.runId) return "unknown";
	try {
		const reply = await rpc.request("status", { id: lease.runId });
		if (!reply.success) {
			coordinator.markUncertain(lease.token);
			return "unknown";
		}
		const state = classifySubagentStatusText(reply.data?.text);
		if (state === "terminal") coordinator.release(lease.token);
		else if (state === "active") coordinator.attachRun(lease.token, lease.runId);
		else coordinator.markUncertain(lease.token);
		return state;
	} catch {
		coordinator.markUncertain(lease.token);
		return "unknown";
	}
}

export async function reconcileWriterLeases(
	coordinator: WriterCoordinator,
	rpc: Pick<SubagentRpcClient, "request">,
): Promise<WriterReconciliationResult> {
	const leases = coordinator.list().filter((lease) => Boolean(lease.runId));
	const states = await Promise.all(leases.map((lease) => reconcileLease(coordinator, rpc, lease)));
	return {
		checked: states.length,
		active: states.filter((state) => state === "active").length,
		released: states.filter((state) => state === "terminal").length,
		uncertain: states.filter((state) => state === "unknown").length,
	};
}
