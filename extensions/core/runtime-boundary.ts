import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const NoRawSubagentParams = Type.Object({}, { additionalProperties: false });

/** Replace upstream's unrestricted model tool while retaining its RPC runtime. */
export default function registerRawSubagentBoundary(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagent",
		label: "Subagent (use Workbench)",
		description: "Direct subagent launches are disabled by Pi Workbench. Use workbench_route so every launch has a fixed role, runtime bound, and writer policy.",
		promptSnippet: "Use workbench_route; direct subagent launching is disabled",
		parameters: NoRawSubagentParams,
		async execute() {
			throw new Error("Direct subagent launches are disabled. Call workbench_route with inspect, plan, implement, review, deliver, or audit.");
		},
	});
}
