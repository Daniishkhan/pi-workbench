import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Prevent specialist children from loading project-local settings or code. */
export default function registerChildProjectTrustBoundary(pi: ExtensionAPI): void {
	pi.on("project_trust", () => ({ trusted: "no" }));
}
