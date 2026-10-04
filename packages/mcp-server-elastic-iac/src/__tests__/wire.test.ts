// src/__tests__/wire.test.ts
// SIO-1960: elastic-iac serves both protocol eras from /mcp on SDK v2.
import { describe } from "bun:test";
import { dualEraWireSuite } from "@devops-agent/shared/src/testing/mcp-wire-suite.ts";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Config } from "../config.ts";
import { createMcpServerFactory } from "../server.ts";

const config: Config = {
	transport: { mode: "http", port: 0, host: "127.0.0.1", path: "/mcp" },
	repository: {
		gitlabBaseUrl: "https://gitlab.example.com",
		projectId: "1",
		workspaceDir: "/tmp/elastic-iac-wire-test",
	},
	gitops: { baseUrl: "https://gitlab.example.com", project: "example/elastic-iac", token: undefined },
	taskBin: "task",
	gitlabToken: undefined,
	elasticCloudApiKey: undefined,
	elasticCloudBaseUrl: "https://api.elastic-cloud.com",
	clusterDeployments: [],
};

describe("SIO-1960: elastic-iac wire protocol on SDK v2", () => {
	dualEraWireSuite({
		label: "elastic-iac",
		serverFactory: createMcpServerFactory(config),
		createHandler: (factory) => createMcpHandler(factory, { legacy: "stateless" }),
		okTool: { name: "iac_list_deployments", args: {} },
		invalidCall: { name: "elastic_get_index_template", args: {} },
	});
});
