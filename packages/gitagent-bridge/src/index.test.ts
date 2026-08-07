// gitagent-bridge/src/index.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	buildFacadeMap,
	buildSystemPrompt,
	buildSystemPromptParts,
	buildToolPrompt,
	complianceToMetadata,
	getRecursionLimit,
	getUncoveredTools,
	isRunbookCategory,
	loadAgent,
	RunbookFrontmatterSchema,
	RunbookTriggersSchema,
	requiresApproval,
	resolveBedrockConfig,
	resolveMapping,
	type ToolDefinition,
	validateToolSchemas,
	withRelatedTools,
} from "./index.ts";
import { type LoadedAgent, parseRunbookFrontmatter, parseSkillFrontmatter } from "./manifest-loader.ts";
// SIO-1046: matchesPattern is no longer part of the package's public surface (kept module-level for
// its internal caller in tool-mapping.ts); its behavior tests import the module directly.
import { matchesPattern } from "./tool-mapping.ts";

const AGENTS_DIR = join(import.meta.dir, "../../../agents/incident-analyzer");
const ELASTIC_IAC_DIR = join(import.meta.dir, "../../../agents/elastic-iac");

describe("manifest-loader", () => {
	test("loads root agent with all fields", () => {
		const agent = loadAgent(AGENTS_DIR);
		expect(agent.manifest.name).toBe("incident-analyzer");
		expect(agent.manifest.version).toBe("0.1.0");
		expect(agent.manifest.model?.preferred).toBe("claude-sonnet-5");
		expect(agent.manifest.delegation?.mode).toBe("router");
		expect(agent.manifest.compliance?.risk_tier).toBe("medium");
	});

	test("loads SOUL.md and RULES.md", () => {
		const agent = loadAgent(AGENTS_DIR);
		expect(agent.soul).toContain("Core Identity");
		expect(agent.rules).toContain("Must Always");
	});

	test("loads all 9 tool definitions", () => {
		const agent = loadAgent(AGENTS_DIR);
		// SIO-863: aws-introspect added so the AWS runbooks' aws_* citations resolve.
		expect(agent.tools.length).toBe(9);
		const toolNames = agent.tools.map((t) => t.name);
		expect(toolNames).toContain("elastic-search-logs");
		expect(toolNames).toContain("kafka-introspect");
		expect(toolNames).toContain("couchbase-cluster-health");
		expect(toolNames).toContain("konnect-api-gateway");
		expect(toolNames).toContain("gitlab-api");
		expect(toolNames).toContain("atlassian-api");
		expect(toolNames).toContain("notify-slack");
		expect(toolNames).toContain("create-ticket");
		expect(toolNames).toContain("aws-introspect");
	});

	test("loads all 7 skills", () => {
		const agent = loadAgent(AGENTS_DIR);
		// SIO-862: 3 original incident skills + the 3 wiki-* skills (wiki-ingest/lint/query).
		// SIO-1347 added incident-postmortem.
		expect(agent.skills.size).toBe(7);
		expect(agent.skills.has("normalize-incident")).toBe(true);
		expect(agent.skills.has("aggregate-findings")).toBe(true);
		expect(agent.skills.has("propose-mitigation")).toBe(true);
		expect(agent.skills.has("incident-postmortem")).toBe(true);
		expect(agent.skills.has("wiki-ingest")).toBe(true);
		expect(agent.skills.has("wiki-lint")).toBe(true);
		expect(agent.skills.has("wiki-query")).toBe(true);
	});

	test("loads all 7 sub-agents recursively", () => {
		const agent = loadAgent(AGENTS_DIR);
		expect(agent.subAgents.size).toBe(7);
		expect(agent.subAgents.has("elastic-agent")).toBe(true);
		expect(agent.subAgents.has("kafka-agent")).toBe(true);
		expect(agent.subAgents.has("capella-agent")).toBe(true);
		expect(agent.subAgents.has("konnect-agent")).toBe(true);
		expect(agent.subAgents.has("gitlab-agent")).toBe(true);
		// SIO-1229: these two dispatch by name but were undeclared in agent.yaml,
		// so they were absent here and silently ran on the orchestrator prompt.
		expect(agent.subAgents.has("atlassian-agent")).toBe(true);
		expect(agent.subAgents.has("aws-agent")).toBe(true);

		const elastic = agent.subAgents.get("elastic-agent") as ReturnType<typeof loadAgent>;
		expect(elastic.manifest.name).toBe("elastic-agent");
		// SIO-1404: sub-agents restored to claude-sonnet-4-6 (the SIO-1380 eval
		// baseline showed it beats the SIO-1367 claude-haiku-4-5 swap).
		expect(elastic.manifest.model?.preferred).toBe("claude-sonnet-4-6");
		expect(elastic.soul).toContain("Elasticsearch specialist");
	});

	// SIO-1229: the regression this guards is NOT the count -- it is that every
	// sub-agent that EXISTS ON DISK is declared in agent.yaml and therefore gets its
	// OWN prompt. When a sub-agent is missing from `subAgents`, buildSubAgentPrompt
	// falls back to buildSystemPrompt(rootAgent): the agent still dispatches and still
	// runs, just silently wearing the orchestrator's identity instead of its SOUL.md.
	//
	// This MUST iterate the directory listing, not `agent.subAgents`. Iterating the
	// loaded map cannot observe an undeclared agent -- the very thing that goes wrong --
	// so it would pass vacuously. (Same trap as model-registry.test.ts's `if (!sub)
	// continue`, which silently skipped these two agents for months.)
	test("every sub-agent directory on disk is declared and gets its own prompt", () => {
		const agent = loadAgent(AGENTS_DIR);
		const rootPrompt = buildSystemPrompt(agent);

		const onDisk = readdirSync(join(AGENTS_DIR, "agents"), { withFileTypes: true })
			.filter((e) => e.isDirectory() && existsSync(join(AGENTS_DIR, "agents", e.name, "agent.yaml")))
			.map((e) => e.name);

		expect(onDisk.length).toBeGreaterThan(0);

		for (const name of onDisk) {
			const subAgent = agent.subAgents.get(name);
			expect(subAgent, `${name} exists on disk but is not declared in agent.yaml`).toBeDefined();
			if (!subAgent) continue;

			const prompt = buildSystemPrompt(subAgent);
			expect(prompt, `${name} received the orchestrator prompt`).not.toBe(rootPrompt);
			expect(prompt, `${name} prompt is missing its own SOUL.md`).toContain(subAgent.soul.trim());
			if (subAgent.rules.trim()) {
				expect(prompt, `${name} prompt is missing its own RULES.md`).toContain(subAgent.rules.trim());
			}
		}
	});

	// SIO-1281: local skills are a manifest ALLOWLIST, not a directory scan -- manifest-loader
	// iterates `manifest.skills` and existsSync-checks each, so a skill directory that is not
	// declared in agent.yaml is skipped with no error and no warning. 16 elastic-iac directories
	// drifted this way and never loaded; the content had been deleted from the playbook in the
	// same move, so the agent silently lost ~1,300 lines of knowledge it previously had.
	//
	// Same anti-vacuity rule as the sub-agent test above: this MUST iterate the directory
	// listing, not `agent.skills`. Iterating the loaded map cannot observe an undeclared skill --
	// the very thing that goes wrong -- so it would pass vacuously.
	//
	// Both agent.yaml dialects normalize through toIdList (plain strings for incident-analyzer,
	// `- id:` objects for elastic-iac), so read the LOADED manifest rather than parsing YAML.
	test("every skill directory on disk is declared in agent.yaml", () => {
		for (const agentDir of [AGENTS_DIR, ELASTIC_IAC_DIR]) {
			const agent = loadAgent(agentDir);
			const skillsDir = join(agentDir, "skills");
			if (!existsSync(skillsDir)) continue;

			const onDisk = readdirSync(skillsDir, { withFileTypes: true })
				.filter((e) => e.isDirectory() && existsSync(join(skillsDir, e.name, "SKILL.md")))
				.map((e) => e.name);

			expect(onDisk.length).toBeGreaterThan(0);

			for (const name of onDisk) {
				expect(
					agent.skills.has(name),
					`${agentDir}: skills/${name}/ exists on disk but is not declared in agent.yaml, so it never loads`,
				).toBe(true);
			}

			// The inverse: a declared skill whose directory is missing loads as nothing.
			for (const name of agent.manifest.skills ?? []) {
				expect(
					existsSync(join(skillsDir, name, "SKILL.md")),
					`${agentDir}: agent.yaml declares skill "${name}" but skills/${name}/SKILL.md does not exist`,
				).toBe(true);
			}
		}
	});
});

