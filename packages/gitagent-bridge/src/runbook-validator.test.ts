// gitagent-bridge/src/runbook-validator.test.ts
// SIO-641: Runbook tool-name binding validator. Walks every agent's runbooks,
// extracts tool name citations from prose and the "All Tools Used Are Read-Only"
// tail section, and fails bun test if any citation is not in the agent's
// action_tool_map union or if prose and tail disagree.

import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LoadedAgent, loadAgent, type ToolDefinition } from "./index.ts";

// ============================================================================
// Types
// ============================================================================

interface Citation {
	name: string;
	line: number;
	source: "prose" | "tail";
}

interface TailSectionResult {
	citations: Citation[];
	errors: string[];
}

interface ValidationReport {
	runbookPath: string;
	missing: Citation[];
	proseOnly: Citation[];
	tailOnly: Citation[];
	errors: string[];
}

interface AgentFixture {
	name: string;
	agentDir: string;
	agent: LoadedAgent;
	runbookPaths: string[];
}

interface SubAgentFixture {
	parentName: string;
	subAgentName: string;
	parentTools: ToolDefinition[];
	subAgent: LoadedAgent;
	runbookPaths: string[];
}

// ============================================================================
// Helpers (stubs - implemented in later tasks)
// ============================================================================

function extractProseCitations(content: string): Citation[] {
	const citations: Citation[] = [];
	const lines = content.split("\n");
	let inFence = false;

	// SIO-643: Skip leading YAML frontmatter block so its identifiers are not
	// mistaken for prose citations. The frontmatter is parsed by the loader
	// for runbooks; the validator should not re-interpret it.
	let startLine = 0;
	if (lines.length > 0 && (lines[0] ?? "").trim() === "---") {
		// Find the closing --- delimiter
		for (let i = 1; i < lines.length; i++) {
			if ((lines[i] ?? "").trim() === "---") {
				startLine = i + 1;
				break;
			}
		}
		// If we never found a closing delimiter, startLine stays 0 and we
		// walk the full content. A missing closing delimiter is a load-time
		// error (see parseRunbookFrontmatter) so reaching this branch here
		// means the validator is being run on a malformed file anyway.
	}

	for (let i = startLine; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const trimmed = line.trim();

		// Toggle fenced code block state
		if (trimmed.startsWith("```")) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;

		// Find all backtick-wrapped segments on this line
		const backtickRegex = /`([^`]+)`/g;
		let match: RegExpExecArray | null = backtickRegex.exec(line);
		while (match !== null) {
			const inner = match[1] ?? "";
			// Must be snake_case lowercase with at least one underscore
			if (/^[a-z][a-z0-9_]*$/.test(inner) && inner.includes("_")) {
				citations.push({ name: inner, line: i + 1, source: "prose" });
			}
			match = backtickRegex.exec(line);
		}
	}

	return citations;
}

function extractTailSection(content: string): TailSectionResult {
	const lines = content.split("\n");
	const HEADER = "## All Tools Used Are Read-Only";

	// Find all occurrences of the header
	const headerIndices: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if ((lines[i] ?? "").trim() === HEADER) {
			headerIndices.push(i);
		}
	}

	if (headerIndices.length === 0) {
		return { citations: [], errors: ["missing_tail_section"] };
	}
	if (headerIndices.length > 1) {
		return { citations: [], errors: ["duplicate_tail_section"] };
	}

	const headerLine = headerIndices[0] as number;

	// Find the first non-empty content line after the header
	let contentLineIdx = -1;
	for (let i = headerLine + 1; i < lines.length; i++) {
		const trimmed = (lines[i] ?? "").trim();
		if (trimmed === "") continue;
		contentLineIdx = i;
		break;
	}

	if (contentLineIdx === -1) {
		return { citations: [], errors: ["empty_tail_section"] };
	}

	const contentLine = (lines[contentLineIdx] ?? "").trim();

	// Reject if the next non-empty content is a heading or a fenced block
	if (contentLine.startsWith("#")) {
		return { citations: [], errors: ["empty_tail_section"] };
	}
	if (contentLine.startsWith("```")) {
		return { citations: [], errors: ["malformed_tail_section"] };
	}

	// Parse comma-separated list
	const names = contentLine
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	// Check for duplicates within the list
	const seen = new Set<string>();
	const errors: string[] = [];
	for (const name of names) {
		if (seen.has(name)) {
			errors.push("duplicate_in_tail_section");
			break;
		}
		seen.add(name);
	}

	const citations: Citation[] = names.map((name) => ({
		name,
		line: contentLineIdx + 1,
		source: "tail",
	}));

	return { citations, errors };
}

