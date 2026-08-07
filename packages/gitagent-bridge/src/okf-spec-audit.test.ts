// gitagent-bridge/src/okf-spec-audit.test.ts
// SIO-1440: tier-1 static consistency checks over the OKF spec (agent.yaml/SOUL/RULES/knowledge)
// that the whole-pipeline eval program does not cover. See skill-tool-coverage.test.ts for the
// SIO-1228/1257/1229 checks this file deliberately does NOT duplicate.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { findFrontmatterDegradations, findOrphanedKnowledgeFiles } from "./okf-spec-audit.ts";
import { KnowledgeIndexSchema } from "./types.ts";

const AGENTS_DIR = join(import.meta.dir, "../../../agents/incident-analyzer");

describe("SIO-1440 check 2: knowledge frontmatter must not silently degrade", () => {
	test("every knowledge file's frontmatter parses cleanly (no tolerant-catch fallback)", () => {
		const indexYaml = parse(readFileSync(join(AGENTS_DIR, "knowledge/index.yaml"), "utf-8"));
		const index = KnowledgeIndexSchema.parse(indexYaml);
		const degradations = findFrontmatterDegradations(AGENTS_DIR, index);
		expect(degradations).toEqual([]);
	});
});

describe("SIO-1440 check 3: dead/orphan knowledge files in the spec tree", () => {
	test("every .md file under knowledge/ sits inside a declared category's path", () => {
		const indexYaml = parse(readFileSync(join(AGENTS_DIR, "knowledge/index.yaml"), "utf-8"));
		const index = KnowledgeIndexSchema.parse(indexYaml);
		const orphans = findOrphanedKnowledgeFiles(AGENTS_DIR, index);
		expect(orphans).toEqual([]);
	});
});
