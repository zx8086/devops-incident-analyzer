// packages/agent/src/correlation/focus-match.test.ts
import { describe, expect, test } from "bun:test";
import { matchesFocus, normalize, tokenize } from "./focus-match.ts";

describe("normalize", () => {
	test("lowercases and strips service suffixes iteratively", () => {
		expect(normalize("Notifications-Service-Consumer")).toBe("notification");
		expect(normalize("orders-service-prod")).toBe("order");
	});
	test("singularizes trailing s", () => {
		expect(normalize("prices")).toBe("price");
	});
	test("suffix-only names do not collapse to empty (fall back to lowercased original)", () => {
		// SIO-1030: "prod-service" strips -service -> "prod" -> strips prod -> ""; the
		// guard must return the lowercased original instead so the name still compares.
		expect(normalize("prod-service")).toBe("prod-service");
		expect(normalize("svc-service")).toBe("svc-service");
		expect(normalize("service")).toBe("service");
	});
});

describe("tokenize", () => {
	test("keeps tokens of length >= 4, depluralised (suffix stripped only at end of string)", () => {
		// `sink` survives here because SUFFIX_PATTERN is anchored to the end of the
		// whole string, so a mid-string `sink` token is not stripped; `pim` (3 chars)
		// is dropped by the length>=4 filter; `articles` is depluralised to `article`.
		expect(tokenize("pim-sink-articles")).toEqual(new Set(["sink", "article"]));
	});
	test("drops short tokens (< 4 chars)", () => {
		// "api" is length 3 -> dropped; nothing survives.
		expect(tokenize("api")).toEqual(new Set());
	});
});

describe("matchesFocus", () => {
	test("GUARDRAIL: empty focus matches everything (show-all)", () => {
		expect(matchesFocus("anything-at-all", [])).toBe(true);
		expect(matchesFocus("", [])).toBe(true);
	});

	test("empty haystack with a focus never matches", () => {
		expect(matchesFocus("", ["prices-api-v2-service"])).toBe(false);
	});

	test("exact / normalized service name matches", () => {
		expect(matchesFocus("prices-api-v2-service", ["prices-api-v2-service"])).toBe(true);
	});

	test("plural vs singular matches", () => {
		expect(matchesFocus("notifications-service", ["notification-service"])).toBe(true);
	});

	test("suffix-stripped fuzzy match (consumer group id vs service)", () => {
		expect(matchesFocus("orders-service-consumer", ["orders-service"])).toBe(true);
	});

	test("token-overlap match on a >=4 char token", () => {
		expect(matchesFocus("aws/ecs prices-api-v2-service CPUUtilization", ["prices-api-v2-service"])).toBe(true);
	});

	test("short-token no-false-match: focus 'api' must NOT match unrelated names", () => {
		// This is the crux of the strict filter: a 3-char focus token can't scope in
		// everything. "api" is dropped by the length>=4 filter, and the normalized
		// substring check ("api" in "authentication") is guarded by the same tokenize.
		expect(matchesFocus("authentication-service-CPU-Utilization", ["api"])).toBe(false);
	});

	test("unrelated service is dropped", () => {
		expect(matchesFocus("bitly-service-Memory-Utilization", ["prices-api-v2-service"])).toBe(false);
	});

	test("any-of: matches if any focus service matches", () => {
		expect(matchesFocus("orders-service-sink", ["prices-api-v2-service", "orders-service"])).toBe(true);
	});

	test("suffix-only names do not produce false negatives or false positives", () => {
		// SIO-1030 regression: before the normalize empty-collapse guard,
		// normalize("prod-service") === "" made a "prod-service" haystack match every
		// focus (false positive) and a "prod-service" focus match nothing (false negative).
		expect(matchesFocus("prod-service", ["orders-service"])).toBe(false);
		expect(matchesFocus("orders-service", ["prod-service"])).toBe(false);
		// ...but two genuinely-equal suffix-only names still match literally.
		expect(matchesFocus("prod-service", ["prod-service"])).toBe(true);
	});
});
