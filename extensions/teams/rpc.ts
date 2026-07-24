import {
	SUBAGENT_RPC_REPLY_PREFIX as RPC_REPLY_PREFIX,
	SUBAGENT_RPC_REQUEST_EVENT as RPC_REQUEST_EVENT,
	SUBAGENT_RPC_VERSION as RPC_VERSION,
	SubagentRpcClient,
	runIdFromSpawnReply,
	type SubagentRpcEventBus as RpcEventBus,
	type SubagentRpcReply as RpcReply,
} from "../core/subagent-rpc.ts";

export { RPC_REPLY_PREFIX, RPC_REQUEST_EVENT, RPC_VERSION, runIdFromSpawnReply };
export type { RpcEventBus, RpcReply };

export class TeamsRpcClient extends SubagentRpcClient {
	constructor(events: RpcEventBus, timeoutMs = 15_000) {
		super(events, {
			label: "Agent Teams",
			source: "@danish/pi-workbench/teams",
			timeoutMs,
		});
	}
}