function buildAuthority(tools: ToolDefinition[]): Set<string> {
	const authority = new Set<string>();
	for (const tool of tools) {
		const actionMap = tool.tool_mapping?.action_tool_map;
		if (!actionMap) continue;
		for (const toolNames of Object.values(actionMap)) {
			for (const name of toolNames) {
				authority.add(name);
			}
		}
	}
	return authority;
}

function buildSubAgentAuthority(parentTools: ToolDefinition[], subAgentFacadeNames: string[]): Set<string> {
	const facadeSet = new Set(subAgentFacadeNames);
	const relevantTools = parentTools.filter((t) => facadeSet.has(t.name));
	return buildAuthority(relevantTools);
}

function validateRunbook(runbookPath: string, content: string, authority: Set<string>): ValidationReport {
	const proseCitations = extractProseCitations(content);
	const tailResult = extractTailSection(content);

	const missing: Citation[] = [];

	// Missing bucket: any citation whose name is not in authority
	for (const c of proseCitations) {
		if (!authority.has(c.name)) missing.push(c);
	}
	for (const c of tailResult.citations) {
		if (!authority.has(c.name)) missing.push(c);
	}

	// Drift buckets: comparison of unique names between prose and tail sets
	const proseNames = new Set(proseCitations.map((c) => c.name));
	const tailNames = new Set(tailResult.citations.map((c) => c.name));

	// proseOnly: dedupe by name (first occurrence wins)
	const proseOnlySeen = new Set<string>();
	const proseOnly: Citation[] = [];
	for (const c of proseCitations) {
		if (tailNames.has(c.name)) continue;
		if (proseOnlySeen.has(c.name)) continue;
		proseOnlySeen.add(c.name);
		proseOnly.push(c);
	}

	const tailOnly: Citation[] = [];
	for (const c of tailResult.citations) {
		if (!proseNames.has(c.name)) tailOnly.push(c);
	}

	return {
		runbookPath,
		missing,
		proseOnly,
		tailOnly,
		errors: tailResult.errors,
	};
}

function formatReport(report: ValidationReport): string {
	const lines: string[] = [];
	lines.push(`Runbook: ${report.runbookPath}`);
	lines.push("");

	lines.push(`Missing from action_tool_map (${report.missing.length}):`);
	if (report.missing.length === 0) {
		lines.push("  (none)");
	} else {
		for (const c of report.missing) {
			lines.push(`  line ${c.line}: ${c.name}`);
		}
	}
	lines.push("");

	lines.push(
		`Cited in prose but missing from "All Tools Used Are Read-Only" tail section (${report.proseOnly.length}):`,
	);
	if (report.proseOnly.length === 0) {
		lines.push("  (none)");
	} else {
		for (const c of report.proseOnly) {
			lines.push(`  line ${c.line}: ${c.name}`);
		}
	}
	lines.push("");

	lines.push(`Listed in tail section but not cited in prose (${report.tailOnly.length}):`);
	if (report.tailOnly.length === 0) {
		lines.push("  (none)");
	} else {
		for (const c of report.tailOnly) {
			lines.push(`  line ${c.line}: ${c.name}`);
		}
	}
	lines.push("");

	lines.push(`Structural errors (${report.errors.length}):`);
	if (report.errors.length === 0) {
		lines.push("  (none)");
	} else {
		for (const e of report.errors) {
			lines.push(`  ${e}`);
		}
	}
	lines.push("");

	lines.push("Fix:");
	lines.push('  - For each "Missing" entry: verify the tool name, or add it to');
	lines.push("    an action_tool_map in the agent's tools/*.yaml.");
	lines.push('  - For each "prose only" entry: add the name to the');
	lines.push('    "## All Tools Used Are Read-Only" tail section.');
	lines.push('  - For each "tail only" entry: either cite it in prose or remove');
	lines.push("    it from the tail section.");

	return lines.join("\n");
}

function isClean(report: ValidationReport): boolean {
	return (
		report.missing.length === 0 &&
		report.proseOnly.length === 0 &&
		report.tailOnly.length === 0 &&
		report.errors.length === 0
	);
}

function collectAgents(agentsRoot: string): AgentFixture[] {
	if (!existsSync(agentsRoot)) return [];
	const entries = readdirSync(agentsRoot);
	const fixtures: AgentFixture[] = [];

	for (const entry of entries) {
		const agentDir = join(agentsRoot, entry);
		if (!statSync(agentDir).isDirectory()) continue;

		const runbooksDir = join(agentDir, "knowledge", "runbooks");
		if (!existsSync(runbooksDir)) continue;
		if (!statSync(runbooksDir).isDirectory()) continue;

		const runbookPaths = readdirSync(runbooksDir)
			.filter((f) => f.endsWith(".md"))
			.map((f) => join(runbooksDir, f));

		if (runbookPaths.length === 0) continue;

		// loadAgent throws if the agent definition is broken; we let it
		// propagate so the test suite fails loudly rather than silently
		// skipping broken agents.
		const agent = loadAgent(agentDir);

		fixtures.push({ name: entry, agentDir, agent, runbookPaths });
	}

	return fixtures;
}

