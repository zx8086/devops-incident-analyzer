// gitagent-bridge/src/index.test.ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	buildAllToolPrompts,
	buildFacadeMap,
	buildRelatedToolsMap,
	buildSystemPrompt,
	buildToolPrompt,
	complianceToMetadata,
	getRecursionLimit,
	getUncoveredTools,
	loadAgent,
	matchesPattern,
	requiresApproval,
	resolveBedrockConfig,
	resolveMapping,
	type ToolDefinition,
	validateToolSchemas,
	withRelatedTools,
} from "./index.ts";

const AGENTS_DIR = join(import.meta.dir, "../../../agents/incident-analyzer");

describe("manifest-loader", () => {
	test("loads root agent with all fields", () => {
		const agent = loadAgent(AGENTS_DIR);
		expect(agent.manifest.name).toBe("incident-analyzer");
		expect(agent.manifest.version).toBe("0.1.0");
		expect(agent.manifest.model?.preferred).toBe("claude-sonnet-4-6");
		expect(agent.manifest.delegation?.mode).toBe("router");
		expect(agent.manifest.compliance?.risk_tier).toBe("medium");
	});

	test("loads SOUL.md and RULES.md", () => {
		const agent = loadAgent(AGENTS_DIR);
		expect(agent.soul).toContain("Core Identity");
		expect(agent.rules).toContain("Must Always");
	});

	test("loads all 6 tool definitions", () => {
		const agent = loadAgent(AGENTS_DIR);
		expect(agent.tools.length).toBe(6);
		const toolNames = agent.tools.map((t) => t.name);
		expect(toolNames).toContain("elastic-search-logs");
		expect(toolNames).toContain("kafka-introspect");
		expect(toolNames).toContain("couchbase-cluster-health");
		expect(toolNames).toContain("konnect-api-gateway");
		expect(toolNames).toContain("notify-slack");
		expect(toolNames).toContain("create-ticket");
	});

	test("loads all 3 skills", () => {
		const agent = loadAgent(AGENTS_DIR);
		expect(agent.skills.size).toBe(3);
		expect(agent.skills.has("normalize-incident")).toBe(true);
		expect(agent.skills.has("aggregate-findings")).toBe(true);
		expect(agent.skills.has("propose-mitigation")).toBe(true);
	});

	test("loads all 4 sub-agents recursively", () => {
		const agent = loadAgent(AGENTS_DIR);
		expect(agent.subAgents.size).toBe(4);
		expect(agent.subAgents.has("elastic-agent")).toBe(true);
		expect(agent.subAgents.has("kafka-agent")).toBe(true);
		expect(agent.subAgents.has("capella-agent")).toBe(true);
		expect(agent.subAgents.has("konnect-agent")).toBe(true);

		const elastic = agent.subAgents.get("elastic-agent") as ReturnType<typeof loadAgent>;
		expect(elastic.manifest.name).toBe("elastic-agent");
		expect(elastic.manifest.model?.preferred).toBe("claude-haiku-4-5");
		expect(elastic.soul).toContain("Elasticsearch specialist");
	});
});

describe("model-factory", () => {
	test("resolves claude-sonnet-4-6 to Bedrock ID", () => {
		const config = resolveBedrockConfig({ preferred: "claude-sonnet-4-6" });
		expect(config.model).toBe("eu.anthropic.claude-sonnet-4-6");
		expect(config.region).toMatch(/^eu-/); // eu-west-1 or eu-central-1 depending on env
	});

	test("resolves claude-haiku-4-5 to Bedrock ID", () => {
		const config = resolveBedrockConfig({ preferred: "claude-haiku-4-5" });
		expect(config.model).toBe("eu.anthropic.claude-haiku-4-5-20251001-v1:0");
	});

	test("applies temperature and maxTokens from constraints", () => {
		const config = resolveBedrockConfig({
			preferred: "claude-sonnet-4-6",
			constraints: { temperature: 0.2, max_tokens: 4096 },
		});
		expect(config.temperature).toBe(0.2);
		expect(config.maxTokens).toBe(4096);
	});

	test("throws on unknown model", () => {
		expect(() => resolveBedrockConfig({ preferred: "unknown-model" })).toThrow("Unknown model");
	});

	test("getRecursionLimit doubles maxTurns", () => {
		expect(getRecursionLimit(50)).toBe(100);
		expect(getRecursionLimit(undefined)).toBe(50);
	});
});

