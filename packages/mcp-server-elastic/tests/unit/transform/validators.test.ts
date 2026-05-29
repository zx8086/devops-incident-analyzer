// tests/unit/transform/validators.test.ts
// SIO-830: Zod validator contract tests for the transform tool family.
//
// These tests cover what the SDK does not — the validator-side guards that
// prevent malformed input from reaching `client.transform.*`. The SDK call
// layer is intentionally not covered here.

import { describe, expect, test } from "bun:test";
import { deleteTransformValidator } from "../../../src/tools/transform/delete_transform.js";
import { getTransformValidator } from "../../../src/tools/transform/get_transform.js";
import { getTransformNotificationsValidator } from "../../../src/tools/transform/get_transform_notifications.js";
import { getTransformStatsValidator } from "../../../src/tools/transform/get_transform_stats.js";
import { listTransformsValidator } from "../../../src/tools/transform/list_transforms.js";
import { previewTransformValidator } from "../../../src/tools/transform/preview_transform.js";
import { putTransformValidator } from "../../../src/tools/transform/put_transform.js";
import { startTransformValidator } from "../../../src/tools/transform/start_transform.js";
import { stopTransformValidator } from "../../../src/tools/transform/stop_transform.js";
import { updateTransformValidator } from "../../../src/tools/transform/update_transform.js";

const validPivot = {
	transformId: "my-transform",
	source: { index: "src-*" },
	dest: { index: "dst" },
	pivot: {
		group_by: { svc: { terms: { field: "service.name" } } },
		aggregations: { c: { value_count: { field: "_id" } } },
	},
};

const validLatest = {
	transformId: "my-transform",
	source: { index: "src-*" },
	dest: { index: "dst" },
	latest: { unique_key: ["entity"], sort: "@timestamp" },
};

describe("putTransformValidator", () => {
	test("accepts a valid pivot transform", () => {
		expect(() => putTransformValidator.parse(validPivot)).not.toThrow();
	});

	test("accepts a valid latest transform", () => {
		expect(() => putTransformValidator.parse(validLatest)).not.toThrow();
	});

	test("rejects when both pivot and latest are set", () => {
		expect(() =>
			putTransformValidator.parse({ ...validPivot, latest: { unique_key: ["x"], sort: "@timestamp" } }),
		).toThrow(/Exactly one of `pivot` or `latest`/);
	});

	test("rejects when neither pivot nor latest is set", () => {
		expect(() =>
			putTransformValidator.parse({ transformId: "x", source: { index: "s" }, dest: { index: "d" } }),
		).toThrow(/Exactly one of `pivot` or `latest`/);
	});

	test("rejects missing source.index", () => {
		expect(() =>
			putTransformValidator.parse({ ...validPivot, source: { query: { match_all: {} } } as never }),
		).toThrow();
	});

	test("rejects missing dest.index", () => {
		expect(() => putTransformValidator.parse({ ...validPivot, dest: {} as never })).toThrow();
	});

	test("rejects transformId longer than 64 chars", () => {
		expect(() => putTransformValidator.parse({ ...validPivot, transformId: "a".repeat(65) })).toThrow();
	});

	test("rejects transformId with uppercase letters", () => {
		expect(() => putTransformValidator.parse({ ...validPivot, transformId: "My-Transform" })).toThrow();
	});

	test("rejects transformId starting with hyphen", () => {
		expect(() => putTransformValidator.parse({ ...validPivot, transformId: "-bad" })).toThrow();
	});

	test("accepts single-character transformId (ES doc has no minimum length)", () => {
		expect(() => putTransformValidator.parse({ ...validPivot, transformId: "a" })).not.toThrow();
		expect(() => putTransformValidator.parse({ ...validPivot, transformId: "1" })).not.toThrow();
	});

	test("rejects single-character non-alphanumeric transformId", () => {
		expect(() => putTransformValidator.parse({ ...validPivot, transformId: "-" })).toThrow();
		expect(() => putTransformValidator.parse({ ...validPivot, transformId: "_" })).toThrow();
	});

	test("accepts settings.num_failure_retries=-1 (ES: retry indefinitely)", () => {
		expect(() => putTransformValidator.parse({ ...validPivot, settings: { num_failure_retries: -1 } })).not.toThrow();
	});

	test("rejects settings.num_failure_retries > 100 (ES cap)", () => {
		expect(() => putTransformValidator.parse({ ...validPivot, settings: { num_failure_retries: 101 } })).toThrow();
	});

	test("rejects settings.num_failure_retries < -1", () => {
		expect(() => putTransformValidator.parse({ ...validPivot, settings: { num_failure_retries: -2 } })).toThrow();
	});

	test("accepts array of source indices", () => {
		expect(() => putTransformValidator.parse({ ...validPivot, source: { index: ["a", "b", "c"] } })).not.toThrow();
	});

	test("accepts retention_policy and sync.time", () => {
		const withExtras = {
			...validPivot,
			frequency: "1m",
			sync: { time: { field: "@timestamp", delay: "60s" } },
			retention_policy: { time: { field: "@timestamp", max_age: "30d" } },
			settings: { max_page_search_size: 500, docs_per_second: 1000 },
		};
		expect(() => putTransformValidator.parse(withExtras)).not.toThrow();
	});

	test("rejects max_page_search_size out of range", () => {
		expect(() => putTransformValidator.parse({ ...validPivot, settings: { max_page_search_size: 9 } })).toThrow();
		expect(() => putTransformValidator.parse({ ...validPivot, settings: { max_page_search_size: 65537 } })).toThrow();
	});
});

