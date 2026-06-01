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
		"List the AWS estates this runtime is CONFIGURED to query (for routing), plus each estate's boot-time STS:AssumeRole health snapshot and effective region. NOTE: this is the configured/reachable set, NOT the estates assessed in the current investigation -- a healthy entry here only means the role assumed at boot, not that the estate was probed. Do not report 'all N accounts healthy' from this output; scope findings to the estate(s) actually queried this run.",
		schema.shape,
		async () =>
			toMcp({
				// SIO-832: surface effective region per estate so the LLM and operators can see
				// at a glance where each estate's tool calls will be routed.
				estates: Object.entries(config.estates).map(([id, est]) => ({
					id,
					region: est.region ?? config.region,
				})),
				health: getEstateHealth(),
			}),
	);
}
