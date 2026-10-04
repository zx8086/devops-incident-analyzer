// src/wire.test.ts
// SIO-1958: landing-zone-iac serves both protocol eras from /mcp on SDK v2.
import { describe } from "bun:test";
import { dualEraWireSuite } from "@devops-agent/shared/src/testing/mcp-wire-suite.ts";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Config } from "./config.ts";
import { createMcpServerFactory } from "./server.ts";
import type { GitLabReadClient } from "./tools/repositories.ts";

const config: Config = {
	transport: { mode: "http", port: 1, host: "127.0.0.1", path: "/mcp" },
	gitlab: { baseUrl: "https://gitlab.example", token: undefined, timeoutMs: 30_000, maxResponseBytes: 200_000 },
	write: { enabled: false, allowedProjects: [], allowedPathPrefixes: {}, backendProjects: [] },
};

describe("SIO-1958: landing-zone-iac wire protocol on SDK v2", () => {
	dualEraWireSuite({
		label: "landing-zone-iac",
		serverFactory: createMcpServerFactory(config, {} as GitLabReadClient),
		createHandler: (factory) => createMcpHandler(factory, { legacy: "stateless" }),
		okTool: { name: "lz_list_repositories", args: {} },
		invalidCall: { name: "lz_read_repository_files", args: { repository: "x", paths: [] } },
	});
});
