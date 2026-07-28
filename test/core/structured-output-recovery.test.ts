import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerStructuredOutputRecovery, {
	renderStructuredReceipt,
	recoverStructuredOutputFinalization,
} from "../../extensions/core/structured-output-recovery.ts";

function assistant(content: unknown[]): Record<string, unknown> {
	return { role: "assistant", content, model: "test" };
}

test("adds recovery text to a tool-only structured output finalization", () => {
	const toolCall = { type: "toolCall", id: "1", name: "structured_output", arguments: {} };
	const message = assistant([toolCall]);
	const recovered = recoverStructuredOutputFinalization(message) as { content: Array<Record<string, unknown>> };
	assert.equal(recovered.content[0]?.type, "text");
	assert.match(String(recovered.content[0]?.text), /final structured result/i);
	assert.deepEqual(recovered.content[1], toolCall);
});

test("renders a bounded terminal review receipt into the assistant handoff", () => {
	const value = {
		verdict: "NOT_READY",
		summary: "One correctness defect remains.",
		findings: [{
			severity: "P1",
			path: "src/checkout.ts",
			line: { start: 42, end: 42 },
			violatedContract: "Retries must be idempotent.",
			scenario: "A repeated callback charges twice.",
			safeFix: "Persist the idempotency key before charging.",
		}],
		validationEvidence: [{ check: "npm test", status: "REPORTED", evidence: "worker handoff" }],
		residualRisks: ["The external sandbox was unavailable."],
	};
	const receipt = renderStructuredReceipt(value) ?? "";
	assert.match(receipt, /^NOT_READY: One correctness defect remains\./);
	assert.match(receipt, /\[P1\] src\/checkout\.ts:42/);
	assert.match(receipt, /fix: Persist the idempotency key/);
	assert.match(receipt, /npm test=REPORTED/);

	const toolCall = { type: "toolCall", id: "1", name: "structured_output", arguments: { value } };
	const recovered = recoverStructuredOutputFinalization(assistant([toolCall])) as { content: Array<Record<string, unknown>> };
	assert.equal(recovered.content[0]?.text, receipt);
	assert.deepEqual(recovered.content[1], toolCall);
});

test("preserves structured output messages that already contain text", () => {
	const message = assistant([
		{ type: "text", text: "NOT_READY: one finding remains." },
		{ type: "toolCall", id: "1", name: "structured_output", arguments: {} },
	]);
	assert.equal(recoverStructuredOutputFinalization(message), undefined);
});

test("ignores other tools and non-assistant messages", () => {
	assert.equal(recoverStructuredOutputFinalization(assistant([{ type: "toolCall", name: "read" }])), undefined);
	assert.equal(recoverStructuredOutputFinalization({ role: "toolResult", content: [] }), undefined);
});

test("the registered handler places a recovered grep failure before terminal assistant text", async () => {
	let handler: ((event: { message: unknown }) => Promise<{ message?: unknown } | undefined> | { message?: unknown } | undefined) | undefined;
	registerStructuredOutputRecovery({
		on(event: string, value: typeof handler) {
			if (event === "message_end") handler = value;
		},
	} as unknown as ExtensionAPI);
	assert.ok(handler);

	const final = assistant([{ type: "toolCall", id: "structured", name: "structured_output", arguments: {} }]);
	const replacement = await handler({ message: final });
	assert.ok(replacement?.message);
	const messages = [
		assistant([{ type: "text", text: "Checking one more symbol." }]),
		{ role: "toolResult", toolName: "grep", isError: true, content: [{ type: "text", text: "invalid regex" }] },
		replacement.message,
		{ role: "toolResult", toolName: "structured_output", isError: false, content: [{ type: "text", text: "captured" }] },
	] as Array<Record<string, unknown>>;
	const lastAssistantIndex = messages.findLastIndex((message) => {
		if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
		return (message.content as Array<Record<string, unknown>>)
			.some((part) => part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0);
	});
	assert.equal(lastAssistantIndex, 2, "the final structured_output message is the recovery boundary");
	assert.equal(
		messages.slice(lastAssistantIndex + 1).some((message) => message.role === "toolResult" && message.isError === true),
		false,
		"no failed tool result remains after the terminal assistant text",
	);
});