function collectSubAgentFixtures(parentFixtures: AgentFixture[]): SubAgentFixture[] {
	const fixtures: SubAgentFixture[] = [];

	for (const parent of parentFixtures) {
		for (const [subAgentName, subAgent] of parent.agent.subAgents) {
			// Extract runbook entries from the already-loaded knowledge. Avoids
			// a second filesystem walk; loadAgent() already recursed and
			// populated each sub-agent's knowledge[] with its own runbooks.
			const runbookEntries = subAgent.knowledge.filter((e) => e.category === "runbooks");
			if (runbookEntries.length === 0) continue;

			// Reconstruct absolute paths for each runbook file
			const runbookPaths = runbookEntries.map((entry) =>
				join(parent.agentDir, "agents", subAgentName, "knowledge", "runbooks", entry.filename),
			);

			fixtures.push({
				parentName: parent.name,
				subAgentName,
				parentTools: parent.agent.tools,
				subAgent,
				runbookPaths,
			});
		}
	}

	return fixtures;
}

// ============================================================================
// Tests
// ============================================================================

describe("extractProseCitations", () => {
	test("wrapped snake_case identifier with underscore -> citation", () => {
		const content = "Use `kafka_list_consumer_groups` to enumerate groups.";
		const citations = extractProseCitations(content);
		expect(citations).toHaveLength(1);
		expect(citations[0]).toEqual({
			name: "kafka_list_consumer_groups",
			line: 1,
			source: "prose",
		});
	});

	test("single-word backtick (no underscore) -> skipped", () => {
		const content = "The `timeout` value is 10 seconds.";
		expect(extractProseCitations(content)).toHaveLength(0);
	});

	test("PascalCase backtick -> skipped", () => {
		const content = "State is `RebalanceInProgress` right now.";
		expect(extractProseCitations(content)).toHaveLength(0);
	});

	test("hyphen-case backtick -> skipped", () => {
		const content = "The `dead-letter` topic has poison messages.";
		expect(extractProseCitations(content)).toHaveLength(0);
	});

	test("identifier with trailing punctuation outside backticks -> captured cleanly", () => {
		const content = "Use `kafka_describe_topic`.";
		const citations = extractProseCitations(content);
		expect(citations).toHaveLength(1);
		expect(citations[0]?.name).toBe("kafka_describe_topic");
	});

	test("identifier inside fenced code block -> skipped", () => {
		const content = [
			"Normal line with `kafka_list_topics`.",
			"```bash",
			"run `kafka_fake_tool_name` here",
			"```",
			"After fence: `kafka_get_topic_offsets`.",
		].join("\n");
		const citations = extractProseCitations(content);
		expect(citations).toHaveLength(2);
		expect(citations.map((c) => c.name)).toEqual(["kafka_list_topics", "kafka_get_topic_offsets"]);
		expect(citations[0]?.line).toBe(1);
		expect(citations[1]?.line).toBe(5);
	});

	test("multiple citations on one line", () => {
		const content = "Use `kafka_list_consumer_groups` and `kafka_describe_consumer_group` together.";
		const citations = extractProseCitations(content);
		expect(citations).toHaveLength(2);
		expect(citations.map((c) => c.name)).toEqual(["kafka_list_consumer_groups", "kafka_describe_consumer_group"]);
	});

	test("empty content -> empty array", () => {
		expect(extractProseCitations("")).toEqual([]);
	});

	test("runbook with frontmatter skips frontmatter when extracting prose citations", () => {
		const content = ["---", "triggers:", "  severity: [high]", "---", "# Body", "Use `kafka_list_topics` here."].join(
			"\n",
		);
		const citations = extractProseCitations(content);
		expect(citations).toHaveLength(1);
		expect(citations[0]?.name).toBe("kafka_list_topics");
		// Line number should point to the line within the original content
		// that contained the backtick match
		expect(citations[0]?.line).toBe(6);
	});

	test("frontmatter containing snake_case identifier is not extracted as citation", () => {
		const content = [
			"---",
			"triggers:",
			"  services: [kafka_consumer_group]",
			"---",
			"# Body",
			"No tool citations here.",
		].join("\n");
		const citations = extractProseCitations(content);
		expect(citations).toHaveLength(0);
	});
});

