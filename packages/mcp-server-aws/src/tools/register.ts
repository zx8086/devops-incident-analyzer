// src/tools/register.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../config/schemas.ts";
import { registerEc2Tools } from "./ec2/index.ts";

export function registerAllTools(server: McpServer, config: AwsConfig): void {
	registerEc2Tools(server, config);
}
