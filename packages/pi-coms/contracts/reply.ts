// packages/pi-coms/contracts/reply.ts
// Runtime companion to wire.ts (which stays types-only). Dependency-free so the
// Pi package manifest does not grow a runtime dependency.

// SIO-1678: the one definition of "this reply carries no answer". A responder
// that posts undefined, null or whitespace-only text with no error had no
// assistant text to give; the hub stores it as `error: "empty_reply"` and
// every consumer reads it as not answered.
export function isBlankReply(response: unknown): boolean {
	if (response === undefined || response === null) return true;
	return typeof response === "string" && response.trim() === "";
}
