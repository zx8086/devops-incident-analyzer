// src/tools/register.ts
// Family registration functions are added by Tasks 9-23. Each family is a single
// import + single call here. This file stays small and is the canonical place to
// see "what tools are exposed."
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../config/schemas.ts";

export function registerAllTools(server: McpServer, config: AwsConfig): void {
	// Each family registration is appended below as Tasks 9-23 land.
	// e.g. registerEc2Tools(server, config);
	void server;
	void config;
}