describe("startTransformValidator", () => {
	test("accepts minimal valid input", () => {
		expect(() => startTransformValidator.parse({ transformId: "x" })).not.toThrow();
	});

	test("accepts timeout and fromTimestamp", () => {
		expect(() =>
			startTransformValidator.parse({ transformId: "x", timeout: "5m", fromTimestamp: "now-30d" }),
		).not.toThrow();
	});

	test("rejects empty transformId", () => {
		expect(() => startTransformValidator.parse({ transformId: "" })).toThrow();
	});
});

describe("stopTransformValidator", () => {
	test("accepts force + waitForCompletion + allowNoMatch", () => {
		expect(() =>
			stopTransformValidator.parse({ transformId: "_all", force: true, waitForCompletion: false, allowNoMatch: true }),
		).not.toThrow();
	});

	test("rejects empty transformId", () => {
		expect(() => stopTransformValidator.parse({ transformId: "" })).toThrow();
	});
});

describe("deleteTransformValidator", () => {
	test("accepts minimal input", () => {
		expect(() => deleteTransformValidator.parse({ transformId: "x" })).not.toThrow();
	});

	test("accepts force + deleteDestIndex", () => {
		expect(() =>
			deleteTransformValidator.parse({ transformId: "x", force: true, deleteDestIndex: true }),
		).not.toThrow();
	});

	test("rejects empty transformId", () => {
		expect(() => deleteTransformValidator.parse({ transformId: "" })).toThrow();
	});
});

describe("getTransformValidator", () => {
	test("accepts omitted transformId (list-mode)", () => {
		expect(() => getTransformValidator.parse({})).not.toThrow();
	});

	test("accepts wildcards", () => {
		expect(() => getTransformValidator.parse({ transformId: "mulesoft-*" })).not.toThrow();
	});

	test("rejects size > 1000", () => {
		expect(() => getTransformValidator.parse({ size: 1001 })).toThrow();
	});

	test("rejects negative from", () => {
		expect(() => getTransformValidator.parse({ from: -1 })).toThrow();
	});
});

describe("getTransformStatsValidator", () => {
	test("requires transformId (unlike getTransform)", () => {
		expect(() => getTransformStatsValidator.parse({})).toThrow();
	});

	test("accepts _all", () => {
		expect(() => getTransformStatsValidator.parse({ transformId: "_all" })).not.toThrow();
	});
});