describe("extractTailSection", () => {
	test("standard section with comma-separated list", () => {
		const content = [
			"# Runbook",
			"",
			"## Investigation",
			"Use `kafka_list_topics`.",
			"",
			"## All Tools Used Are Read-Only",
			"kafka_list_topics, kafka_describe_topic, kafka_get_topic_offsets",
		].join("\n");
		const result = extractTailSection(content);
		expect(result.errors).toEqual([]);
		expect(result.citations).toHaveLength(3);
		expect(result.citations.map((c) => c.name)).toEqual([
			"kafka_list_topics",
			"kafka_describe_topic",
			"kafka_get_topic_offsets",
		]);
		// All tail citations share the same line number (the content line)
		expect(result.citations.every((c) => c.line === 7)).toBe(true);
		expect(result.citations.every((c) => c.source === "tail")).toBe(true);
	});

	test("whitespace around names is trimmed", () => {
		const content = ["## All Tools Used Are Read-Only", "  a_one  ,   a_two ,a_three  "].join("\n");
		const result = extractTailSection(content);
		expect(result.errors).toEqual([]);
		expect(result.citations.map((c) => c.name)).toEqual(["a_one", "a_two", "a_three"]);
	});

	test("empty entries from trailing commas are ignored", () => {
		const content = ["## All Tools Used Are Read-Only", "a_one, , a_two,"].join("\n");
		const result = extractTailSection(content);
		expect(result.errors).toEqual([]);
		expect(result.citations.map((c) => c.name)).toEqual(["a_one", "a_two"]);
	});

	test("missing header -> missing_tail_section error", () => {
		const content = "# Runbook\n\nJust some content without the tail section.";
		const result = extractTailSection(content);
		expect(result.errors).toContain("missing_tail_section");
		expect(result.citations).toEqual([]);
	});

	test("duplicate header -> duplicate_tail_section error", () => {
		const content = ["## All Tools Used Are Read-Only", "a_one", "", "## All Tools Used Are Read-Only", "a_two"].join(
			"\n",
		);
		const result = extractTailSection(content);
		expect(result.errors).toContain("duplicate_tail_section");
	});

	test("header followed immediately by next heading -> empty_tail_section", () => {
		const content = ["## All Tools Used Are Read-Only", "", "## Next Section", "content"].join("\n");
		const result = extractTailSection(content);
		expect(result.errors).toContain("empty_tail_section");
	});

	test("header followed by fenced code block -> malformed_tail_section", () => {
		const content = ["## All Tools Used Are Read-Only", "```", "some code", "```"].join("\n");
		const result = extractTailSection(content);
		expect(result.errors).toContain("malformed_tail_section");
	});

	test("header at EOF with nothing after -> empty_tail_section", () => {
		const content = "## All Tools Used Are Read-Only";
		const result = extractTailSection(content);
		expect(result.errors).toContain("empty_tail_section");
	});

	test("duplicates within tail list -> duplicate_in_tail_section", () => {
		const content = ["## All Tools Used Are Read-Only", "a_one, a_two, a_one"].join("\n");
		const result = extractTailSection(content);
		expect(result.errors).toContain("duplicate_in_tail_section");
	});
});

describe("buildAuthority", () => {
	test("union across multiple tool definitions", () => {
		const tools: ToolDefinition[] = [
			{
				name: "kafka-introspect",
				description: "Kafka",
				input_schema: { type: "object", properties: {} },
				tool_mapping: {
					mcp_server: "kafka",
					mcp_patterns: ["kafka_*"],
					action_tool_map: {
						action_a: ["kafka_list_topics", "kafka_describe_topic"],
						action_b: ["kafka_get_topic_offsets"],
					},
				},
			},
			{
				name: "elastic-logs",
				description: "Elastic",
				input_schema: { type: "object", properties: {} },
				tool_mapping: {
					mcp_server: "elastic",
					mcp_patterns: ["elasticsearch_*"],
					action_tool_map: {
						search: ["elasticsearch_search", "elasticsearch_count_documents"],
					},
				},
			},
		];
		const authority = buildAuthority(tools);
		expect(authority.has("kafka_list_topics")).toBe(true);
		expect(authority.has("kafka_describe_topic")).toBe(true);
		expect(authority.has("kafka_get_topic_offsets")).toBe(true);
		expect(authority.has("elasticsearch_search")).toBe(true);
		expect(authority.has("elasticsearch_count_documents")).toBe(true);
		expect(authority.size).toBe(5);
	});

	test("tool without tool_mapping contributes nothing", () => {
		const tools: ToolDefinition[] = [
			{
				name: "notify-slack",
				description: "Slack",
				input_schema: { type: "object", properties: {} },
			},
		];
		const authority = buildAuthority(tools);
		expect(authority.size).toBe(0);
	});

	test("tool with tool_mapping but no action_tool_map contributes nothing", () => {
		const tools: ToolDefinition[] = [
			{
				name: "tool-a",
				description: "A",
				input_schema: { type: "object", properties: {} },
				tool_mapping: {
					mcp_server: "a",
					mcp_patterns: ["a_*"],
				},
			},
		];
		const authority = buildAuthority(tools);
		expect(authority.size).toBe(0);
	});

	test("empty tools array -> empty set", () => {
		expect(buildAuthority([]).size).toBe(0);
	});

	test("duplicate tool names across actions are deduplicated", () => {
		const tools: ToolDefinition[] = [
			{
				name: "kafka-introspect",
				description: "Kafka",
				input_schema: { type: "object", properties: {} },
				tool_mapping: {
					mcp_server: "kafka",
					mcp_patterns: ["kafka_*"],
					action_tool_map: {
						action_a: ["kafka_list_topics", "kafka_describe_topic"],
						action_b: ["kafka_describe_topic"],
					},
				},
			},
		];
		const authority = buildAuthority(tools);
		expect(authority.size).toBe(2);
		expect(authority.has("kafka_describe_topic")).toBe(true);
	});
});

