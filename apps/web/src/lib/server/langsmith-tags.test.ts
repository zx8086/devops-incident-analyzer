// apps/web/src/lib/server/langsmith-tags.test.ts
import { describe, expect, test } from "bun:test";
import { buildLangSmithTags } from "./langsmith-tags.ts";

describe("buildLangSmithTags", () => {
	test("emits chat + thread tag with no datasources", () => {
		const tags = buildLangSmithTags({ threadId: "abc" });
		expect(tags).toEqual(["chat", "thread:abc", "datasources:auto"]);
	});

	test("includes sorted datasources tag", () => {
		const tags = buildLangSmithTags({ threadId: "abc", dataSources: ["kafka", "elastic"] });
		expect(tags).toContain("datasources:elastic,kafka");
	});

	test("appends follow-up tag when isFollowUp is true", () => {
		const tags = buildLangSmithTags({ threadId: "abc", isFollowUp: true });
		expect(tags).toContain("follow-up");
	});

	test("appends resumed tag when resumed is true", () => {
		const tags = buildLangSmithTags({ threadId: "abc", resumed: true });
		expect(tags).toContain("resumed");
	});
});
