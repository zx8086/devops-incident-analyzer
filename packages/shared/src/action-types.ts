// shared/src/action-types.ts
import { z } from "zod";

export const PendingActionSchema = z.object({
	id: z.string(),
	tool: z.enum(["notify-slack", "create-ticket"]),
	params: z.record(z.string(), z.unknown()),
	reason: z.string(),
});
export type PendingAction = z.infer<typeof PendingActionSchema>;

export const ActionResultSchema = z.object({
	actionId: z.string(),
	tool: z.string(),
	status: z.enum(["success", "error"]),
	result: z.record(z.string(), z.unknown()).optional(),
	error: z.string().optional(),
});
export type ActionResult = z.infer<typeof ActionResultSchema>;
