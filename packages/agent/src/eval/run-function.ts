// packages/agent/src/eval/run-function.ts
import { HumanMessage } from "@langchain/core/messages";
import { buildGraph } from "../graph.ts";

let cachedGraph: Awaited<ReturnType<typeof buildGraph>> | undefined;

export async function runAgent(inputs: { query: string }): Promise<{
	output: { response: string; targetDataSources: string[]; confidenceCap?: number };
}> {
	if (!cachedGraph) {
		cachedGraph = await buildGraph({ checkpointerType: "memory" });
	}
	const finalState = await cachedGraph.invoke(
		{ messages: [new HumanMessage(inputs.query)] },
		{ configurable: { thread_id: `eval-${crypto.randomUUID()}` } },
	);
	const lastMessage = finalState.messages.at(-1);
	const responseText =
		typeof lastMessage?.content === "string" ? lastMessage.content : JSON.stringify(lastMessage?.content ?? "");
	return {
		output: {
			response: responseText,
			targetDataSources: finalState.targetDataSources ?? [],
			confidenceCap: finalState.confidenceCap,
		},
	};
}