describe("buildSubAgentAuthority", () => {
	const makeTool = (name: string, actionMap: Record<string, string[]>): ToolDefinition => ({
		name,
		description: "test",
		input_schema: { type: "object", properties: {} },
		tool_mapping: {
			mcp_server: name,
			mcp_patterns: [`${name}_*`],
			action_tool_map: actionMap,
		},
	});

	const parentTools: ToolDefinition[] = [
		makeTool("kafka-introspect", {
			consumer_lag: ["kafka_list_consumer_groups", "kafka_get_consumer_group_lag"],
			topic_info: ["kafka_list_topics", "kafka_describe_topic"],
		}),
		makeTool("elastic-logs", {
			search: ["elasticsearch_search", "elasticsearch_count_documents"],
		}),
		makeTool("couchbase-health", {
			vitals: ["capella_get_system_vitals"],
		}),
	];

	test("facade in sub-agent list + tool in action_tool_map -> included", () => {
		const authority = buildSubAgentAuthority(parentTools, ["kafka-introspect"]);
		expect(authority.has("kafka_list_consumer_groups")).toBe(true);
		expect(authority.has("kafka_get_consumer_group_lag")).toBe(true);
		expect(authority.has("kafka_list_topics")).toBe(true);
		expect(authority.has("kafka_describe_topic")).toBe(true);
	});

	test("facade NOT in sub-agent list -> entire facade's tools excluded", () => {
		const authority = buildSubAgentAuthority(parentTools, ["kafka-introspect"]);
		expect(authority.has("elasticsearch_search")).toBe(false);
		expect(authority.has("elasticsearch_count_documents")).toBe(false);
		expect(authority.has("capella_get_system_vitals")).toBe(false);
	});

	test("multiple facades in list -> union of their tools", () => {
		const authority = buildSubAgentAuthority(parentTools, ["kafka-introspect", "elastic-logs"]);
		expect(authority.has("kafka_list_consumer_groups")).toBe(true);
		expect(authority.has("elasticsearch_search")).toBe(true);
		expect(authority.has("capella_get_system_vitals")).toBe(false);
		expect(authority.size).toBe(6); // 4 kafka + 2 elastic
	});

	test("empty facade list -> empty authority set", () => {
		const authority = buildSubAgentAuthority(parentTools, []);
		expect(authority.size).toBe(0);
	});

	test("unknown facade name -> silently skipped, authority contains only recognized facades", () => {
		const authority = buildSubAgentAuthority(parentTools, ["kafka-introspect", "bogus-facade"]);
		expect(authority.has("kafka_list_consumer_groups")).toBe(true);
		expect(authority.size).toBe(4); // only the 4 kafka tools; bogus-facade silently ignored
	});
});

