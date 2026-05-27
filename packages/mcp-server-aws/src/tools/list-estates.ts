// src/tools/list-estates.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AwsConfig } from "../config/schemas.ts";
import { toMcp } from "./wrap.ts";

// SIO-828: introspection tool. The supervisor pins estates from awsTargetEstates
// at fan-out time, so the sub-agent LLM rarely calls this. Useful for the
// smoke-test script and any consumer that wants to know what's configured.
const schema = z.object({});

export function registerListEstatesTool(server: McpServer, config: AwsConfig): void {
	server.tool(
		"aws_list_estates",
		"List the AWS estates this runtime is configured to query. Returns estate IDs (e.g. dev, staging, prod).",
		schema.shape,
		async () => toMcp({ estates: Object.keys(config.estates) }),
	);
}
