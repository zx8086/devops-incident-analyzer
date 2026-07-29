// gitagent-bridge/src/runbook-validator.ts
// SIO-641: Runbook tool-name binding validator. Extracts tool-name citations from a
// runbook's prose and its "All Tools Used Are Read-Only" tail section, and reports any
// citation that is not in the agent's action_tool_map union or where prose and tail
// disagree.
//
// SIO-1288: extracted verbatim from runbook-validator.test.ts, where all of this logic
// used to live. It is a production conformance gate over the real agents/ tree, not a
// unit-test helper, so it belongs in a module the test imports. Pure extraction -- no
// behaviour change; the same 59 tests cover it.
//
// Every export is pure: no file IO except collectAgents/collectSubAgentFixtures, which
// walk the agent tree to build fixtures.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { type LoadedAgent, loadAgent, type ToolDefinition } from "./index.ts";

// ============================================================================
// Types
// ============================================================================

export interface Citation {
	name: string;
	line: number;
	source: "prose" | "tail";
}

export interface TailSectionResult {
	citations: Citation[];
	errors: string[];
}

export interface ValidationReport {
	runbookPath: string;
	missing: Citation[];
	proseOnly: Citation[];
	tailOnly: Citation[];
	errors: string[];
}

export interface AgentFixture {
	name: string;
	agentDir: string;
	agent: LoadedAgent;
	runbookPaths: string[];
}

export interface SubAgentFixture {
	parentName: string;
	subAgentName: string;
	parentTools: ToolDefinition[];
	subAgent: LoadedAgent;
	runbookPaths: string[];
}

// ============================================================================
// Helpers (stubs - implemented in later tasks)
// ============================================================================

export function extractProseCitations(content: string): Citation[] {
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

export function extractTailSection(content: string): TailSectionResult {
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

export function buildAuthority(tools: ToolDefinition[]): Set<string> {
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

export function buildSubAgentAuthority(parentTools: ToolDefinition[], subAgentFacadeNames: string[]): Set<string> {
	const facadeSet = new Set(subAgentFacadeNames);
	const relevantTools = parentTools.filter((t) => facadeSet.has(t.name));
	return buildAuthority(relevantTools);
}

// SIO-1288: read the declared tool list from `tools:` frontmatter. Returns undefined when
// the key is absent, which is what selects the legacy tail-section path in validateRunbook.
//
// Why frontmatter at all: the tail section's contract is "first non-empty line under the
// header is a comma-separated list", so a parser cannot tell a tool list from a sentence
// containing commas. In SIO-1278 explanatory prose written there split into bogus tool
// names. A typed YAML array cannot fail that way.
//
// Deliberately hand-rolled rather than reusing parseRunbookFrontmatter: that function
// THROWS on malformed frontmatter (it is the agent-load path, where failing loud is
// correct). Here a malformed block must degrade to the tail-section path so one bad
// runbook cannot take down the whole validation sweep -- the report collects errors, it
// does not abort.
export function extractFrontmatterTools(content: string): string[] | undefined {
	if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return undefined;
	const afterOpening = content.indexOf("\n") + 1;
	const closingMatch = content.slice(afterOpening).match(/^---\r?\n?/m);
	if (!closingMatch || closingMatch.index === undefined) return undefined;

	const block = content.slice(afterOpening, afterOpening + closingMatch.index);
	try {
		const parsed = parse(block);
		if (!parsed || typeof parsed !== "object") return undefined;
		const tools = (parsed as Record<string, unknown>).tools;
		if (!Array.isArray(tools)) return undefined;
		// Every element must be a string; a malformed entry falls back rather than
		// silently contributing a "[object Object]" tool name to the authority check.
		if (!tools.every((t) => typeof t === "string")) return undefined;
		return tools as string[];
	} catch {
		return undefined;
	}
}

export function validateRunbook(runbookPath: string, content: string, authority: Set<string>): ValidationReport {
	const proseCitations = extractProseCitations(content);
	// SIO-1288 dual-read: `tools:` frontmatter is the source of truth when present; the
	// tail section remains supported so the validator change and the content migration stay
	// separately revertable. The prose cross-check runs against whichever won -- it is
	// valuable independent of where the declaration lives.
	const frontmatterTools = extractFrontmatterTools(content);
	const tailResult: TailSectionResult =
		frontmatterTools !== undefined
			? { citations: frontmatterTools.map((name) => ({ name, line: 0, source: "tail" as const })), errors: [] }
			: extractTailSection(content);

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

export function formatReport(report: ValidationReport): string {
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

export function isClean(report: ValidationReport): boolean {
	return (
		report.missing.length === 0 &&
		report.proseOnly.length === 0 &&
		report.tailOnly.length === 0 &&
		report.errors.length === 0
	);
}

export function collectAgents(agentsRoot: string): AgentFixture[] {
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

export function collectSubAgentFixtures(parentFixtures: AgentFixture[]): SubAgentFixture[] {
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
