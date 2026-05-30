// agent/src/wiki/wiki.test.ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposeWikiUpdate } from "./ingest.ts";
import { lintWiki } from "./lint.ts";
import { extractWikiLinks, parseWikiPage } from "./page.ts";

describe("parseWikiPage", () => {
	test("parses frontmatter, body, and wiki-links", () => {
		const content = [
			"---",
			"sources: [knowledge/a.md]",
			"related: [other]",
			"updated: 2026-05-30T00:00:00.000Z",
			"---",
			"# Title",
			"See [[other]] and [[third|Third]].",
		].join("\n");
		const page = parseWikiPage("topic.md", content);
		expect(page.slug).toBe("topic");
		expect(page.hasFrontmatter).toBe(true);
		expect(page.frontmatter.sources).toEqual(["knowledge/a.md"]);
		expect(page.links).toEqual(["other", "third"]);
		expect(page.body).toContain("# Title");
	});

	test("page without frontmatter is flagged", () => {
		const page = parseWikiPage("x.md", "# Bare\nNo frontmatter.");
		expect(page.hasFrontmatter).toBe(false);
		expect(page.frontmatter).toEqual({});
	});

	test("rejects unknown frontmatter keys (strict)", () => {
		const content = ["---", "author: dev", "---", "body"].join("\n");
		expect(() => parseWikiPage("x.md", content)).toThrow();
	});

	test("extractWikiLinks handles aliases and multiples", () => {
		expect(extractWikiLinks("a [[one]] b [[two|Two]] c")).toEqual(["one", "two"]);
	});
});

describe("lintWiki", () => {
	function makeWiki(
		pages: Record<string, string>,
		indexMd?: string,
	): { pagePaths: string[]; indexMd?: string; dir: string } {
		const dir = mkdtempSync(join(tmpdir(), "wiki-lint-"));
		mkdirSync(join(dir, "pages"), { recursive: true });
		const pagePaths: string[] = [];
		for (const [name, content] of Object.entries(pages)) {
			const p = join(dir, "pages", name);
			writeFileSync(p, content);
			pagePaths.push(p);
		}
		return { pagePaths, indexMd, dir };
	}

	test("clean wiki reports ok", () => {
		const { pagePaths, dir } = makeWiki(
			{
				"a.md": "---\nsources: []\nupdated: 2026-01-01T00:00:00.000Z\n---\n# A\nSee [[b]].",
				"b.md": "---\nsources: []\nupdated: 2026-01-01T00:00:00.000Z\n---\n# B",
			},
			"# Index\n- [[a]]\n- [[b]]",
		);
		try {
			const result = lintWiki({ pagePaths, indexMd: "# Index\n- [[a]]\n- [[b]]" });
			expect(result.ok).toBe(true);
			expect(result.pageCount).toBe(2);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	test("flags a dead link", () => {
		const { pagePaths, dir } = makeWiki({
			"a.md": "---\nsources: []\nupdated: 2026-01-01T00:00:00.000Z\n---\n# A\nSee [[ghost]].",
		});
		try {
			const result = lintWiki({ pagePaths, indexMd: "# Index\n- [[a]]" });
			expect(result.ok).toBe(false);
			expect(result.issues.some((i) => i.kind === "dead_link")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	test("flags an orphan page and missing frontmatter", () => {
		const { pagePaths, dir } = makeWiki({
			"a.md": "# A\nNo frontmatter here.",
		});
		try {
			const result = lintWiki({ pagePaths, indexMd: "# Index\n(no entries)" });
			expect(result.issues.some((i) => i.kind === "orphan")).toBe(true);
			expect(result.issues.some((i) => i.kind === "missing_frontmatter")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});
});

describe("proposeWikiUpdate", () => {
	test("produces page + index + log proposals, never a direct write", () => {
		const proposals = proposeWikiUpdate({
			slug: "kafka-lag",
			title: "Kafka Consumer Lag",
			body: "Diagnose lag via [[service-topology]].",
			sources: ["knowledge/runbooks/kafka-consumer-lag.md"],
			related: ["service-topology"],
			summary: "diagnosing consumer lag",
			now: new Date("2026-05-30T12:00:00.000Z"),
		});
		expect(proposals.map((p) => p.path)).toEqual([
			"memory/wiki/pages/kafka-lag.md",
			"memory/wiki/index.md",
			"memory/wiki/log.md",
		]);
		const page = proposals[0]?.contents ?? "";
		expect(page).toContain("sources:");
		expect(page).toContain("# Kafka Consumer Lag");
		expect(page).toContain("[[service-topology]]");
		// round-trips through the parser
		const parsed = parseWikiPage("kafka-lag.md", page);
		expect(parsed.frontmatter.related).toEqual(["service-topology"]);
		expect(parsed.frontmatter.updated).toBe("2026-05-30T12:00:00.000Z");
	});

	test("upserts an existing index entry rather than duplicating", () => {
		const proposals = proposeWikiUpdate({
			slug: "kafka-lag",
			title: "Kafka Consumer Lag",
			body: "body",
			sources: [],
			summary: "new summary",
			currentIndexMd: "# Wiki Index\n\n- [[kafka-lag]] -- old summary\n",
			now: new Date("2026-05-30T12:00:00.000Z"),
		});
		const index = proposals[1]?.contents ?? "";
		expect(index).toContain("new summary");
		expect(index).not.toContain("old summary");
		// only one kafka-lag line
		expect(index.split("[[kafka-lag]]").length - 1).toBe(1);
	});
});
