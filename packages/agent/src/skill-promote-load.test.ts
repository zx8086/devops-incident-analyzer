// agent/src/skill-promote-load.test.ts
//
// SIO-1345: structural end-to-end -- render a proposal in pr mode, register it via
// addSkillToManifest, and prove loadAgent serves both the body and the typed
// frontmatter. Mirrors the elastic-iac-load.test.ts "skill content reaches the
// assembled prompt" canary, against a temp agent dir.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgent } from "@devops-agent/gitagent-bridge";
import { addSkillToManifest } from "./skill-manifest.ts";
import { renderSkillMarkdown } from "./skill-promote.ts";

const MANIFEST = `name: testagent
version: "0.0.1"
description: promotion load test
skills:
  - placeholder
`;

describe("promoted skill loads end-to-end (SIO-1345)", () => {
	test("pr-mode render + manifest edit -> loadAgent serves skill + frontmatter", () => {
		const root = mkdtempSync(join(tmpdir(), "skill-promote-load-"));
		const agentDir = join(root, "agents", "testagent");
		mkdirSync(join(agentDir, "skills", "lag-correlation"), { recursive: true });

		const markdown = renderSkillMarkdown(
			{
				annotations: {
					skill_name: "lag-correlation",
					confidence: "0.5",
					usage_count: "0",
					success_count: "0",
					failure_count: "0",
					learned_from: "thread:t1",
					learned_at: "2026-07-30T10:00:00Z",
				},
				body: "Proposed skill: lag-correlation - correlate lag with errors\nProcedure: check consumer lag, then downstream error rates",
			},
			{ mode: "pr" },
		);
		writeFileSync(join(agentDir, "skills", "lag-correlation", "SKILL.md"), markdown, "utf8");
		writeFileSync(join(agentDir, "agent.yaml"), addSkillToManifest(MANIFEST, "lag-correlation").content, "utf8");

		const agent = loadAgent(agentDir);
		expect(agent.skills.get("lag-correlation")).toContain("check consumer lag");
		expect(agent.skillMeta.get("lag-correlation")?.confidence).toBe(0.5);
		expect(agent.skillMeta.get("lag-correlation")?.learned_from).toBe("thread:t1");
	});
});
