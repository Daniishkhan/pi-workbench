import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const NoRawSubagentParams = Type.Object({}, { additionalProperties: false });

/** Replace upstream's unrestricted model tool while retaining its RPC runtime. */
export default function registerRawSubagentBoundary(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagent",
		label: "Subagent (use Pi Engineering)",
		description: "Direct subagent launches are disabled by Pi Engineering. Use assign_engineering so every assignment has a fixed specialist, runtime bound, and write-lock policy.",
		promptSnippet: "Use assign_engineering; direct subagent launching is disabled",
		parameters: NoRawSubagentParams,
		async execute() {
			throw new Error("Direct subagent launches are disabled. Call assign_engineering with inspect, plan, implement, review, deliver, or audit.");
		},
	});
}
