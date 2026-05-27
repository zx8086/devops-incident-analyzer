// src/tools/list-estates.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AwsConfig } from "../config/schemas.ts";
import { getEstateHealth } from "../services/estate-validator.ts";
import { toMcp } from "./wrap.ts";

// SIO-828: introspection + health tool. Returns the configured estate IDs
// plus the most recent per-estate validation snapshot (from boot-time
// estate-validator). Operators read this to see which estates are degraded
// without grepping logs; the smoke-test script uses it to confirm the
// runtime's AWS_ESTATES env was parsed.
const schema = z.object({});

export function registerListEstatesTool(server: McpServer, config: AwsConfig): void {
	server.tool(
		"aws_list_estates",
		"List the AWS estates this runtime is configured to query, plus the latest per-estate health snapshot from boot-time STS:AssumeRole validation.",
		schema.shape,
		async () =>
			toMcp({
				estates: Object.keys(config.estates),
				health: getEstateHealth(),
			}),
	);
}
