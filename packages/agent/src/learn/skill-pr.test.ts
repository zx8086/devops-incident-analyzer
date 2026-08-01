// agent/src/learn/skill-pr.test.ts
import { describe, expect, test } from "bun:test";
import type { AnnotationMap } from "@devops-agent/shared";
import { AGENT_MANIFEST_PATH, buildSkillPrBody, buildSkillPrFiles, buildSkillPrTitle, SKILL_DIR } from "./skill-pr.ts";

const ANNOTATIONS: AnnotationMap = {
	kind: "skill",
	skill_name: "lag-correlation",
	confidence: "0.5",
	learned_from: "ticket:OPS-123",
	learned_at: "2026-08-01T10:00:00Z",
	usage_count: "0",
	success_count: "0",
	failure_count: "0",
};

const BODY = [
	"Proposed skill: lag-correlation - Correlate Kafka consumer lag with downstream error spikes.",
	"When to use: A lag spike coincides with a downstream error rate increase.",
	"Procedure: Pull consumer-group lag, then error rate over the same window, then align timestamps.",
].join("\n");

const BASE_MANIFEST = ["name: incident-analyzer", "skills:", "  - existing-skill", ""].join("\n");

describe("buildSkillPrFiles (SIO-1346)", () => {
	test("stages SKILL.md (pr banner) and the edited agent.yaml", () => {
		const result = buildSkillPrFiles(BASE_MANIFEST, {
			skillName: "lag-correlation",
			annotations: ANNOTATIONS,
			body: BODY,
		});
		if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);
		expect(result.files.map((f) => f.path)).toEqual([`${SKILL_DIR}/lag-correlation/SKILL.md`, AGENT_MANIFEST_PATH]);
		const [skill, manifest] = result.files;
		expect(skill?.contents).toContain("activates on merge");
		expect(skill?.contents).toContain("## Procedure");
		expect(manifest?.contents).toContain("- existing-skill");
		expect(manifest?.contents).toContain("- lag-correlation");
	});

	// The staleness property (acceptance criteria): the manifest edit is spliced
	// into whatever base content is PASSED IN -- there is no hidden local-file
	// dependency, so feeding the live base branch's content (which may already
	// carry a concurrently merged skill) preserves that concurrent entry.
	test("agent.yaml edit applies to the passed-in base content, preserving concurrent additions", () => {
		const staleSnapshot = ["name: incident-analyzer", "skills:", "  - existing-skill", ""].join("\n");
		const liveBase = [
			"name: incident-analyzer",
			"skills:",
			"  - existing-skill",
			"  - concurrently-merged-skill",
			"",
		].join("\n");
		const input = { skillName: "lag-correlation", annotations: ANNOTATIONS, body: BODY };

		const fromStale = buildSkillPrFiles(staleSnapshot, input);
		const fromLive = buildSkillPrFiles(liveBase, input);
		if (!fromStale.ok || !fromLive.ok) throw new Error("expected both builds to succeed");

		const liveManifest = fromLive.files[1]?.contents ?? "";
		expect(liveManifest).toContain("- concurrently-merged-skill");
		expect(liveManifest).toContain("- lag-correlation");
		// The stale snapshot demonstrably loses the concurrent entry -- which is why
		// the caller must fetch the base branch's live content, never a local copy.
		expect(fromStale.files[1]?.contents).not.toContain("- concurrently-merged-skill");
	});

	test("a manifest without a skills: list is a soft failure, not a throw", () => {
		const result = buildSkillPrFiles("name: incident-analyzer\n", {
			skillName: "lag-correlation",
			annotations: ANNOTATIONS,
			body: BODY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("agent.yaml edit failed");
	});

	test("a skill already listed in the manifest is a soft skip (second dedup layer)", () => {
		const already = ["name: incident-analyzer", "skills:", "  - lag-correlation", ""].join("\n");
		const result = buildSkillPrFiles(already, { skillName: "lag-correlation", annotations: ANNOTATIONS, body: BODY });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("already listed in agent.yaml");
	});
});

describe("buildSkillPrTitle / buildSkillPrBody (SIO-1346)", () => {
	test("title names the skill and the fixed learner agent", () => {
		expect(buildSkillPrTitle("lag-correlation")).toBe("Promote learned skill: lag-correlation (incident-analyzer)");
	});

	test("body carries provenance, the review checklist, and the merge-activation note", () => {
		const body = buildSkillPrBody("lag-correlation", ANNOTATIONS);
		expect(body).toContain("learned_from: ticket:OPS-123");
		expect(body).toContain("learned_at: 2026-08-01T10:00:00Z");
		expect(body).toContain("Review checklist:");
		expect(body).toContain("Merging this PR activates the skill");
	});
});
