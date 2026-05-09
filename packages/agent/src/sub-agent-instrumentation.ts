// packages/agent/src/sub-agent-instrumentation.ts

import { ToolMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { describeToolResult } from "./sub-agent-tool-result-shape.ts";
import { truncateToolOutput } from "./sub-agent-truncate-tool-output.ts";

interface InstrumentLogger {
	info: (...args: unknown[]) => unknown;
	warn: (...args: unknown[]) => unknown;
}

export interface InstrumentContext {
	dataSourceId: string;
	deploymentId?: string;
	log: InstrumentLogger;
	// SIO-686: when set, ToolMessage content exceeding capBytes is JSON-aware truncated
	// before re-entering the ReAct loop. Disabled when null/undefined (current default).
	capBytes?: number | null;
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
					return processResult(result, tool.name, iteration, ctx);
				};
			}
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	};
	return new Proxy(tool, handler);
}

function processResult(result: unknown, toolName: string, iteration: number, ctx: InstrumentContext): unknown {
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

	if (ctx.capBytes == null || ctx.capBytes <= 0) return result;

	const text = stringifyContent(content);
	if (Buffer.byteLength(text, "utf8") <= ctx.capBytes) return result;

	const truncated = truncateToolOutput(text, ctx.capBytes);
	if (truncated.strategy === "none") return result;

	ctx.log.info(
		{
			event: "subagent.tool_result_truncated",
			dataSourceId: ctx.dataSourceId,
			deploymentId: ctx.deploymentId,
			toolName,
			iteration,
			originalBytes: truncated.originalBytes,
			finalBytes: truncated.finalBytes,
			strategy: truncated.strategy,
		},
		"Tool result truncated",
	);

	return rebuildResult(result, truncated.content);
}

function extractContent(result: unknown): unknown {
	if (result && typeof result === "object" && "content" in result) {
		return (result as ToolMessage).content;
	}
	return result;
}

function stringifyContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (content == null) return "";
	try {
		return JSON.stringify(content) ?? "";
	} catch {
		return String(content);
	}
}

function rebuildResult(original: unknown, newContent: string): unknown {
	if (original instanceof ToolMessage) {
		return new ToolMessage({
			content: newContent,
			tool_call_id: original.tool_call_id,
			name: original.name,
			status: original.status,
			artifact: original.artifact,
		});
	}
	if (original && typeof original === "object" && "content" in original) {
		// Plain ToolMessage-shaped object (e.g. from a fake tool); copy all fields
		// and overwrite content.
		return { ...(original as Record<string, unknown>), content: newContent };
	}
	return newContent;
}