describe("model-factory", () => {
	test("resolves claude-sonnet-4-6 to Bedrock ID", () => {
		const config = resolveBedrockConfig({ preferred: "claude-sonnet-4-6" });
		expect(config.model).toBe("eu.anthropic.claude-sonnet-4-6");
		expect(config.region).toMatch(/^eu-/); // AWS_REGION if set, else the eu-central-1 default
	});

	test("resolves claude-haiku-4-5 to Bedrock ID", () => {
		const config = resolveBedrockConfig({ preferred: "claude-haiku-4-5" });
		expect(config.model).toBe("eu.anthropic.claude-haiku-4-5-20251001-v1:0");
	});

	// SIO-872: must include the -v1 inference-profile suffix; the bare ...-4-6 is invalid.
	test("resolves claude-opus-4-6 to the -v1 inference profile", () => {
		const config = resolveBedrockConfig({ preferred: "claude-opus-4-6" });
		expect(config.model).toBe("eu.anthropic.claude-opus-4-6-v1");
	});

	// SIO-1213: Sonnet 5 / Opus 4.8 use the plain dateless EU cross-region id (no -v1 suffix).
	test("resolves claude-sonnet-5 to Bedrock ID", () => {
		const config = resolveBedrockConfig({ preferred: "claude-sonnet-5" });
		expect(config.model).toBe("eu.anthropic.claude-sonnet-5");
	});

	test("resolves claude-opus-4-8 to Bedrock ID", () => {
		const config = resolveBedrockConfig({ preferred: "claude-opus-4-8" });
		expect(config.model).toBe("eu.anthropic.claude-opus-4-8");
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

	test("handles sub-agent with an agent-local skill", () => {
		const agent = loadAgent(AGENTS_DIR);
		const elastic = agent.subAgents.get("elastic-agent") as ReturnType<typeof loadAgent>;
		// SIO-1215: the elastic sub-agent now declares one agent-local skill
		// (ml-anomaly-investigation) -- previously it had none.
		expect(elastic.skills.size).toBe(1);
		const prompt = buildSystemPrompt(elastic);
		expect(prompt).toContain("Elasticsearch specialist");
		expect(prompt).toContain("Skill: ml-anomaly-investigation");
		// SIO-844: monorepo-shared skills now flow into sub-agents, so the only
		// OTHER "Skill:" heading present is the shared cite-sources skill, not an
		// orchestrator-level one.
		expect(prompt).not.toContain("Skill: normalize-incident");
	});

	test("includes knowledge base in system prompt", () => {
		const agent = loadAgent(AGENTS_DIR);
		const prompt = buildSystemPrompt(agent);
		expect(prompt).toContain("## Knowledge Base");
		expect(prompt).toContain("### Runbooks");
		expect(prompt).toContain("high-error-rate.md");
	});

	test("sub-agent prompt does not include knowledge", () => {
		const agent = loadAgent(AGENTS_DIR);
		const elastic = agent.subAgents.get("elastic-agent") as ReturnType<typeof loadAgent>;
		const prompt = buildSystemPrompt(elastic);
		expect(prompt).not.toContain("## Knowledge Base");
	});

	// SIO-1040: the stable/volatile split must reproduce buildSystemPrompt byte-for-byte.
	describe("buildSystemPromptParts byte-identity (SIO-1040)", () => {
		test("root agent: core + knowledge === buildSystemPrompt (with knowledge)", () => {
			const agent = loadAgent(AGENTS_DIR);
			const parts = buildSystemPromptParts(agent);
			expect(parts.core + parts.knowledge).toBe(buildSystemPrompt(agent));
			// knowledge is the ONLY part carrying the knowledge base; core must not.
			expect(parts.knowledge).toContain("## Knowledge Base");
			expect(parts.core).not.toContain("## Knowledge Base");
			// knowledge carries the leading separator so concatenation is lossless.
			expect(parts.knowledge.startsWith("\n\n---\n\n")).toBe(true);
		});

		test("sub-agent with no knowledge: knowledge === '' and core === full prompt", () => {
			const agent = loadAgent(AGENTS_DIR);
			const elastic = agent.subAgents.get("elastic-agent") as ReturnType<typeof loadAgent>;
			const parts = buildSystemPromptParts(elastic);
			expect(parts.knowledge).toBe("");
			expect(parts.core).toBe(buildSystemPrompt(elastic));
			expect(parts.core + parts.knowledge).toBe(buildSystemPrompt(elastic));
		});

		test("filtered activeSkills: byte-identity preserved", () => {
			const agent = loadAgent(AGENTS_DIR);
			const parts = buildSystemPromptParts(agent, ["normalize-incident"]);
			expect(parts.core + parts.knowledge).toBe(buildSystemPrompt(agent, ["normalize-incident"]));
		});
	});
});

// SIO-1014: SKILL.md frontmatter -> typed skillMeta + a Skills catalog in the prompt.
describe("skill frontmatter (SIO-1014)", () => {
	test("skillMeta is total over skills (name + description everywhere since SIO-1347)", () => {
		const agent = loadAgent(AGENTS_DIR);
		// SIO-1347: every incident-analyzer skill now carries agentskills.io spec
		// frontmatter, so each meta record has the directory-matching name AND a
		// non-empty description (enforced by skill-spec-compliance.test.ts).
		expect(agent.skillMeta.size).toBe(agent.skills.size);
		for (const name of agent.skills.keys()) {
			const meta = agent.skillMeta.get(name);
			expect(meta).toBeDefined();
			expect(meta?.name).toBe(name);
			expect(meta?.description).toBeTruthy();
		}
	});

	// The markdown-only degrade path is still supported at runtime (tolerant loader)
	// even though no in-repo skill uses it anymore -- pin it with a synthetic file.
	test("a markdown-only skill still degrades to a minimal { name } record", () => {
		expect(parseSkillFrontmatter("bare-skill", "# Skill: Bare\n\nNo frontmatter.\n")).toEqual({ name: "bare-skill" });
	});

	test("elastic-iac skills parse name + description from frontmatter", () => {
		const agent = loadAgent(ELASTIC_IAC_DIR);
		const resize = agent.skillMeta.get("resize-tier");
		expect(resize).toBeDefined();
		expect(resize?.name).toBe("resize-tier");
		expect(resize?.description).toContain("Resize a hot/warm/cold");
		// inputs/outputs are carried opaquely
		expect(resize?.inputs).toBeDefined();
		expect(resize?.outputs).toBeDefined();
	});

	test("buildSystemPrompt emits a Skills catalog for skills with descriptions", () => {
		const agent = loadAgent(ELASTIC_IAC_DIR);
		const prompt = buildSystemPrompt(agent);
		expect(prompt).toContain("## Skills");
		expect(prompt).toContain("**resize-tier**: Resize a hot/warm/cold");
		// the full body still renders below the catalog
		expect(prompt).toContain("Skill: resize-tier");
	});

	test("incident-analyzer catalog lists every skill now that all carry descriptions", () => {
		const agent = loadAgent(AGENTS_DIR);
		// SIO-1347 inverted the old expectation: the locals AND the shared
		// cite-sources skill all have descriptions, so the catalog section exists
		// and covers the full set -- assert every loaded skill, local and shared,
		// so a future description regression on any one of them fails here.
		const prompt = buildSystemPrompt(agent);
		expect(prompt).toContain("## Skills\n");
		const allNames = [...agent.skills.keys(), ...agent.sharedSkills.keys()];
		expect(allNames.length).toBeGreaterThan(0);
		for (const name of allNames) {
			expect(prompt).toContain(`**${name}**:`);
		}
	});

	test("no Skills catalog when no active skill has a description", () => {
		const agent: LoadedAgent = {
			manifest: { name: "t", version: "0.1.0", description: "t" },
			soul: "",
			rules: "",
			duties: "",
			tools: [],
			skills: new Map([["bare-skill", "# Skill: Bare\n\nBody only.\n"]]),
			skillMeta: new Map([["bare-skill", { name: "bare-skill" }]]),
			subAgents: new Map(),
			knowledge: [],
			workflows: new Map(),
			sharedSkills: new Map(),
			sharedSkillMeta: new Map(),
		};
		const prompt = buildSystemPrompt(agent);
		expect(prompt).not.toContain("## Skills\n");
	});

	test("catalog respects the activeSkills filter", () => {
		const agent = loadAgent(ELASTIC_IAC_DIR);
		const prompt = buildSystemPrompt(agent, ["resize-tier"]);
		expect(prompt).toContain("**resize-tier**:");
		expect(prompt).not.toContain("**add-ilm-policy**:");
	});

	// SIO-1014 regression (CodeRabbit): a shared-only skill named in activeSkills
	// must still be catalogued. The local pass must NOT pre-mark it as seen, or the
	// shared pass drops its description while the body still renders below.
	test("catalog includes a shared-only skill when it is the only active skill", () => {
		const agent: LoadedAgent = {
			manifest: { name: "t", version: "0.1.0", description: "t" },
			soul: "",
			rules: "",
			duties: "",
			tools: [],
			skills: new Map([["local-skill", "---\nname: local-skill\ndescription: Local one.\n---\n# Local body"]]),
			skillMeta: new Map([["local-skill", { name: "local-skill", description: "Local one." }]]),
			subAgents: new Map(),
			knowledge: [],
			workflows: new Map(),
			sharedSkills: new Map([
				["shared-skill", "---\nname: shared-skill\ndescription: Shared one.\n---\n# Shared body"],
			]),
			sharedSkillMeta: new Map([["shared-skill", { name: "shared-skill", description: "Shared one." }]]),
		};
		const prompt = buildSystemPrompt(agent, ["shared-skill"]);
		// catalogued
		expect(prompt).toContain("**shared-skill**: Shared one.");
		// body still renders
		expect(prompt).toContain("Skill: shared-skill");
		// inactive local skill is omitted from both catalog and bodies
		expect(prompt).not.toContain("**local-skill**:");
		expect(prompt).not.toContain("Skill: local-skill");
	});
});

describe("parseSkillFrontmatter (SIO-1014)", () => {
	test("no frontmatter -> minimal record (name only)", () => {
		const meta = parseSkillFrontmatter("my-skill", "# Skill: My Skill\n\nBody.");
		expect(meta).toEqual({ name: "my-skill" });
	});

	test("parses name/description/inputs/outputs", () => {
		const content = [
			"---",
			"name: resize-tier",
			"description: Resize a tier.",
			"inputs:",
			"  cluster: { type: string, required: true }",
			"outputs:",
			"  mr_url: { type: string }",
			"---",
			"# Body",
		].join("\n");
		const meta = parseSkillFrontmatter("resize-tier", content);
		expect(meta.name).toBe("resize-tier");
		expect(meta.description).toBe("Resize a tier.");
		expect(meta.inputs).toBeDefined();
		expect(meta.outputs).toBeDefined();
	});

	test("falls back to the dir name when `name` is omitted", () => {
		const meta = parseSkillFrontmatter("dir-name", "---\ndescription: d\n---\n# Body");
		expect(meta.name).toBe("dir-name");
		expect(meta.description).toBe("d");
	});

	test("missing closing delimiter -> minimal record (no throw)", () => {
		const meta = parseSkillFrontmatter("broken", "---\nname: broken\n# Body with no close");
		expect(meta).toEqual({ name: "broken" });
	});

	test("malformed YAML -> minimal record (no throw)", () => {
		const meta = parseSkillFrontmatter("bad", "---\ninputs: { cluster: [unterminated\n---\n# Body");
		expect(meta).toEqual({ name: "bad" });
	});

	test("optional learning fields validate when present", () => {
		const content = [
			"---",
			"name: learned-skill",
			"description: d",
			"confidence: 0.5",
			"usage_count: 0",
			"learned_from: thread:abc",
			"---",
			"# Body",
		].join("\n");
		const meta = parseSkillFrontmatter("learned-skill", content);
		expect(meta.confidence).toBe(0.5);
		expect(meta.usage_count).toBe(0);
		expect(meta.learned_from).toBe("thread:abc");
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
});

describe("related-tools", () => {
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
			"gitlab_search",
			"findLinkedIncidents",
			"aws_list_estates", // SIO-863: resolves the aws-introspect facade
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
		// SIO-863: 7 mapped facades now (elastic, kafka, couchbase, konnect, gitlab,
		// atlassian, aws-introspect); notify-slack + create-ticket are unmapped.
		expect(result.missing.length).toBe(7);
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

describe("knowledge-loader", () => {
	test("loads knowledge entries from agent directory", () => {
		const agent = loadAgent(AGENTS_DIR);
		expect(agent.knowledge).toBeDefined();
		expect(Array.isArray(agent.knowledge)).toBe(true);
	});

	test("loads runbook entries with correct category", () => {
		const agent = loadAgent(AGENTS_DIR);
		const runbooks = agent.knowledge.filter((k) => isRunbookCategory(k.category));
		expect(runbooks.length).toBeGreaterThanOrEqual(1);
		for (const entry of runbooks) {
			expect(entry.filename).toMatch(/\.md$/);
			expect(entry.content.length).toBeGreaterThan(0);
		}
	});

	test("loads systems-map entries", () => {
		const agent = loadAgent(AGENTS_DIR);
		const systemsMap = agent.knowledge.filter((k) => k.category === "systems-map");
		expect(systemsMap.length).toBeGreaterThanOrEqual(1);
	});

	test("loads slo-policies entries", () => {
		const agent = loadAgent(AGENTS_DIR);
		const slo = agent.knowledge.filter((k) => k.category === "slo-policies");
		expect(slo.length).toBeGreaterThanOrEqual(1);
	});

	test("skips .gitkeep files", () => {
		const agent = loadAgent(AGENTS_DIR);
		const gitkeeps = agent.knowledge.filter((k) => k.filename === ".gitkeep");
		expect(gitkeeps.length).toBe(0);
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

// SIO-640: runbook_selection schema + load-time validation
import { KnowledgeIndexSchema } from "./types.ts";

describe("KnowledgeIndexSchema: runbook_selection", () => {
	test("accepts config with all four severity keys", () => {
		const config = {
			name: "test",
			description: "test",
			version: "0.1.0",
			categories: { runbooks: { path: "runbooks/", description: "test" } },
			runbook_selection: {
				fallback_by_severity: {
					critical: ["a.md", "b.md"],
					high: ["a.md"],
					medium: [],
					low: [],
				},
			},
		};
		expect(() => KnowledgeIndexSchema.parse(config)).not.toThrow();
	});

	test("rejects config missing a severity key", () => {
		const config = {
			name: "test",
			description: "test",
			version: "0.1.0",
			categories: { runbooks: { path: "runbooks/", description: "test" } },
			runbook_selection: {
				fallback_by_severity: {
					critical: [],
					high: [],
					medium: [],
					// low missing
				},
			},
		};
		expect(() => KnowledgeIndexSchema.parse(config)).toThrow();
	});

	test("accepts config with runbook_selection absent", () => {
		const config = {
			name: "test",
			description: "test",
			version: "0.1.0",
			categories: { runbooks: { path: "runbooks/", description: "test" } },
		};
		expect(() => KnowledgeIndexSchema.parse(config)).not.toThrow();
	});

	// SIO-1302: always_select is optional -- absent (older configs) parses unchanged.
	test("accepts config with always_select present", () => {
		const config = {
			name: "test",
			description: "test",
			version: "0.1.0",
			categories: { runbooks: { path: "runbooks/", description: "test" } },
			runbook_selection: {
				fallback_by_severity: { critical: [], high: [], medium: [], low: [] },
				always_select: ["code-change-correlation.md"],
			},
		};
		const parsed = KnowledgeIndexSchema.parse(config);
		expect(parsed.runbook_selection?.always_select).toEqual(["code-change-correlation.md"]);
	});

	test("accepts config with always_select absent (backward compatible)", () => {
		const config = {
			name: "test",
			description: "test",
			version: "0.1.0",
			categories: { runbooks: { path: "runbooks/", description: "test" } },
			runbook_selection: {
				fallback_by_severity: { critical: [], high: [], medium: [], low: [] },
			},
		};
		const parsed = KnowledgeIndexSchema.parse(config);
		expect(parsed.runbook_selection?.always_select).toBeUndefined();
	});
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

describe("loadAgent: runbook_selection filename validation", () => {
	function makeTestAgent(indexYaml: string, runbookFiles: Record<string, string> = {}): string {
		const dir = mkdtempSync(join(tmpdir(), "gitagent-test-"));
		mkdirSync(join(dir, "knowledge", "runbooks"), { recursive: true });
		writeFileSync(
			join(dir, "agent.yaml"),
			`spec_version: "0.1.0"
name: test
version: 0.1.0
description: test
model:
  preferred: claude-sonnet-4-6
  constraints: { temperature: 0.2, max_tokens: 1024 }
runtime: { max_turns: 10, timeout: 60 }
compliance:
  risk_tier: low
  supervision: { human_in_the_loop: conditional, kill_switch: false }
  recordkeeping: { audit_logging: false }
  data_governance: { pii_handling: allow, data_classification: internal }
`,
		);
		writeFileSync(join(dir, "knowledge", "index.yaml"), indexYaml);
		for (const [name, content] of Object.entries(runbookFiles)) {
			writeFileSync(join(dir, "knowledge", "runbooks", name), content);
		}
		return dir;
	}

	test("accepts config where every filename exists", () => {
		const dir = makeTestAgent(
			`name: test
description: test
version: 0.1.0
categories:
  runbooks: { path: runbooks/, description: test }
runbook_selection:
  fallback_by_severity:
    critical: ["a.md"]
    high: []
    medium: []
    low: []
`,
			{ "a.md": "# A\n\nContent" },
		);
		expect(() => loadAgent(dir)).not.toThrow();
		rmSync(dir, { recursive: true });
	});

	test("rejects config referencing nonexistent filename", () => {
		const dir = makeTestAgent(
			`name: test
description: test
version: 0.1.0
categories:
  runbooks: { path: runbooks/, description: test }
runbook_selection:
  fallback_by_severity:
    critical: ["missing.md"]
    high: []
    medium: []
    low: []
`,
			{ "a.md": "# A\n\nContent" },
		);
		expect(() => loadAgent(dir)).toThrow(/missing\.md/);
		rmSync(dir, { recursive: true });
	});

	// SIO-1302: always_select gets the same existence check as fallback_by_severity.
	test("accepts always_select referencing an existing filename", () => {
		const dir = makeTestAgent(
			`name: test
description: test
version: 0.1.0
categories:
  runbooks: { path: runbooks/, description: test }
runbook_selection:
  fallback_by_severity:
    critical: []
    high: []
    medium: []
    low: []
  always_select: ["a.md"]
`,
			{ "a.md": "# A\n\nContent" },
		);
		expect(() => loadAgent(dir)).not.toThrow();
		rmSync(dir, { recursive: true });
	});

	test("rejects always_select referencing a nonexistent filename", () => {
		const dir = makeTestAgent(
			`name: test
description: test
version: 0.1.0
categories:
  runbooks: { path: runbooks/, description: test }
runbook_selection:
  fallback_by_severity:
    critical: []
    high: []
    medium: []
    low: []
  always_select: ["missing.md"]
`,
			{ "a.md": "# A\n\nContent" },
		);
		expect(() => loadAgent(dir)).toThrow(/always_select.*missing\.md/);
		rmSync(dir, { recursive: true });
	});
});

describe("RunbookTriggersSchema", () => {
	test("accepts all three axes + match combinator", () => {
		const input = {
			severity: ["critical", "high"],
			services: ["kafka", "consumer"],
			metrics: ["lag"],
			match: "any",
		};
		expect(() => RunbookTriggersSchema.parse(input)).not.toThrow();
	});

	test("accepts empty object (all axes undefined)", () => {
		expect(() => RunbookTriggersSchema.parse({})).not.toThrow();
	});

	test("rejects invalid severity value", () => {
		const input = { severity: ["criticall"] };
		expect(() => RunbookTriggersSchema.parse(input)).toThrow();
	});

	test("rejects invalid match value", () => {
		const input = { match: "either" };
		expect(() => RunbookTriggersSchema.parse(input)).toThrow();
	});

	test("rejects unknown key (strict mode)", () => {
		const input = { metric: ["lag"] }; // typo: metric vs metrics
		expect(() => RunbookTriggersSchema.parse(input)).toThrow();
	});
});

describe("RunbookFrontmatterSchema", () => {
	test("accepts object with triggers key", () => {
		const input = { triggers: { severity: ["critical"] } };
		expect(() => RunbookFrontmatterSchema.parse(input)).not.toThrow();
	});

	// SIO-1282: these three previously asserted the `.strict()` + required-`triggers`
	// contract. Widening for OKF v0.2 deliberately inverts the first two -- a runbook may
	// now omit `triggers` entirely (OKF concepts need not declare it, and elastic-iac's 6
	// runbooks already declare none), and unknown TOP-LEVEL keys are tolerated because OKF
	// §11 requires consumers not to reject them.
	test("accepts object WITHOUT triggers (OKF concepts need not declare it)", () => {
		const input = { tags: ["kafka"] };
		expect(() => RunbookFrontmatterSchema.parse(input)).not.toThrow();
	});

	test("accepts triggers AND an unknown top-level key (OKF §11 tolerance)", () => {
		const input = { triggers: { severity: ["critical"] }, author: "dev" };
		expect(() => RunbookFrontmatterSchema.parse(input)).not.toThrow();
	});

	test("preserves unknown top-level keys rather than stripping them (OKF requires round-trip)", () => {
		const parsed = RunbookFrontmatterSchema.parse({ type: "Runbook", author: "dev" });
		expect((parsed as Record<string, unknown>).author).toBe("dev");
	});

	test("rejects undefined (empty YAML parse result)", () => {
		expect(() => RunbookFrontmatterSchema.parse(undefined)).toThrow();
	});

	// The guards that must SURVIVE the widening. The envelope got permissive; the fields
	// the selector and the authoring contract depend on did not.
	test("still rejects a malformed triggers value", () => {
		expect(() => RunbookFrontmatterSchema.parse({ triggers: { severity: ["nonsense"] } })).toThrow();
	});

	test("still rejects an unknown key INSIDE triggers (RunbookTriggersSchema stays .strict())", () => {
		expect(() => RunbookFrontmatterSchema.parse({ triggers: { severity: ["high"], bogus: 1 } })).toThrow();
	});

	test("rejects a bad status enum", () => {
		expect(() => RunbookFrontmatterSchema.parse({ type: "Runbook", status: "whatever" })).toThrow();
	});

	test("rejects a wrongly-typed tags field", () => {
		expect(() => RunbookFrontmatterSchema.parse({ type: "Runbook", tags: "not-an-array" })).toThrow();
	});

	// OKF v0.2 reserved shapes the migration will actually author.
	test("accepts the OKF reserved fields", () => {
		const input = {
			type: "Runbook",
			title: "MCP Tool Audit",
			description: "Audit MCP tool availability.",
			resource: "https://example.invalid/runbook",
			tags: ["mcp", "diagnostics"],
			status: "stable",
			stale_after: "2027-01-01",
		};
		expect(() => RunbookFrontmatterSchema.parse(input)).not.toThrow();
	});

	// §11: "consumers MUST treat a bare `verified` mapping as a one-element list". Both
	// shapes ride through `.passthrough()`; they are deliberately not typed until a
	// consumer reads them.
	test("accepts a bare verified mapping and a verified list (OKF §11)", () => {
		expect(() =>
			RunbookFrontmatterSchema.parse({ type: "Runbook", verified: { by: "human:simon", at: "2026-07-29" } }),
		).not.toThrow();
		expect(() =>
			RunbookFrontmatterSchema.parse({ type: "Runbook", verified: [{ by: "human:simon", at: "2026-07-29" }] }),
		).not.toThrow();
	});

	test("accepts generated and sources provenance blocks", () => {
		const input = {
			type: "Runbook",
			generated: { by: "human:simon", at: "2026-07-29" },
			sources: [{ resource: "https://example.invalid/x", usage_count: 3 }],
		};
		expect(() => RunbookFrontmatterSchema.parse(input)).not.toThrow();
	});

	test("type and triggers coexist -- triggers survives as a producer extension (SIO-640)", () => {
		const parsed = RunbookFrontmatterSchema.parse({
			type: "Runbook",
			status: "stable",
			triggers: { severity: ["high"], match: "any" },
		});
		expect(parsed.triggers).toEqual({ severity: ["high"], match: "any" });
	});
});

describe("parseRunbookFrontmatter", () => {
	test("1. no frontmatter", () => {
		const input = "# Runbook\nBody";
		const result = parseRunbookFrontmatter(input);
		expect(result.triggers).toBeUndefined();
		expect(result.body).toBe("# Runbook\nBody");
	});

	test("2. empty frontmatter block throws", () => {
		const input = "---\n---\n# Body";
		expect(() => parseRunbookFrontmatter(input)).toThrow();
	});

	test("2b. frontmatter with only match (no axes) parses", () => {
		const input = "---\ntriggers:\n  match: any\n---\n# Body";
		const result = parseRunbookFrontmatter(input);
		expect(result.triggers).toEqual({ match: "any" });
		expect(result.body).toBe("# Body");
	});

	test("3. severity only", () => {
		const input = "---\ntriggers:\n  severity: [critical]\n---\n# Body";
		const result = parseRunbookFrontmatter(input);
		expect(result.triggers).toEqual({ severity: ["critical"] });
		expect(result.body).toBe("# Body");
	});

	test("4. all three axes + match", () => {
		const input = [
			"---",
			"triggers:",
			"  severity: [critical, high]",
			"  services: [kafka]",
			"  metrics: [lag]",
			"  match: all",
			"---",
			"# Body",
		].join("\n");
		const result = parseRunbookFrontmatter(input);
		expect(result.triggers).toEqual({
			severity: ["critical", "high"],
			services: ["kafka"],
			metrics: ["lag"],
			match: "all",
		});
		expect(result.body).toBe("# Body");
	});

	test("5. frontmatter followed by paragraph", () => {
		const input = ["---", "triggers:", "  severity: [high]", "---", "", "# Body", "", "Paragraph."].join("\n");
		const result = parseRunbookFrontmatter(input);
		expect(result.triggers).toEqual({ severity: ["high"] });
		expect(result.body.trim()).toBe("# Body\n\nParagraph.");
	});

	test("6. unknown trigger key (typo: metric)", () => {
		const input = "---\ntriggers:\n  metric: [lag]\n---\n";
		expect(() => parseRunbookFrontmatter(input)).toThrow();
	});

	test("7. invalid severity value", () => {
		const input = "---\ntriggers:\n  severity: [criticall]\n---\n";
		expect(() => parseRunbookFrontmatter(input)).toThrow();
	});

	test("8. invalid match value", () => {
		const input = "---\ntriggers:\n  match: either\n---\n";
		expect(() => parseRunbookFrontmatter(input)).toThrow();
	});

	// SIO-1282: this previously asserted a throw. Frontmatter carrying only non-`triggers`
	// keys is exactly the OKF concept shape, so it must now parse -- with `triggers`
	// undefined, which narrowCatalogByTriggers already handles by keeping the runbook.
	test("9. non-triggers frontmatter keys now parse (OKF concept shape)", () => {
		const result = parseRunbookFrontmatter("---\ntags: [kafka]\n---\n# Body");
		expect(result.triggers).toBeUndefined();
		expect(result.body).toBe("# Body");
	});

	test("9b. a full OKF frontmatter block parses and keeps triggers", () => {
		const input = "---\ntype: Runbook\nstatus: stable\ntriggers:\n  severity: [high]\n---\n# Body";
		const result = parseRunbookFrontmatter(input);
		expect(result.triggers).toEqual({ severity: ["high"] });
		expect(result.body).toBe("# Body");
	});

	test("10. missing closing ---", () => {
		const input = "---\ntriggers:\n  severity: [high]\n# Body";
		expect(() => parseRunbookFrontmatter(input)).toThrow();
	});

	test("11. malformed YAML", () => {
		const input = "---\ntriggers: { severity: [critical\n---\n";
		expect(() => parseRunbookFrontmatter(input)).toThrow();
	});
});

describe("loadKnowledge: runbook frontmatter integration", () => {
	function makeTestAgent(runbookFiles: Record<string, string>): string {
		const dir = mkdtempSync(join(tmpdir(), "gitagent-trigger-test-"));
		mkdirSync(join(dir, "knowledge", "runbooks"), { recursive: true });
		writeFileSync(
			join(dir, "agent.yaml"),
			`spec_version: "0.1.0"
name: test
version: 0.1.0
description: test
model:
  preferred: claude-sonnet-4-6
  constraints: { temperature: 0.2, max_tokens: 1024 }
runtime: { max_turns: 10, timeout: 60 }
compliance:
  risk_tier: low
  supervision: { human_in_the_loop: conditional, kill_switch: false }
  recordkeeping: { audit_logging: false }
  data_governance: { pii_handling: allow, data_classification: internal }
`,
		);
		writeFileSync(
			join(dir, "knowledge", "index.yaml"),
			`name: test
description: test
version: 0.1.0
categories:
  runbooks: { path: runbooks/, description: test }
`,
		);
		for (const [name, content] of Object.entries(runbookFiles)) {
			writeFileSync(join(dir, "knowledge", "runbooks", name), content);
		}
		return dir;
	}

	test("runbook with valid frontmatter populates triggers and strips content", () => {
		const dir = makeTestAgent({
			"a.md": "---\ntriggers:\n  severity: [critical]\n---\n# Runbook A\n\nBody.",
		});
		const agent = loadAgent(dir);
		const runbookEntry = agent.knowledge.find((e) => e.filename === "a.md");
		expect(runbookEntry).toBeDefined();
		expect(runbookEntry?.triggers).toEqual({ severity: ["critical"] });
		expect(runbookEntry?.content).toBe("# Runbook A\n\nBody.");
		expect(runbookEntry?.content).not.toContain("---");
		expect(runbookEntry?.content).not.toContain("triggers:");
		rmSync(dir, { recursive: true });
	});

	test("runbook without frontmatter leaves triggers undefined", () => {
		const dir = makeTestAgent({
			"b.md": "# Runbook B\n\nBody with no frontmatter.",
		});
		const agent = loadAgent(dir);
		const runbookEntry = agent.knowledge.find((e) => e.filename === "b.md");
		expect(runbookEntry).toBeDefined();
		expect(runbookEntry?.triggers).toBeUndefined();
		expect(runbookEntry?.content).toBe("# Runbook B\n\nBody with no frontmatter.");
		rmSync(dir, { recursive: true });
	});

	test("runbook with invalid frontmatter throws with file path in error", () => {
		const dir = makeTestAgent({
			"broken.md": "---\ntriggers:\n  severity: [criticall]\n---\n# Body",
		});
		expect(() => loadAgent(dir)).toThrow(/broken\.md/);
		rmSync(dir, { recursive: true });
	});

	test("mixed runbooks (some with frontmatter, some without) all load correctly", () => {
		const dir = makeTestAgent({
			"with.md": "---\ntriggers:\n  services: [kafka]\n---\n# With",
			"without.md": "# Without frontmatter",
		});
		const agent = loadAgent(dir);
		const withEntry = agent.knowledge.find((e) => e.filename === "with.md");
		const withoutEntry = agent.knowledge.find((e) => e.filename === "without.md");
		expect(withEntry?.triggers).toEqual({ services: ["kafka"] });
		expect(withEntry?.content).toBe("# With");
		expect(withoutEntry?.triggers).toBeUndefined();
		expect(withoutEntry?.content).toBe("# Without frontmatter");
		rmSync(dir, { recursive: true });
	});
});
