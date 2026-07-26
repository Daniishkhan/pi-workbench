import assert from "node:assert/strict";
import test from "node:test";
import registerRawSubagentBoundary from "../../extensions/core/runtime-boundary.ts";

test("replaces the unrestricted upstream model tool with a Workbench boundary", async () => {
	let tool: any;
	registerRawSubagentBoundary({
		registerTool(value: unknown) { tool = value; },
	} as never);

	assert.equal(tool.name, "subagent");
	assert.match(tool.description, /Use workbench_route/);
	assert.equal(tool.parameters.additionalProperties, false);
	await assert.rejects(
		() => tool.execute("call", {}, undefined, undefined, {}),
		/Direct subagent launches are disabled/,
	);
});