describe("skill-loader", () => {
	test("builds system prompt with SOUL + RULES + all skills", () => {
		const agent = loadAgent(AGENTS_DIR);
		const prompt = buildSystemPrompt(agent);
		expect(prompt).toContain("Core Identity");
		expect(prompt).toContain("Must Always");
		expect(prompt).toContain("Skill: normalize-incident");
		expect(prompt).toContain("Skill: aggregate-findings");
		expect(prompt).toContain("Skill: propose-mitigation");
	});

	test("builds prompt with filtered skills", () => {
		const agent = loadAgent(AGENTS_DIR);
		const prompt = buildSystemPrompt(agent, ["normalize-incident"]);
		expect(prompt).toContain("Skill: normalize-incident");
		expect(prompt).not.toContain("Skill: aggregate-findings");
	});

	test("handles sub-agent with no skills", () => {
		const agent = loadAgent(AGENTS_DIR);
		const elastic = agent.subAgents.get("elastic-agent") as ReturnType<typeof loadAgent>;
		const prompt = buildSystemPrompt(elastic);
		expect(prompt).toContain("Elasticsearch specialist");
		expect(prompt).not.toContain("Skill:");
	});
});

describe("tool-prompt", () => {
	test("resolves template with full context", () => {
		const agent = loadAgent(AGENTS_DIR);
		const elasticTool = agent.tools.find((t) => t.name === "elastic-search-logs") as ToolDefinition;
		const resolved = buildToolPrompt(elasticTool, {
			datasources: ["elastic", "kafka", "couchbase"],
			complianceTier: "medium",
		});
		expect(resolved).toContain("elastic, kafka, couchbase");
		expect(resolved).toContain("medium");
	});

	test("removes conditional blocks when context is missing", () => {
		const agent = loadAgent(AGENTS_DIR);
		const elasticTool = agent.tools.find((t) => t.name === "elastic-search-logs") as ToolDefinition;
		const resolved = buildToolPrompt(elasticTool, {});
		expect(resolved).not.toContain("{{");
		expect(resolved).not.toContain("}}");
	});

	test("falls back to static description when no template", () => {
		const result = buildToolPrompt({ name: "test", description: "static desc" } as ToolDefinition, {});
		expect(result).toBe("static desc");
	});

	test("buildAllToolPrompts returns map for all tools", () => {
		const agent = loadAgent(AGENTS_DIR);
		const prompts = buildAllToolPrompts(agent);
		expect(prompts.size).toBe(6);
		expect(prompts.has("elastic-search-logs")).toBe(true);
	});
});

describe("related-tools", () => {
	test("builds related tools map from agent", () => {
		const agent = loadAgent(AGENTS_DIR);
		const map = buildRelatedToolsMap(agent);
		expect(map.size).toBeGreaterThan(0);
		const elasticRelated = map.get("elastic-search-logs");
		expect(elasticRelated).toBeDefined();
		expect(elasticRelated?.length).toBeGreaterThan(0);
	});

	test("withRelatedTools appends hints to response", () => {
		const map = new Map([["tool1", ["hint1", "hint2"]]]);
		const response = { data: "test" };
		const enriched = withRelatedTools(response, "tool1", map);
		expect(enriched.relatedTools).toEqual(["hint1", "hint2"]);
		expect(enriched.data).toBe("test");
	});

	test("withRelatedTools returns original when no hints", () => {
		const map = new Map<string, string[]>();
		const response = { data: "test" };
		const result = withRelatedTools(response, "unknown", map);
		expect(result).toEqual({ data: "test" });
		expect("relatedTools" in result).toBe(false);
	});
});

