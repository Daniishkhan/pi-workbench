/**
 * Guarded specialist spawn: the one place that choreographs a write lock
 * around a pi-subagents RPC launch.
 *
 * Write-lock lifecycle (identical for one-off specialists and engineering workflows):
 *   1. acquire the lease (writers only), then verify RPC readiness (ping);
 *      any ping failure releases the lease. Acquire is self-healing: a
 *      blocking lease whose run has authoritative terminal artifacts is
 *      reaped and the acquire retried once;
 *   2. issue the spawn request without wiring caller cancellation into the
 *      acknowledgement wait — an emitted launch must not be orphaned;
 *      cancellation after emission waits for the run id and requests stop;
 *      a transport failure keeps the lease but marks it uncertain, because
 *      the launch may have been accepted;
 *   3. an RPC-level rejection releases the lease;
 *   4. on success the lease is attached to the returned run id (or marked
 *      uncertain when no run id came back) and ownership moves to the run.
 */

import { reconcileSubagentRunState } from "./run-lifecycle.ts";
import { runIdFromSpawnReply, type SubagentRpcClient, type SubagentRpcReply } from "./subagent-rpc.ts";
import type { WriterCoordinator, WriterLease } from "./writer-coordinator.ts";

export interface BeginGuardedSpawnOptions {
	rpc: Pick<SubagentRpcClient, "request">;
	writerCoordinator?: WriterCoordinator;
	cwd: string;
	/** Lease owner label, e.g. "engineering:implement:pi-workbench.worker". */
	owner: string;
	writeCapable: boolean;
	/** Error prefix, e.g. "Engineering assignment" or "Engineering workflow assignment". */
	label: string;
	signal?: AbortSignal;
}

export interface GuardedSpawnCall {
	params: Record<string, unknown>;
	signal?: AbortSignal;
	/** When set, a successful reply without a run id throws this message (after marking the lease uncertain). */
	requireRunIdMessage?: string;
	/** Journaling hook after a transport error (lease already marked uncertain), before the error is rethrown. */
	onTransportError?: (error: unknown) => void | Promise<void>;
	/** Journaling hook after an RPC-level rejection (before the lease is released), before the error is thrown. */
	onRejected?: (reply: SubagentRpcReply) => void | Promise<void>;
}

export interface GuardedSpawnResult {
	reply: SubagentRpcReply;
	runId?: string;
}

type LeaseState = "none" | "held" | "transferred" | "released";

export interface GuardedSpawn {
	readonly lease: WriterLease | undefined;
	spawn(call: GuardedSpawnCall): Promise<GuardedSpawnResult>;
	/** Release the lease only while this guard still owns it. No-op once the
	 * spawn succeeded (or may have succeeded) and the run owns the lease. */
	discard(): void;
}

function rpcErrorDetail(reply: SubagentRpcReply, fallback: string): string {
	const code = reply.error?.code;
	const message = reply.error?.message ?? fallback;
	return code ? `${code}: ${message}` : message;
}

/** Acquire the write lock with self-healing: when the blocking lock belongs
 * to a run whose durable pi-subagents artifacts confirm termination, reap the
 * orphaned lease and retry once instead of failing the launch. Active or
 * unverifiable blockers keep the original conflict error. */
async function acquireLease(
	options: BeginGuardedSpawnOptions,
	coordinator: WriterCoordinator | undefined,
): Promise<WriterLease | undefined> {
	if (!options.writeCapable || !coordinator) return undefined;
	try {
		return coordinator.acquire(options.cwd, options.owner);
	} catch (error) {
		const blocking = coordinator.get(options.cwd);
		if (!blocking?.runId) throw error;
		let state: ReturnType<typeof reconcileSubagentRunState> = "unknown";
		try {
			const reply = await options.rpc.request("status", { id: blocking.runId }, options.signal);
			if (reply.success) {
				state = reconcileSubagentRunState({
					runId: blocking.runId,
					statusText: reply.data?.text,
					asyncDir: blocking.asyncDir,
				});
			}
		} catch {
			state = "unknown";
		}
		if (state !== "terminal") throw error;
		if (!coordinator.release(blocking.token)) throw error;
		return coordinator.acquire(options.cwd, options.owner);
	}
}

