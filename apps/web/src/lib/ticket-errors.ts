// apps/web/src/lib/ticket-errors.ts
import { z } from "zod";

// Shared by the ticket cards (CreateTicketCard, AddCommentCard): pull the API's
// { error: string } message out of a parsed JSON body, falling back to a status
// line when the shape is unexpected.
const ErrorResponseSchema = z.object({ error: z.string() });

export function errorFrom(data: unknown, status: number): string {
	const parsed = ErrorResponseSchema.safeParse(data);
	return parsed.success ? parsed.data.error : `Request failed (${status})`;
}
