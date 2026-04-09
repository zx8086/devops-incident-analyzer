// apps/web/src/routes/api/agent/actions/+server.ts
import { executeAction } from "@devops-agent/agent";
import { PendingActionSchema } from "@devops-agent/shared";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import type { RequestHandler } from "./$types";

const ExecuteActionRequestSchema = z.object({
	action: PendingActionSchema,
	reportContent: z.string(),
	threadId: z.string(),
});

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = ExecuteActionRequestSchema.parse(await request.json());
		const result = await executeAction(body.action, {
			reportContent: body.reportContent,
			threadId: body.threadId,
		});
		return json(result);
	} catch (err) {
		if (err instanceof z.ZodError) {
			return json({ error: "Invalid request", details: err.issues }, { status: 400 });
		}
		return json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 500 });
	}
};
