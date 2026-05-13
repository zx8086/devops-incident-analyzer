// shared/src/tracing/nested-trace.ts
import { getCurrentRunTree, traceable, withRunTree } from "langsmith/traceable";
import { isTracingActive } from "./langsmith.ts";

export async function withNestedTrace<T>(
	name: string,
	runType: "chain" | "tool" | "retriever" | "llm",
	handler: () => Promise<T>,
): Promise<T> {
	if (!isTracingActive()) return handler();

	const parentRun = getCurrentRunTree();
	const tracedHandler = traceable(async () => handler(), { name, run_type: runType });

	if (parentRun) {
		return withRunTree(parentRun, tracedHandler);
	}
	return tracedHandler();
}
