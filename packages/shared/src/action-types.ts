// shared/src/action-types.ts
import { z } from "zod";

// SIO-1635: verify-with-pi / investigate-with-pi hand the report to the pi-coms hub.
export const ActionToolSchema = z.enum(["notify-slack", "create-ticket", "verify-with-pi", "investigate-with-pi"]);
export type ActionTool = z.infer<typeof ActionToolSchema>;

export const PendingActionSchema = z.object({
	id: z.string(),
	tool: ActionToolSchema,
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
	// SIO-1635: an executed action may propose the next card (verify -> investigate).
	followUpActions: z.array(PendingActionSchema).optional(),
});
export type ActionResult = z.infer<typeof ActionResultSchema>;
