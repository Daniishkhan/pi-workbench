import { randomUUID } from "node:crypto";

export const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const SUBAGENT_RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
export const SUBAGENT_RPC_VERSION = 1;

export type SubagentRpcMethod = "ping" | "status" | "spawn" | "interrupt" | "stop";

export interface SubagentRpcReply {
	version: number;
	requestId: string;
	method?: string;
	success: boolean;
	data?: { text?: string; details?: Record<string, unknown> };
	error?: { code?: string; message?: string };
}

export interface SubagentRpcEventBus {
	on(event: string, handler: (payload: unknown) => void): (() => void) | void;
	emit(event: string, payload: unknown): void;
}

export interface SubagentRpcClientOptions {
	label: string;
	source: string;
	timeoutMs?: number;
}

export class SubagentRpcClient {
	readonly #events: SubagentRpcEventBus;
	readonly #label: string;
	readonly #source: string;
	readonly #timeoutMs: number;
	readonly #pending = new Map<string, (reason: string) => void>();
	#disposed = false;

	constructor(events: SubagentRpcEventBus, options: SubagentRpcClientOptions) {
		this.#events = events;
		this.#label = options.label;
		this.#source = options.source;
		this.#timeoutMs = options.timeoutMs ?? 15_000;
	}

	async request(method: SubagentRpcMethod, params: Record<string, unknown>, signal?: AbortSignal): Promise<SubagentRpcReply> {
		if (this.#disposed) throw new Error(`${this.#label} RPC client is disposed.`);
		if (signal?.aborted) throw new Error(`${this.#label} ${method} request cancelled before launch.`);
		const requestId = randomUUID();
		const replyEvent = `${SUBAGENT_RPC_REPLY_PREFIX}${requestId}`;
		return new Promise<SubagentRpcReply>((resolve, reject) => {
			let settled = false;
			let unsubscribe: (() => void) | void = () => undefined;
			let timer: ReturnType<typeof setTimeout>;
			const cleanup = () => {
				clearTimeout(timer);
				if (typeof unsubscribe === "function") unsubscribe();
				signal?.removeEventListener("abort", onAbort);
				this.#pending.delete(requestId);
			};
			const cancel = (reason: string) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(new Error(reason));
			};
			const onAbort = () => cancel(`${this.#label} ${method} request cancelled.`);
			timer = setTimeout(
				() => cancel(`Timed out waiting for pi-subagents RPC during ${this.#label} ${method}. Run /subagents-doctor.`),
				this.#timeoutMs,
			);
			unsubscribe = this.#events.on(replyEvent, (payload) => {
				if (settled || !payload || typeof payload !== "object") return;
				const reply = payload as Partial<SubagentRpcReply>;
				if (
					reply.version !== SUBAGENT_RPC_VERSION
					|| reply.requestId !== requestId
					|| (reply.method !== undefined && reply.method !== method)
					|| typeof reply.success !== "boolean"
				) return;
				settled = true;
				cleanup();
				resolve(reply as SubagentRpcReply);
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			this.#pending.set(requestId, cancel);
			if (signal?.aborted) return onAbort();
			this.#events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
				version: SUBAGENT_RPC_VERSION,
				requestId,
				method,
				params,
				source: { extension: this.#source },
			});
		});
	}

	dispose(reason = `${this.#label} RPC request cancelled because the Pi session shut down or reloaded.`): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const cancel of [...this.#pending.values()]) cancel(reason);
		this.#pending.clear();
	}

	get pendingCount(): number {
		return this.#pending.size;
	}
}

export function runIdFromSpawnReply(reply: SubagentRpcReply): string | undefined {
	const details = reply.data?.details;
	if (!details || typeof details !== "object") return undefined;
	for (const key of ["runId", "asyncId", "id"] as const) {
		const value = details[key];
		if (typeof value === "string" && value) return value;
	}
	return undefined;
}