describe("validateRunbook", () => {
	const makeRunbook = (proseTools: string[], tailTools: string[]): string => {
		const proseLines =
			proseTools.length > 0
				? ["## Investigation", ...proseTools.map((t) => `Use \`${t}\` here.`)]
				: ["## Investigation", "Nothing to do."];
		const tailLines = ["", "## All Tools Used Are Read-Only", tailTools.join(", ")];
		return ["# Runbook", "", ...proseLines, ...tailLines].join("\n");
	};

	test("clean runbook -> clean report", () => {
		const authority = new Set(["a_one", "a_two"]);
		const content = makeRunbook(["a_one", "a_two"], ["a_one", "a_two"]);
		const report = validateRunbook("/fake/path.md", content, authority);
		expect(report.missing).toEqual([]);
		expect(report.proseOnly).toEqual([]);
		expect(report.tailOnly).toEqual([]);
		expect(report.errors).toEqual([]);
		expect(isClean(report)).toBe(true);
	});

	test("prose cites missing tool -> missing bucket", () => {
		const authority = new Set(["a_real"]);
		const content = makeRunbook(["a_fake"], ["a_fake"]);
		const report = validateRunbook("/fake/path.md", content, authority);
		// cited in both prose and tail -> both copies land in missing
		expect(report.missing).toHaveLength(2);
		expect(report.missing.every((c) => c.name === "a_fake")).toBe(true);
		// Same name in both prose and tail; neither proseOnly nor tailOnly
		expect(report.proseOnly).toEqual([]);
		expect(report.tailOnly).toEqual([]);
	});

	test("prose cites tool not in tail -> proseOnly bucket", () => {
		const authority = new Set(["a_one", "a_two"]);
		const content = makeRunbook(["a_one", "a_two"], ["a_one"]);
		const report = validateRunbook("/fake/path.md", content, authority);
		expect(report.missing).toEqual([]);
		expect(report.proseOnly).toHaveLength(1);
		expect(report.proseOnly[0]?.name).toBe("a_two");
		expect(report.tailOnly).toEqual([]);
	});

	test("tail lists tool not in prose -> tailOnly bucket", () => {
		const authority = new Set(["a_one", "a_two"]);
		const content = makeRunbook(["a_one"], ["a_one", "a_two"]);
		const report = validateRunbook("/fake/path.md", content, authority);
		expect(report.missing).toEqual([]);
		expect(report.proseOnly).toEqual([]);
		expect(report.tailOnly).toHaveLength(1);
		expect(report.tailOnly[0]?.name).toBe("a_two");
	});

	test("all three buckets populated simultaneously", () => {
		const authority = new Set(["a_one"]);
		// prose: a_one (valid), a_two (missing, prose only)
		// tail:  a_one, a_three (missing, tail only)
		const content = makeRunbook(["a_one", "a_two"], ["a_one", "a_three"]);
		const report = validateRunbook("/fake/path.md", content, authority);
		expect(report.missing.map((c) => c.name).sort()).toEqual(["a_three", "a_two"]);
		expect(report.proseOnly.map((c) => c.name)).toEqual(["a_two"]);
		expect(report.tailOnly.map((c) => c.name)).toEqual(["a_three"]);
		expect(isClean(report)).toBe(false);
	});

	test("structural tail error bubbles to errors bucket", () => {
		const authority = new Set(["a_one"]);
		const content = "# Runbook\n\n## Investigation\nUse `a_one`.\n";
		const report = validateRunbook("/fake/path.md", content, authority);
		expect(report.errors).toContain("missing_tail_section");
		expect(isClean(report)).toBe(false);
	});

	test("same tool cited multiple times in prose preserves line numbers", () => {
		const authority = new Set(["a_one"]);
		const content = [
			"# Runbook",
			"## Investigation",
			"First mention: `a_fake`.",
			"Second mention: `a_fake`.",
			"",
			"## All Tools Used Are Read-Only",
			"a_fake",
		].join("\n");
		const report = validateRunbook("/fake/path.md", content, authority);
		expect(report.missing).toHaveLength(3); // 2 prose + 1 tail
		const proseMissing = report.missing.filter((c) => c.source === "prose");
		expect(proseMissing).toHaveLength(2);
		expect(proseMissing[0]?.line).toBe(3);
		expect(proseMissing[1]?.line).toBe(4);
	});
});

describe("formatReport", () => {
	test("clean report output is still well-formed", () => {
		// formatReport is called only on non-clean reports in practice.
		// This test documents that even a clean report produces readable output.
		const report: ValidationReport = {
			runbookPath: "/fake/path.md",
			missing: [],
			proseOnly: [],
			tailOnly: [],
			errors: [],
		};
		const text = formatReport(report);
		expect(text).toContain("/fake/path.md");
		expect(text).toContain("Missing from action_tool_map (0)");
	});

	test("formats missing bucket with line numbers", () => {
		const report: ValidationReport = {
			runbookPath: "/x/y.md",
			missing: [
				{ name: "kafka_fake", line: 11, source: "prose" },
				{ name: "capella_fake", line: 20, source: "tail" },
			],
			proseOnly: [],
			tailOnly: [],
			errors: [],
		};
		const text = formatReport(report);
		expect(text).toContain("Missing from action_tool_map (2)");
		expect(text).toContain("line 11: kafka_fake");
		expect(text).toContain("line 20: capella_fake");
	});

	test("formats all four buckets together", () => {
		const report: ValidationReport = {
			runbookPath: "/x/y.md",
			missing: [{ name: "m_one", line: 5, source: "prose" }],
			proseOnly: [{ name: "p_one", line: 6, source: "prose" }],
			tailOnly: [{ name: "t_one", line: 99, source: "tail" }],
			errors: ["empty_tail_section"],
		};
		const text = formatReport(report);
		expect(text).toContain("Missing from action_tool_map (1)");
		expect(text).toContain("prose but missing from");
		expect(text).toContain("Listed in tail section but not cited");
		expect(text).toContain("Structural errors (1)");
		expect(text).toContain("empty_tail_section");
		expect(text).toContain("Fix:");
	});

	test("empty buckets print (none)", () => {
		const report: ValidationReport = {
			runbookPath: "/x/y.md",
			missing: [{ name: "m_one", line: 5, source: "prose" }],
			proseOnly: [],
			tailOnly: [],
			errors: [],
		};
		const text = formatReport(report);
		expect(text).toContain("(none)");
	});
});

