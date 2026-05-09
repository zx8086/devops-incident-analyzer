// packages/agent/src/sub-agent-instrumentation.ts

import type { ToolMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { describeToolResult } from "./sub-agent-tool-result-shape.ts";

interface InstrumentLogger {
	info: (...args: unknown[]) => unknown;
	warn: (...args: unknown[]) => unknown;
}

export interface InstrumentContext {
	dataSourceId: string;
	deploymentId?: string;
	log: InstrumentLogger;
}

// Wraps each tool so we can observe what flows back from MCP into the ReAct loop.
// We intercept invoke() only; name, description, schema, and other metadata remain
// the original references via Proxy passthrough so LangChain's tool-binding sees
// an unchanged surface.
export function instrumentTools(tools: StructuredToolInterface[], ctx: InstrumentContext): StructuredToolInterface[] {
	const counter = { iteration: 0 };
	return tools.map((tool) => instrumentTool(tool, ctx, counter));
}

function instrumentTool(
	tool: StructuredToolInterface,
	ctx: InstrumentContext,
	counter: { iteration: number },
): StructuredToolInterface {
	const handler: ProxyHandler<StructuredToolInterface> = {
		get(target, prop, receiver) {
			if (prop === "invoke") {
				return async (arg: unknown, configArg?: unknown) => {
					counter.iteration += 1;
					const iteration = counter.iteration;
					const result = await target.invoke(
						arg as Parameters<StructuredToolInterface["invoke"]>[0],
						configArg as Parameters<StructuredToolInterface["invoke"]>[1],
					);
					recordResult(result, tool.name, iteration, ctx);
					return result;
				};
			}
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	};
	return new Proxy(tool, handler);
}

function recordResult(result: unknown, toolName: string, iteration: number, ctx: InstrumentContext): void {
	const content = extractContent(result);
	const { bytes, shape } = describeToolResult(content);
	ctx.log.info(
		{
			event: "subagent.tool_result",
			dataSourceId: ctx.dataSourceId,
			deploymentId: ctx.deploymentId,
			toolName,
			iteration,
			bytes,
			contentType: shape.contentType,
			shape,
		},
		"Tool result observed",
	);
}

function extractContent(result: unknown): unknown {
	if (result && typeof result === "object" && "content" in result) {
		return (result as ToolMessage).content;
	}
	return result;
}
