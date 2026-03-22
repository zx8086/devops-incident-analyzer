// apps/web/src/routes/api/agent/feedback/+server.ts
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { z } from "zod";

const FeedbackSchema = z.object({
  runId: z.string(),
  score: z.number().min(0).max(1),
  comment: z.string().optional(),
});

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = FeedbackSchema.parse(await request.json());
    const apiKey = process.env.LANGSMITH_API_KEY;

    if (!apiKey) {
      return json({ success: false, error: "LangSmith not configured" }, { status: 500 });
    }

    await fetch("https://api.smith.langchain.com/api/v1/feedback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        run_id: body.runId,
        key: "user-feedback",
        score: body.score,
        comment: body.comment,
      }),
    });

    return json({ success: true });
  } catch {
    return json({ error: "Invalid feedback" }, { status: 400 });
  }
};