describe("listTransformsValidator", () => {
	test("accepts no args", () => {
		expect(() => listTransformsValidator.parse({})).not.toThrow();
	});

	test("rejects size > 1000", () => {
		expect(() => listTransformsValidator.parse({ size: 1500 })).toThrow();
	});
});

describe("updateTransformValidator", () => {
	test("accepts partial update", () => {
		expect(() =>
			updateTransformValidator.parse({ transformId: "x", settings: { docs_per_second: 500 } }),
		).not.toThrow();
	});

	test("accepts retention_policy: null (removal)", () => {
		expect(() => updateTransformValidator.parse({ transformId: "x", retention_policy: null })).not.toThrow();
	});

	test("rejects empty transformId", () => {
		expect(() => updateTransformValidator.parse({ transformId: "" })).toThrow();
	});

	test("rejects source object without index (must be present when source provided)", () => {
		expect(() =>
			updateTransformValidator.parse({ transformId: "x", source: { query: { match_all: {} } } as never }),
		).toThrow();
	});

	test("accepts source.index alongside source.query", () => {
		expect(() =>
			updateTransformValidator.parse({ transformId: "x", source: { index: "s", query: { match_all: {} } } }),
		).not.toThrow();
	});

	test("accepts settings.num_failure_retries=-1 / 100; rejects 101 and -2", () => {
		expect(() =>
			updateTransformValidator.parse({ transformId: "x", settings: { num_failure_retries: -1 } }),
		).not.toThrow();
		expect(() =>
			updateTransformValidator.parse({ transformId: "x", settings: { num_failure_retries: 100 } }),
		).not.toThrow();
		expect(() =>
			updateTransformValidator.parse({ transformId: "x", settings: { num_failure_retries: 101 } }),
		).toThrow();
		expect(() => updateTransformValidator.parse({ transformId: "x", settings: { num_failure_retries: -2 } })).toThrow();
	});
});

describe("previewTransformValidator", () => {
	test("accepts preview of existing transform", () => {
		expect(() => previewTransformValidator.parse({ transformId: "existing" })).not.toThrow();
	});

	test("accepts preview of new pivot config", () => {
		expect(() =>
			previewTransformValidator.parse({
				source: { index: "src" },
				pivot: { group_by: {}, aggregations: {} },
			}),
		).not.toThrow();
	});

	test("rejects empty body (no transformId, no source)", () => {
		expect(() => previewTransformValidator.parse({})).toThrow();
	});

	test("rejects mixing transformId with body fields", () => {
		expect(() => previewTransformValidator.parse({ transformId: "x", source: { index: "s" }, pivot: {} })).toThrow();
	});

	test("rejects mixing transformId with only dest", () => {
		expect(() => previewTransformValidator.parse({ transformId: "x", dest: { index: "d" } })).toThrow();
	});

	test("rejects mixing transformId with only description", () => {
		expect(() => previewTransformValidator.parse({ transformId: "x", description: "hi" })).toThrow();
	});

	test("rejects mixing transformId with only frequency", () => {
		expect(() => previewTransformValidator.parse({ transformId: "x", frequency: "1m" })).toThrow();
	});

	test("rejects mixing transformId with only settings", () => {
		expect(() => previewTransformValidator.parse({ transformId: "x", settings: { foo: 1 } })).toThrow();
	});

	test("rejects new config with neither pivot nor latest", () => {
		expect(() => previewTransformValidator.parse({ source: { index: "s" } })).toThrow();
	});
});

describe("getTransformNotificationsValidator", () => {
	test("accepts no args", () => {
		expect(() => getTransformNotificationsValidator.parse({})).not.toThrow();
	});

	test("accepts level filter", () => {
		expect(() => getTransformNotificationsValidator.parse({ level: "error" })).not.toThrow();
	});

	test("rejects invalid level", () => {
		expect(() => getTransformNotificationsValidator.parse({ level: "fatal" })).toThrow();
	});

	test("rejects size > 1000", () => {
		expect(() => getTransformNotificationsValidator.parse({ size: 1500 })).toThrow();
	});
});
