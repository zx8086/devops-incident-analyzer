// src/v2/tools/echo.ts
//
// SIO-1443: v2 port of the capella_echo diagnostic tool. Re-implemented against
// @modelcontextprotocol/server's registerTool config style. Handler body is ported verbatim
// from server.ts's inline registration (lines 133-144); only the server/registration plumbing
// changes. Annotations are hand-written per tool-classification.ts: capella_echo is in
// READ_ONLY_TOOLS (line 13 of tool-classification.ts).

import type { McpServer, RegisteredTool, ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import { logger } from "../../utils/logger";

const READ_ONLY_ANNOTATIONS: ToolAnnotations = { readOnlyHint: true, destructiveHint: false };

export function registerEchoToolV2(server: McpServer, tools: Map<string, RegisteredTool>): void {
	const echo = server.registerTool(
		"capella_echo",
		{
			description: "Echoes back the input parameters for debugging",
			inputSchema: z.object({}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async (params: Record<string, unknown>) => {
			logger.info({ raw_params: JSON.stringify(params) }, "EchoTool RAW params");
			return { content: [{ type: "text" as const, text: JSON.stringify(params) }] };
		},
	);
	tools.set("capella_echo", echo);
}