describe("tool-mapping", () => {
	test("matchesPattern handles exact match", () => {
		expect(matchesPattern("elasticsearch_search", "elasticsearch_search")).toBe(true);
		expect(matchesPattern("elasticsearch_search", "kafka_list_topics")).toBe(false);
	});

	test("matchesPattern handles glob suffix", () => {
		expect(matchesPattern("elasticsearch_*", "elasticsearch_search")).toBe(true);
		expect(matchesPattern("elasticsearch_*", "elasticsearch_list_indices")).toBe(true);
		expect(matchesPattern("elasticsearch_*", "kafka_list_topics")).toBe(false);
	});

	test("matchesPattern handles glob prefix", () => {
		expect(matchesPattern("*_search", "elasticsearch_search")).toBe(true);
		expect(matchesPattern("*_search", "global_search")).toBe(true);
		expect(matchesPattern("*_search", "elasticsearch_list")).toBe(false);
	});

	test("resolveMapping resolves exact names and globs", () => {
		const mcpTools = ["elasticsearch_search", "elasticsearch_list_indices", "kafka_list_topics"];
		const result = resolveMapping(["elasticsearch_*"], mcpTools);
		expect(result.matched).toContain("elasticsearch_search");
		expect(result.matched).toContain("elasticsearch_list_indices");
		expect(result.matched).not.toContain("kafka_list_topics");
		expect(result.unmatchedPatterns).toEqual([]);
	});

	test("resolveMapping reports unmatched patterns", () => {
		const result = resolveMapping(["nonexistent_*"], ["elasticsearch_search"]);
		expect(result.matched).toEqual([]);
		expect(result.unmatchedPatterns).toEqual(["nonexistent_*"]);
	});

	test("buildFacadeMap creates bidirectional lookup from real agent", () => {
		const agent = loadAgent(AGENTS_DIR);
		const mockMcpTools = [
			"elasticsearch_search",
			"elasticsearch_list_indices",
			"kafka_list_topics",
			"kafka_describe_topic",
			"capella_get_system_vitals",
			"capella_get_fatal_requests",
			"konnect_query_api_requests",
			"konnect_list_services",
		];
		const map = buildFacadeMap(agent.tools, mockMcpTools);

		expect(map.facadeToMcp.get("elastic-search-logs")).toContain("elasticsearch_search");
		expect(map.facadeToMcp.get("elastic-search-logs")).toContain("elasticsearch_list_indices");
		expect(map.facadeToMcp.get("kafka-introspect")).toContain("kafka_list_topics");
		expect(map.facadeToMcp.get("couchbase-cluster-health")).toContain("capella_get_system_vitals");
		expect(map.facadeToMcp.get("konnect-api-gateway")).toContain("konnect_query_api_requests");

		// Action tools without mapping get empty arrays
		expect(map.facadeToMcp.get("notify-slack")).toEqual([]);
		expect(map.facadeToMcp.get("create-ticket")).toEqual([]);

		// Reverse lookup
		expect(map.mcpToFacade.get("elasticsearch_search")).toBe("elastic-search-logs");
		expect(map.mcpToFacade.get("kafka_list_topics")).toBe("kafka-introspect");
	});

	test("getUncoveredTools reports tools not in any facade", () => {
		const agent = loadAgent(AGENTS_DIR);
		const mockMcpTools = ["elasticsearch_search", "some_orphan_tool"];
		const map = buildFacadeMap(agent.tools, mockMcpTools);
		const uncovered = getUncoveredTools(map, mockMcpTools);
		expect(uncovered).toContain("some_orphan_tool");
		expect(uncovered).not.toContain("elasticsearch_search");
	});

	test("tool_mapping is loaded from YAML for mapped tools", () => {
		const agent = loadAgent(AGENTS_DIR);
		const elasticTool = agent.tools.find((t) => t.name === "elastic-search-logs") as ToolDefinition;
		expect(elasticTool.tool_mapping).toBeDefined();
		expect(elasticTool.tool_mapping?.mcp_server).toBe("elastic");
		expect(elasticTool.tool_mapping?.mcp_patterns).toContain("elasticsearch_*");
	});

	test("tool_mapping is undefined for action tools", () => {
		const agent = loadAgent(AGENTS_DIR);
		const slackTool = agent.tools.find((t) => t.name === "notify-slack") as ToolDefinition;
		expect(slackTool.tool_mapping).toBeUndefined();
	});
});

