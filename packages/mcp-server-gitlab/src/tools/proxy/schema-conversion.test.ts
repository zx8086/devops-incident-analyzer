// src/tools/proxy/schema-conversion.test.ts
//
// SIO-1656: the discovered-schema conversion. GitLab owns these tool schemas
// (they arrive over /api/v4/mcp at boot), so this server's job is to reproduce
// the upstream contract faithfully -- anything it widens becomes a call the
// model can make and GitLab will reject.
import { describe, expect, test } from "bun:test";
import { buildZodShapeFromJsonSchema } from "./index.ts";

// The real upstream shape for get_merge_request, per
// https://docs.gitlab.com/user/model_context_protocol/mcp_server_tools/
const GET_MERGE_REQUEST_SCHEMA = {
	type: "object" as const,
	properties: {
		id: { type: "string", description: "Project ID or URL-encoded path" },
		merge_request_iid: { type: "integer", description: "Internal MR id" },
		include: {
			type: "array",
			description: "Associated facets to return with the merge request.",
			items: { type: "string", enum: ["diffs", "commits", "notes", "pipelines", "discussions"] },
		},
		diff_detail: { type: "string", description: "Diff detail", enum: ["stats", "full_patch"] },
	},
	required: ["id", "merge_request_iid"],
};

describe("SIO-1656 array parameters on proxied tools", () => {
	// The regression: `include` fell through to z.unknown(), so the local schema
	// accepted the model's guess and GitLab answered "Validation error: include
	// is invalid" mid-investigation.
	test("an array parameter is an array, not unknown", () => {
		const shape = buildZodShapeFromJsonSchema(GET_MERGE_REQUEST_SCHEMA);
		expect(shape.include?.safeParse(["commits"]).success).toBe(true);
		// Previously passed because everything passed.
		expect(shape.include?.safeParse("commits").success).toBe(false);
		expect(shape.include?.safeParse(42).success).toBe(false);
	});

	test("the element enum is enforced, so an invented facet is refused locally", () => {
		const shape = buildZodShapeFromJsonSchema(GET_MERGE_REQUEST_SCHEMA);
		for (const valid of ["diffs", "commits", "notes", "pipelines", "discussions"]) {
			expect(shape.include?.safeParse([valid]).success).toBe(true);
		}
		// The exact failure mode from the live run: a plausible-looking value that
		// upstream does not accept.
		expect(shape.include?.safeParse(["changes"]).success).toBe(false);
		expect(shape.include?.safeParse(["diffs", "bogus"]).success).toBe(false);
	});

	test("a scalar enum is enforced too", () => {
		const shape = buildZodShapeFromJsonSchema(GET_MERGE_REQUEST_SCHEMA);
		expect(shape.diff_detail?.safeParse("stats").success).toBe(true);
		expect(shape.diff_detail?.safeParse("full_patch").success).toBe(true);
		expect(shape.diff_detail?.safeParse("everything").success).toBe(false);
	});

	test("an array without `items` still accepts an array (pre-!211286 tools)", () => {
		// GitLab shipped array params with no `items` before gitlab-org/gitlab!211286.
		const shape = buildZodShapeFromJsonSchema({
			type: "object" as const,
			properties: { labels: { type: "array", description: "Labels" } },
		});
		expect(shape.labels?.safeParse(["a", "b"]).success).toBe(true);
		expect(shape.labels?.safeParse("a").success).toBe(false);
	});

	test("required vs optional is preserved", () => {
		const shape = buildZodShapeFromJsonSchema(GET_MERGE_REQUEST_SCHEMA);
		expect(shape.id?.safeParse(undefined).success).toBe(false);
		expect(shape.include?.safeParse(undefined).success).toBe(true);
	});

	// Pre-existing behaviour that must not regress: GitLab ids arrive as numbers
	// from some callers but the schema declares string.
	test("string parameters still coerce a number id", () => {
		const shape = buildZodShapeFromJsonSchema(GET_MERGE_REQUEST_SCHEMA);
		expect(shape.id?.safeParse(123).success).toBe(true);
		expect(shape.merge_request_iid?.safeParse(7).success).toBe(true);
	});
});
