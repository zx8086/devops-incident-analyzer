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

	// Live run 2026-09-18: the model sent include ["diffs","pipelines"] and GitLab answered
	// "Validation error: include cannot contain more than 1 items". The docs state the
	// limit ("Limited to one facet per call"); when the schema declares it, keep it.
	test("an array's item bounds are enforced, so a two-facet include is refused locally", () => {
		const shape = buildZodShapeFromJsonSchema({
			type: "object" as const,
			properties: {
				include: { ...GET_MERGE_REQUEST_SCHEMA.properties.include, maxItems: 1 },
				labels: { type: "array", items: { type: "string" }, minItems: 1 },
			},
		});
		expect(shape.include?.safeParse(["diffs"]).success).toBe(true);
		expect(shape.include?.safeParse(["diffs", "pipelines"]).success).toBe(false);
		expect(shape.labels?.safeParse([]).success).toBe(false);
		// Without a tool name there is nothing to look up, so a schema that declares no
		// bound gets none. SIO-1854 supplies the bound by TOOL, not by guessing from a key.
		const unbounded = buildZodShapeFromJsonSchema(GET_MERGE_REQUEST_SCHEMA);
		expect(unbounded.include?.safeParse(["diffs", "pipelines"]).success).toBe(true);
	});

	// SIO-1854. The regression this closes: SIO-1656 carried maxItems through faithfully,
	// but GitLab ENFORCES the one-facet limit without DECLARING it, so the bound never bound.
	// Measured in the SIO-1834 reflection window: 4 sessions, 2 of them after SIO-1656 shipped.
	// Note GET_MERGE_REQUEST_SCHEMA is the real upstream shape -- no maxItems anywhere in it.
	describe("caps GitLab enforces but does not declare", () => {
		test("the real upstream schema still refuses a two-facet include, once the tool is named", () => {
			const shape = buildZodShapeFromJsonSchema(GET_MERGE_REQUEST_SCHEMA, "get_merge_request");
			expect(shape.include?.safeParse(["commits"]).success).toBe(true);
			// The exact call GitLab answered with "include cannot contain more than 1 items".
			expect(shape.include?.safeParse(["diffs", "pipelines"]).success).toBe(false);
		});

		test("the prefixed tool name resolves too, since callers use either form", () => {
			const shape = buildZodShapeFromJsonSchema(GET_MERGE_REQUEST_SCHEMA, "gitlab_get_merge_request");
			expect(shape.include?.safeParse(["diffs", "pipelines"]).success).toBe(false);
		});

		test("get_pipeline carries the same one-facet limit", () => {
			const schema = {
				type: "object" as const,
				properties: { include: { type: "array", items: { type: "string", enum: ["jobs", "variables"] } } },
			};
			const shape = buildZodShapeFromJsonSchema(schema, "get_pipeline");
			expect(shape.include?.safeParse(["jobs"]).success).toBe(true);
			expect(shape.include?.safeParse(["jobs", "variables"]).success).toBe(false);
		});

		// The table must decay on its own: when GitLab starts declaring the bound, its
		// number wins, so a later upstream change cannot be silently overridden from here.
		test("an upstream-declared bound wins over the table", () => {
			const schema = {
				type: "object" as const,
				properties: {
					include: { ...GET_MERGE_REQUEST_SCHEMA.properties.include, maxItems: 3 },
				},
			};
			const shape = buildZodShapeFromJsonSchema(schema, "get_merge_request");
			expect(shape.include?.safeParse(["diffs", "commits", "notes"]).success).toBe(true);
			expect(shape.include?.safeParse(["diffs", "commits", "notes", "pipelines"]).success).toBe(false);
		});

		test("a tool with no known cap is untouched", () => {
			const schema = {
				type: "object" as const,
				properties: { include: { type: "array", items: { type: "string" } } },
			};
			const shape = buildZodShapeFromJsonSchema(schema, "list_projects");
			expect(shape.include?.safeParse(["a", "b", "c"]).success).toBe(true);
		});

		// Only the named key is capped: a sibling array on the same tool stays unbounded.
		test("a different array on a capped tool is unaffected", () => {
			const schema = {
				type: "object" as const,
				properties: {
					include: { type: "array", items: { type: "string" } },
					labels: { type: "array", items: { type: "string" } },
				},
			};
			const shape = buildZodShapeFromJsonSchema(schema, "get_merge_request");
			expect(shape.labels?.safeParse(["a", "b", "c"]).success).toBe(true);
			expect(shape.include?.safeParse(["a", "b"]).success).toBe(false);
		});
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
