// gitagent-bridge/src/runbook-validator.test.ts
// SIO-641: Runbook tool-name binding validator. Walks every agent's runbooks,
// extracts tool name citations from prose and the "All Tools Used Are Read-Only"
// tail section, and fails bun test if any citation is not in the agent's
// action_tool_map union or if prose and tail disagree.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
	agent: LoadedAgent;
	runbookPaths: string[];
}

// ============================================================================
// Helpers (stubs - implemented in later tasks)
// ============================================================================

function extractProseCitations(content: string): Citation[] {
	const citations: Citation[] = [];
	const lines = content.split("\n");
	let inFence = false;

	for (let i = 0; i < lines.length; i++) {
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

function extractTailSection(_content: string): TailSectionResult {
	// Task 3
	return { citations: [], errors: [] };
}

function buildAuthority(_tools: ToolDefinition[]): Set<string> {
	// Task 4
	return new Set();
}

function validateRunbook(
	runbookPath: string,
	_content: string,
	_authority: Set<string>,
): ValidationReport {
	// Task 5
	return { runbookPath, missing: [], proseOnly: [], tailOnly: [], errors: [] };
}

function formatReport(_report: ValidationReport): string {
	// Task 6
	return "";
}

function isClean(report: ValidationReport): boolean {
	return (
		report.missing.length === 0 &&
		report.proseOnly.length === 0 &&
		report.tailOnly.length === 0 &&
		report.errors.length === 0
	);
}

function collectAgents(_agentsRoot: string): AgentFixture[] {
	// Task 7
	return [];
}

// Suppress "declared but never read" warnings for stubs that are referenced
// only in later tasks. Biome will remove these lines when the stubs get real
// callers.
void extractTailSection;
void buildAuthority;
void validateRunbook;
void formatReport;
void collectAgents;
void existsSync;
void readdirSync;
void readFileSync;
void statSync;
void join;
void loadAgent;

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
		expect(citations.map((c) => c.name)).toEqual([
			"kafka_list_topics",
			"kafka_get_topic_offsets",
		]);
		expect(citations[0]?.line).toBe(1);
		expect(citations[1]?.line).toBe(5);
	});

	test("multiple citations on one line", () => {
		const content =
			"Use `kafka_list_consumer_groups` and `kafka_describe_consumer_group` together.";
		const citations = extractProseCitations(content);
		expect(citations).toHaveLength(2);
		expect(citations.map((c) => c.name)).toEqual([
			"kafka_list_consumer_groups",
			"kafka_describe_consumer_group",
		]);
	});

	test("empty content -> empty array", () => {
		expect(extractProseCitations("")).toEqual([]);
	});
});
