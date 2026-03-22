// apps/web/src/routes/api/agent/stream/+server.ts
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { invokeAgent } from "$lib/server/agent";
import { z } from "zod";

const StreamRequestSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string(),
    }),
  ),
  threadId: z.string().optional(),
  dataSources: z.array(z.string()).optional(),
  isFollowUp: z.boolean().optional(),
});

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = StreamRequestSchema.parse(await request.json());
    const threadId = body.threadId ?? crypto.randomUUID();

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };

        try {
          const startTime = Date.now();

          const eventStream = await invokeAgent(body.messages, {
            threadId,
            dataSources: body.dataSources,
            isFollowUp: body.isFollowUp,
          });

          for await (const event of eventStream) {
            if (event.event === "on_chat_model_stream" && event.data?.chunk?.content) {
              send({ type: "message", content: String(event.data.chunk.content) });
            }

            if (event.event === "on_chain_start" && event.name) {
              send({ type: "node_start", nodeId: event.name });
            }

            if (event.event === "on_chain_end" && event.name) {
              send({ type: "node_end", nodeId: event.name, duration: 0 });
            }

            if (event.event === "on_tool_start") {
              send({
                type: "tool_call",
                toolName: event.name ?? "unknown",
                args: event.data?.input ?? {},
              });
            }
          }

          send({
            type: "done",
            threadId,
            responseTime: Date.now() - startTime,
          });
        } catch (error) {
          send({ type: "error", message: error instanceof Error ? error.message : "Unknown error" });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    return json({ error: "Invalid request" }, { status: 400 });
  }
};