export async function beginGuardedSpawn(options: BeginGuardedSpawnOptions): Promise<GuardedSpawn> {
	const coordinator = options.writerCoordinator;
	const lease = await acquireLease(options, coordinator);
	let state: LeaseState = lease ? "held" : "none";
	const release = () => {
		if (state !== "held") return;
		state = "released";
		coordinator?.release(lease?.token);
	};

	const ping = await options.rpc.request("ping", {}, options.signal).catch((error: unknown) => {
		release();
		throw error;
	});
	if (!ping.success) {
		release();
		throw new Error(`${options.label}: pi-subagents RPC unavailable: ${rpcErrorDetail(ping, "ping failed")}.`);
	}

	return {
		lease,
		discard: release,
		async spawn(call: GuardedSpawnCall): Promise<GuardedSpawnResult> {
			const signal = call.signal ?? options.signal;
			if (signal?.aborted) {
				release();
				throw new Error(`${options.label} cancelled before spawn request.`);
			}
			let abortedDuringSpawn = false;
			const onAbort = () => { abortedDuringSpawn = true; };
			signal?.addEventListener("abort", onAbort, { once: true });
			let reply: SubagentRpcReply;
			try {
				// Deliberately omit the signal. Once the request is emitted we need its
				// acknowledgement (and run id) to cancel the launched process safely.
				reply = await options.rpc.request("spawn", call.params).catch(async (error: unknown) => {
					// The launch may have been accepted before the reply was lost:
					// keep the lease, flag it, journal, then rethrow the original error.
					if (state === "held") {
						state = "transferred";
						coordinator?.markUncertain(lease?.token);
					}
					await call.onTransportError?.(error);
					throw error;
				});
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
			if (!reply.success) {
				await call.onRejected?.(reply);
				release();
				throw new Error(`${options.label} failed: ${rpcErrorDetail(reply, "unknown RPC error")}`);
			}
			const runId = runIdFromSpawnReply(reply);
			const asyncDir = typeof reply.data?.details?.asyncDir === "string" && reply.data.details.asyncDir
				? reply.data.details.asyncDir
				: undefined;
			if (state === "held") {
				state = "transferred";
				if (runId) {
					let attached = true;
					let attachmentError: unknown;
					try {
						attached = coordinator?.attachRun(lease?.token, runId, asyncDir) !== false;
					} catch (error) {
						attached = false;
						attachmentError = error;
					}
					if (!attached) {
						try { coordinator?.markUncertain(lease?.token, runId, asyncDir); } catch { /* preserve the acknowledged run id below */ }
						const stopRequested = await options.rpc.request("stop", { id: runId })
							.then((stop) => stop.success, () => false);
						const detail = attachmentError instanceof Error ? ` (${attachmentError.message})` : "";
						throw new Error(`${options.label} acknowledged run ${runId}, but its writer lease could not be attached${detail}; ${stopRequested ? "stop requested" : "stop could not be confirmed"}. Inspect that run before retrying.`);
					}
				} else coordinator?.markUncertain(lease?.token);
			}
			if (abortedDuringSpawn || signal?.aborted) {
				let stopRequested = false;
				if (runId) {
					stopRequested = await options.rpc.request("stop", { id: runId })
						.then((stop) => stop.success, () => false);
				}
				throw new Error(runId
					? `${options.label} cancelled after spawn acknowledgement; ${stopRequested ? "stop requested" : "stop could not be confirmed"} for ${runId}.`
					: `${options.label} cancelled after spawn acknowledgement; inspect active subagents because no run id was returned.`);
			}
			if (!runId && call.requireRunIdMessage) throw new Error(call.requireRunIdMessage);
			return { reply, runId };
		},
	};
}
