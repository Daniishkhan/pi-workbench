import type { SubagentRpcClient } from "./subagent-rpc.ts";
import type { WriterCoordinator, WriterLease } from "./writer-coordinator.ts";

const TERMINAL_STATES = new Set(["complete", "completed", "failed", "stopped", "timed_out", "timeout"]);
const ACTIVE_STATES = new Set(["queued", "running", "paused", "stopping"]);

export type ReconciledRunState = "active" | "terminal" | "unknown";

export interface WriterReconciliationResult {
	checked: number;
	active: number;
	released: number;
	uncertain: number;
}

export function classifySubagentStatusText(text: string | undefined): ReconciledRunState {
	const state = /^State:\s*([^\s]+)\s*$/im.exec(text ?? "")?.[1]?.toLowerCase();
	if (!state) return "unknown";
	if (TERMINAL_STATES.has(state)) return "terminal";
	if (ACTIVE_STATES.has(state)) return "active";
	return "unknown";
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