describe("collectAgents", () => {
	function makeTempAgentsRoot(): string {
		return mkdtempSync(join(tmpdir(), "runbook-validator-test-"));
	}

	function writeAgentYaml(agentDir: string, name: string): void {
		writeFileSync(
			join(agentDir, "agent.yaml"),
			`name: ${name}\nversion: 0.1.0\ndescription: test agent for runbook-validator tests\n`,
		);
	}

	test("returns fixture for agent with runbooks", () => {
		const root = makeTempAgentsRoot();
		try {
			const agentDir = join(root, "test-agent");
			mkdirSync(join(agentDir, "knowledge", "runbooks"), { recursive: true });
			writeAgentYaml(agentDir, "test-agent");
			writeFileSync(join(agentDir, "knowledge", "runbooks", "rb1.md"), "# Runbook 1");
			writeFileSync(join(agentDir, "knowledge", "runbooks", "rb2.md"), "# Runbook 2");

			const fixtures = collectAgents(root);
			expect(fixtures).toHaveLength(1);
			expect(fixtures[0]?.name).toBe("test-agent");
			expect(fixtures[0]?.runbookPaths).toHaveLength(2);
			expect(fixtures[0]?.runbookPaths.every((p) => p.endsWith(".md"))).toBe(true);
		} finally {
			rmSync(root, { recursive: true });
		}
	});

	test("skips agent with no knowledge directory", () => {
		const root = makeTempAgentsRoot();
		try {
			const agentDir = join(root, "plain-agent");
			mkdirSync(agentDir, { recursive: true });
			writeAgentYaml(agentDir, "plain-agent");

			const fixtures = collectAgents(root);
			expect(fixtures).toHaveLength(0);
		} finally {
			rmSync(root, { recursive: true });
		}
	});

	test("skips agent with empty runbooks directory", () => {
		const root = makeTempAgentsRoot();
		try {
			const agentDir = join(root, "empty-rb-agent");
			mkdirSync(join(agentDir, "knowledge", "runbooks"), { recursive: true });
			writeAgentYaml(agentDir, "empty-rb-agent");

			const fixtures = collectAgents(root);
			expect(fixtures).toHaveLength(0);
		} finally {
			rmSync(root, { recursive: true });
		}
	});

	test("excludes .gitkeep from runbook paths", () => {
		const root = makeTempAgentsRoot();
		try {
			const agentDir = join(root, "a");
			mkdirSync(join(agentDir, "knowledge", "runbooks"), { recursive: true });
			writeAgentYaml(agentDir, "a");
			writeFileSync(join(agentDir, "knowledge", "runbooks", ".gitkeep"), "");
			writeFileSync(join(agentDir, "knowledge", "runbooks", "real.md"), "# Real");

			const fixtures = collectAgents(root);
			expect(fixtures).toHaveLength(1);
			expect(fixtures[0]?.runbookPaths).toHaveLength(1);
			expect(fixtures[0]?.runbookPaths[0]?.endsWith("real.md")).toBe(true);
		} finally {
			rmSync(root, { recursive: true });
		}
	});
});

