// agent/src/skill-promote.test.ts
import { describe, expect, test } from "bun:test";
import { SkillFrontmatterSchema } from "@devops-agent/gitagent-bridge";
import type { AnnotationMap } from "@devops-agent/shared";
import { parse } from "yaml";
import {
	buildSkillFrontmatter,
	parseSkillFactBody,
	renderSkillMarkdown,
	type SkillScaffoldInput,
} from "./skill-promote.ts";

// A representative proposal fact as crystallized by SIO-1015 (annotations are
// always strings; the body carries the labelled prose buildSkillFactText writes).
const ANNOTATIONS: AnnotationMap = {
	kind: "skill",
	skill_name: "lag-correlation",
	task_category: "lag-correlation",
	confidence: "0.5",
	learned_from: "thread:abc-123",
	learned_at: "2026-06-26T01:32:41Z",
	usage_count: "0",
	success_count: "0",
	failure_count: "0",
};

const LABELLED_BODY = [
	"Proposed skill: lag-correlation - Correlate Kafka consumer lag with downstream Elasticsearch error spikes.",
	"When to use: A lag spike coincides with a downstream error rate increase.",
	"Procedure: Pull consumer-group lag from Kafka, then error rate from Elastic over the same window, then align timestamps.",
].join("\n");

describe("parseSkillFactBody (SIO-1017)", () => {
	test("splits a labelled body into description / when_to_use / procedure", () => {
		const parsed = parseSkillFactBody(LABELLED_BODY);
		expect(parsed.description).toBe("Correlate Kafka consumer lag with downstream Elasticsearch error spikes.");
		expect(parsed.whenToUse).toBe("A lag spike coincides with a downstream error rate increase.");
		expect(parsed.procedure).toContain("Pull consumer-group lag from Kafka");
	});

	test("falls back to the whole body as procedure when markers are absent (agent-memory paraphrase)", () => {
		// After agent-memory paraphrases on ingest, the literal markers are stripped.
		const paraphrased =
			"This skill correlates Kafka consumer lag with downstream Elasticsearch error spikes by aligning their timelines.";
		const parsed = parseSkillFactBody(paraphrased);
		// No marker -> the whole text lands in procedure so nothing is lost; description
		// falls back to the first sentence.
		expect(parsed.procedure).toBe(paraphrased);
		expect(parsed.description).toBe(
			"This skill correlates Kafka consumer lag with downstream Elasticsearch error spikes by aligning their timelines.",
		);
		expect(parsed.whenToUse).toBeUndefined();
	});
});

describe("buildSkillFrontmatter (SIO-1017)", () => {
	test("converts string annotations into typed frontmatter that passes SkillFrontmatterSchema", () => {
		const fm = buildSkillFrontmatter(ANNOTATIONS, {
			description: "Correlate Kafka consumer lag with downstream Elasticsearch error spikes.",
		});
		// Typed, not strings.
		expect(fm.name).toBe("lag-correlation");
		expect(fm.confidence).toBe(0.5);
		expect(fm.usage_count).toBe(0);
		expect(fm.success_count).toBe(0);
		expect(fm.failure_count).toBe(0);
		expect(fm.task_category).toBe("lag-correlation");
		expect(fm.learned_from).toBe("thread:abc-123");
		expect(fm.learned_at).toBe("2026-06-26T01:32:41Z");
		// The authoritative consumer (the loader) must accept it without throwing.
		expect(() => SkillFrontmatterSchema.parse(fm)).not.toThrow();
	});

	test("omits blank / absent annotation keys rather than emitting empty strings", () => {
		const sparse: AnnotationMap = { kind: "skill", skill_name: "thin", confidence: "0.5" };
		const fm = buildSkillFrontmatter(sparse, { description: "A thin skill." });
		expect(fm.name).toBe("thin");
		expect("learned_from" in fm).toBe(false);
		expect("task_category" in fm).toBe(false);
		expect(() => SkillFrontmatterSchema.parse(fm)).not.toThrow();
	});

	test("throws on a malformed confidence annotation (out of [0,1])", () => {
		const bad: AnnotationMap = { ...ANNOTATIONS, confidence: "1.7" };
		expect(() => buildSkillFrontmatter(bad, { description: "x" })).toThrow();
	});
});

describe("renderSkillMarkdown (SIO-1017)", () => {
	const input: SkillScaffoldInput = {
		annotations: ANNOTATIONS,
		body: LABELLED_BODY,
	};

	test("produces a SKILL.md whose frontmatter round-trips through the loader's parse + schema", () => {
		const md = renderSkillMarkdown(input);
		expect(md.startsWith("---\n")).toBe(true);
		// Extract the frontmatter block the same way parseSkillFrontmatter does.
		const afterOpening = md.indexOf("\n") + 1;
		const closing = md.slice(afterOpening).match(/^---\r?\n?/m);
		expect(closing?.index).toBeGreaterThan(0);
		const frontmatterYaml = md.slice(afterOpening, afterOpening + (closing?.index ?? 0));
		const reparsed = SkillFrontmatterSchema.parse(parse(frontmatterYaml));
		expect(reparsed.name).toBe("lag-correlation");
		expect(reparsed.confidence).toBe(0.5);
		expect(reparsed.usage_count).toBe(0);
	});

	test("includes a DRAFT banner and the procedure section", () => {
		const md = renderSkillMarkdown(input);
		expect(md).toContain("DRAFT");
		expect(md.toLowerCase()).toContain("review before");
		expect(md).toContain("## Procedure");
		expect(md).toContain("Pull consumer-group lag from Kafka");
	});

	test("includes a When to use section when the body had one", () => {
		const md = renderSkillMarkdown(input);
		expect(md).toContain("## When to use");
		expect(md).toContain("A lag spike coincides");
	});
});
