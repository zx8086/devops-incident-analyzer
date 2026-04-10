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

function extractProseCitations(_content: string): Citation[] {
	// Task 2
	return [];
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
void extractProseCitations;
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
// Tests - placeholder to confirm the file is picked up
// ============================================================================

describe("runbook-validator skeleton", () => {
	test("placeholder passes", () => {
		expect(
			isClean({ runbookPath: "", missing: [], proseOnly: [], tailOnly: [], errors: [] }),
		).toBe(true);
	});
});