describe("tool-schema", () => {
	test("validates with mapping-resolved MCP tool names", () => {
		const agent = loadAgent(AGENTS_DIR);
		const mcpNames = [
			"elasticsearch_search",
			"kafka_list_topics",
			"capella_get_system_vitals",
			"konnect_query_api_requests",
		];
		const result = validateToolSchemas(agent.tools, mcpNames);
		expect(result.valid).toBe(true);
		expect(result.missing).toEqual([]);
		expect(result.unmappedFacades).toContain("notify-slack");
		expect(result.unmappedFacades).toContain("create-ticket");
	});

	test("reports facades with zero MCP matches as missing", () => {
		const agent = loadAgent(AGENTS_DIR);
		// No MCP tools match any patterns
		const result = validateToolSchemas(agent.tools, ["some_unrelated_tool"]);
		expect(result.valid).toBe(false);
		expect(result.missing.length).toBe(4);
	});

	test("backward compatibility: direct name comparison without tool_mapping", () => {
		const toolsWithoutMapping = [
			{ name: "tool-a", description: "A" },
			{ name: "tool-b", description: "B" },
		];
		const result = validateToolSchemas(toolsWithoutMapping as ToolDefinition[], ["tool-a", "tool-b"]);
		expect(result.valid).toBe(true);
		expect(result.missing).toEqual([]);
		expect(result.extra).toEqual([]);
	});

	test("backward compatibility: detects missing in direct mode", () => {
		const toolsWithoutMapping = [
			{ name: "tool-a", description: "A" },
			{ name: "tool-b", description: "B" },
		];
		const result = validateToolSchemas(toolsWithoutMapping as ToolDefinition[], ["tool-a"]);
		expect(result.valid).toBe(false);
		expect(result.missing).toContain("tool-b");
	});
});

describe("compliance", () => {
	test("converts compliance config to LangSmith metadata", () => {
		const agent = loadAgent(AGENTS_DIR);
		const metadata = complianceToMetadata(agent.manifest.compliance);
		expect(metadata.compliance_risk_tier).toBe("medium");
		expect(metadata.compliance_audit_logging).toBe("true");
		expect(metadata.compliance_retention_period).toBe("1y");
		expect(metadata.compliance_immutable_logs).toBe("true");
		expect(metadata.compliance_hitl).toBe("conditional");
		expect(metadata.compliance_pii_handling).toBe("redact");
	});

	test("returns empty for undefined compliance", () => {
		expect(complianceToMetadata(undefined)).toEqual({});
	});

	test("requiresApproval returns true for always HITL", () => {
		expect(requiresApproval("any-tool", { risk_tier: "high", supervision: { human_in_the_loop: "always" } })).toBe(
			true,
		);
	});

	test("requiresApproval returns false for none HITL", () => {
		expect(requiresApproval("any-tool", { risk_tier: "low", supervision: { human_in_the_loop: "none" } })).toBe(false);
	});

	test("requiresApproval checks escalation triggers for conditional", () => {
		const compliance = {
			risk_tier: "medium" as const,
			supervision: {
				human_in_the_loop: "conditional" as const,
				escalation_triggers: [{ action_type: "mutate_production" }],
			},
		};
		expect(requiresApproval("mutate_production_db", compliance)).toBe(true);
		expect(requiresApproval("read_logs", compliance)).toBe(false);
	});
});
