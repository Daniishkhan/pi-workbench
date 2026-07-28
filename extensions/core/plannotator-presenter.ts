import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { AssignmentBoundary } from "./assignment-boundary.ts";
import { buildCompletionReport } from "./completion-report.ts";

export const PLANNOTATOR_REQUEST_CHANNEL = "plannotator:request";
export const MAX_PLANNOTATOR_FEEDBACK_LENGTH = 8_192;
export const MAX_PRESENTED_RUN_IDS = 256;

type PlannotatorAnnotationResult = {
	feedback?: unknown;
	approved?: unknown;
	exit?: unknown;
};

type PlannotatorResponse = {
	status?: unknown;
	result?: PlannotatorAnnotationResult;
};

export interface PlannotatorPresenterDependencies {
	events: Pick<EventBus, "emit">;
	assignmentBoundary: Pick<AssignmentBoundary, "authorizeHumanFeedback">;
	sendUserMessage: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => void;
}

function boundedFeedback(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const feedback = value.trim();
	if (!feedback) return undefined;
	return feedback.length <= MAX_PLANNOTATOR_FEEDBACK_LENGTH
		? feedback
		: `${feedback.slice(0, MAX_PLANNOTATOR_FEEDBACK_LENGTH).trimEnd()}\n\n[Feedback truncated at ${MAX_PLANNOTATOR_FEEDBACK_LENGTH} characters.]`;
}

/**
 * Soft integration with Plannotator's public event API. The normal completion
 * notification remains authoritative when Plannotator is absent or unavailable.
 */
export class PlannotatorPresenter {
	readonly #events: Pick<EventBus, "emit">;
	readonly #assignmentBoundary: Pick<AssignmentBoundary, "authorizeHumanFeedback">;
	readonly #sendUserMessage: PlannotatorPresenterDependencies["sendUserMessage"];
	readonly #presentedRuns = new Set<string>();

	constructor(dependencies: PlannotatorPresenterDependencies) {
		this.#events = dependencies.events;
		this.#assignmentBoundary = dependencies.assignmentBoundary;
		this.#sendUserMessage = dependencies.sendUserMessage;
	}

	#rememberRun(runId: string): void {
		if (this.#presentedRuns.size >= MAX_PRESENTED_RUN_IDS) {
			const oldest = this.#presentedRuns.values().next().value as string | undefined;
			if (oldest) this.#presentedRuns.delete(oldest);
		}
		this.#presentedRuns.add(runId);
	}

	present(payload: unknown): boolean {
		const report = buildCompletionReport(payload);
		if (!report || this.#presentedRuns.has(report.runId)) return false;
		this.#rememberRun(report.runId);
		let responded = false;
		try {
			this.#events.emit(PLANNOTATOR_REQUEST_CHANNEL, {
				requestId: `pi-engineering-report:${report.runId}`,
				action: "annotate-last",
				payload: {
					filePath: "last-message",
					markdown: report.markdown,
					mode: "annotate-last",
					gate: report.needsAttention,
				},
				respond: (response: PlannotatorResponse) => {
					if (responded) return;
					responded = true;
					if (response?.status !== "handled") return;
					const feedback = boundedFeedback(response.result?.feedback);
					if (!feedback) return;
					try {
						this.#sendUserMessage([
							`Human feedback on completed Pi Engineering ${report.workflow} run '${report.runId}':`,
							"",
							feedback,
							"",
							"Treat this annotation as direct human input. Respond to its explicit request. Approval or closing the report alone never authorizes another engineering assignment.",
						].join("\n"), { deliverAs: "followUp" });
						this.#assignmentBoundary.authorizeHumanFeedback();
					} catch {
						// Presentation feedback must never break the completion lifecycle.
					}
				},
			});
		} catch {
			// A missing listener or integration failure leaves the inline receipt intact.
		}
		return true;
	}
}
