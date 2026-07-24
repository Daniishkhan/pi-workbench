/**
 * Path-segment sanitizer for Workbench-owned state directories (run ids,
 * session ids, draft names). Distinct from the stricter identifier
 * normalizers (team/member names, workflow names), which stay with their
 * domain stores.
 */
export function safePathSegment(value: string, fallback = "unknown"): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || fallback;
}