describe("collectSubAgentFixtures", () => {
	type KnowledgeEntryLike = { category: string; filename: string; content: string };

	function makeSubAgent(knowledge: KnowledgeEntryLike[]): LoadedAgent {
		return {
			manifest: { name: "sub", version: "0.1.0", description: "test" },
			soul: "",
			rules: "",
			tools: [],
			skills: new Map(),
			subAgents: new Map(),
			knowledge,
		} as unknown as LoadedAgent;
	}

	function makeParentFixture(
		overrides: { subAgents?: Map<string, LoadedAgent>; agentDir?: string } = {},
	): AgentFixture {
		return {
			name: "test-parent",
			agentDir: overrides.agentDir ?? "/fake/parent",
			agent: {
				manifest: { name: "test-parent", version: "0.1.0", description: "test" },
				soul: "",
				rules: "",
				tools: [],
				skills: new Map(),
				subAgents: overrides.subAgents ?? new Map(),
				knowledge: [],
			} as unknown as LoadedAgent,
			runbookPaths: [],
		};
	}

	test("parent with sub-agent that has runbook knowledge -> fixture emitted", () => {
		const subAgents = new Map<string, LoadedAgent>();
		subAgents.set(
			"kafka-agent",
			makeSubAgent([{ category: "runbooks", filename: "kafka-rebalance.md", content: "# Test" }]),
		);
		const parent = makeParentFixture({ subAgents, agentDir: "/fake/parent" });
		const fixtures = collectSubAgentFixtures([parent]);
		expect(fixtures).toHaveLength(1);
		expect(fixtures[0]?.parentName).toBe("test-parent");
		expect(fixtures[0]?.subAgentName).toBe("kafka-agent");
		expect(fixtures[0]?.runbookPaths).toHaveLength(1);
		expect(fixtures[0]?.runbookPaths[0]).toBe("/fake/parent/agents/kafka-agent/knowledge/runbooks/kafka-rebalance.md");
	});

	test("parent with sub-agents but no knowledge -> no fixtures", () => {
		const subAgents = new Map<string, LoadedAgent>();
		subAgents.set("kafka-agent", makeSubAgent([]));
		const parent = makeParentFixture({ subAgents });
		expect(collectSubAgentFixtures([parent])).toHaveLength(0);
	});

	test("parent with sub-agent that has non-runbook knowledge only -> no fixture", () => {
		const subAgents = new Map<string, LoadedAgent>();
		subAgents.set(
			"kafka-agent",
			makeSubAgent([{ category: "systems-map", filename: "topology.md", content: "# Topology" }]),
		);
		const parent = makeParentFixture({ subAgents });
		expect(collectSubAgentFixtures([parent])).toHaveLength(0);
	});

	test("parent without sub-agents -> no fixtures", () => {
		const parent = makeParentFixture();
		expect(collectSubAgentFixtures([parent])).toHaveLength(0);
	});

	test("parent with multiple sub-agents, some with runbooks -> fixtures for only those with runbooks", () => {
		const subAgents = new Map<string, LoadedAgent>();
		subAgents.set("elastic-agent", makeSubAgent([]));
		subAgents.set(
			"kafka-agent",
			makeSubAgent([
				{ category: "runbooks", filename: "rb1.md", content: "# RB1" },
				{ category: "runbooks", filename: "rb2.md", content: "# RB2" },
			]),
		);
		subAgents.set("capella-agent", makeSubAgent([]));
		const parent = makeParentFixture({ subAgents, agentDir: "/p" });
		const fixtures = collectSubAgentFixtures([parent]);
		expect(fixtures).toHaveLength(1);
		expect(fixtures[0]?.subAgentName).toBe("kafka-agent");
		expect(fixtures[0]?.runbookPaths).toHaveLength(2);
		expect(fixtures[0]?.runbookPaths.slice().sort()).toEqual([
			"/p/agents/kafka-agent/knowledge/runbooks/rb1.md",
			"/p/agents/kafka-agent/knowledge/runbooks/rb2.md",
		]);
	});
});

// ============================================================================
// Production validation - real agents
// ============================================================================

const AGENTS_ROOT = join(import.meta.dir, "../../../agents");
const PRODUCTION_FIXTURES = collectAgents(AGENTS_ROOT);

describe("real agent runbook bindings", () => {
	for (const fixture of PRODUCTION_FIXTURES) {
		describe(fixture.name, () => {
			const authority = buildAuthority(fixture.agent.tools);

			for (const runbookPath of fixture.runbookPaths) {
				const basename = runbookPath.split("/").pop() ?? runbookPath;
				test(`${basename} is clean`, () => {
					const content = readFileSync(runbookPath, "utf-8");
					const report = validateRunbook(runbookPath, content, authority);
					if (!isClean(report)) {
						throw new Error(`\n${formatReport(report)}`);
					}
				});
			}
		});
	}
});

// ============================================================================
// Production validation - real sub-agent runbooks (SIO-642)
// ============================================================================

const SUB_AGENT_FIXTURES = collectSubAgentFixtures(PRODUCTION_FIXTURES);

describe("real sub-agent runbook bindings", () => {
	for (const fixture of SUB_AGENT_FIXTURES) {
		describe(`${fixture.parentName} > ${fixture.subAgentName}`, () => {
			const authority = buildSubAgentAuthority(fixture.parentTools, fixture.subAgent.manifest.tools ?? []);

			for (const runbookPath of fixture.runbookPaths) {
				const basename = runbookPath.split("/").pop() ?? runbookPath;
				test(`${basename} is clean`, () => {
					const content = readFileSync(runbookPath, "utf-8");
					const report = validateRunbook(runbookPath, content, authority);
					if (!isClean(report)) {
						throw new Error(`\n${formatReport(report)}`);
					}
				});
			}
		});
	}
});
