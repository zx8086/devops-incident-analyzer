// apps/web/src/lib/ticket-errors.ts
// Shared by the ticket cards (CreateTicketCard, AddCommentCard): pull the API's
// { error: string } message out of a parsed JSON body, falling back to a status
// line when the shape is unexpected.
export function errorFrom(data: unknown, status: number): string {
	if (data && typeof data === "object" && "error" in data) {
		const message = (data as { error?: unknown }).error;
		if (typeof message === "string") return message;
	}
	return `Request failed (${status})`;
}
