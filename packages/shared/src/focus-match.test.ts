// packages/shared/src/focus-match.test.ts
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

	// SIO-1210: PascalCase/camelCase focus tokens (e.g. from a ticket title or
	// normalized entity name) must tokenize on the same word boundaries as their
	// hyphenated infra-name counterparts, or token-overlap matching silently misses.
	test("splits PascalCase into the same tokens as its hyphenated form", () => {
		expect(tokenize("NotificationService")).toEqual(tokenize("notification-service"));
	});
	test("splits camelCase into the same tokens as its hyphenated form", () => {
		expect(tokenize("notificationWebhookService")).toEqual(tokenize("notification-webhook-service"));
	});
	test("PascalCase multi-word focus overlaps a hyphenated multi-word name", () => {
		expect(tokenize("NotificationWebhookService")).toEqual(new Set(["notification", "webhook"]));
	});

	// CodeRabbit (PR #467): a single lower/digit->upper split leaves acronym runs
	// glued to the following word (APIGateway -> "apigateway", no split before
	// "Gateway"). The second pass splits acronym->word boundaries too.
	test("splits an acronym-prefixed PascalCase name at the acronym/word boundary", () => {
		expect(tokenize("APIGateway")).toEqual(tokenize("api-gateway"));
	});
	test("splits an acronym-suffixed PascalCase name at the word/acronym boundary", () => {
		expect(tokenize("NotificationHTTPService")).toEqual(tokenize("notification-http-service"));
	});

	// SIO-1284: five call sites pass free prose rather than an identifier (the gitlab,
	// aws-alarm, atlassian and orbit extractors, plus rules.ts). Without \s in the split
	// class a title collapsed into a single token -- "Add retry to SAP draft order sink"
	// yielded one 29-char string, so the word `order` was invisible to token overlap.
	test("splits prose on whitespace into discrete word tokens", () => {
		// `sink` is absent because SUFFIX_PATTERN strips it at end-of-string during
		// normalize() -- same rule that applies to identifiers, not a whitespace artifact.
		expect(tokenize("Add retry to SAP draft order sink")).toEqual(new Set(["retry", "draft", "order"]));
	});
	test("identifier tokenization is unaffected by the whitespace split", () => {
		// No whitespace in these, so they must tokenize exactly as before.
		expect(tokenize("pim-sink-articles")).toEqual(new Set(["sink", "article"]));
		expect(tokenize("eu-oit-prd-order-service")).toEqual(new Set(["order"]));
		expect(tokenize("orders-service-prd")).toEqual(new Set(["order", "service"]));
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

	// SIO-1103 (CodeRabbit): the FUZZY substring path must also honour MIN_TOKEN_LENGTH.
	test("short focus below min length does not fuzzy-substring-match a longer name", () => {
		// "cat" (norm "cat", len 3) is a substring of "catalog" but must NOT scope it in.
		expect(matchesFocus("catalog-service", ["cat"])).toBe(false);
		// but an EXACT normalized match is always honoured, even when short.
		expect(matchesFocus("cat", ["cat"])).toBe(true);
		// and a long enough focus still fuzzy-matches as before.
		expect(matchesFocus("catalog-service", ["catalog"])).toBe(true);
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

	// SIO-1210: run 0e222680 -- focus token "NotificationService" (PascalCase, from
	// a normalized incident entity) failed to match real ECS service names
	// "notification-service" / "notification-webhook-service" (hyphenated), so the
	// network baseline silently discarded the estate's only real candidates.
	test("PascalCase focus token matches its hyphenated ECS service-name equivalent", () => {
		expect(matchesFocus("notification-service", ["NotificationService"])).toBe(true);
		expect(matchesFocus("notification-webhook-service", ["NotificationService"])).toBe(true);
	});
	test("camelCase focus token matches its hyphenated equivalent", () => {
		expect(matchesFocus("notification-webhook-service", ["notificationWebhookService"])).toBe(true);
	});
	test("PascalCase focus token still rejects an unrelated hyphenated name", () => {
		expect(matchesFocus("billing-service", ["NotificationService"])).toBe(false);
	});

	// SIO-1284: live run 000c83df -- the GitLab card logged `droppedAll: true` (5 raw, 0
	// kept) because extractors/gitlab.ts matches on prose (MR title + description) and
	// tokenize() did not split on whitespace, collapsing a whole title into one token.
	test("prose containing a focus word matches (whitespace is a token boundary)", () => {
		const focus = ["prana-order-service"];
		expect(matchesFocus("Add retry to SAP draft order sink", focus)).toBe(true);
		expect(matchesFocus("Fix season validation for archived order items", focus)).toBe(true);
	});
	test("prose without any focus word is still rejected", () => {
		const focus = ["prana-order-service"];
		expect(matchesFocus("chore: bump dependencies", focus)).toBe(false);
		expect(matchesFocus("Refactor payment gateway timeout", focus)).toBe(false);
		expect(matchesFocus("Fix flaky test in billing module", focus)).toBe(false);
	});
	// The whitespace split must not loosen identifier matching -- these are the shapes the
	// SIO-1268 ECS ledger and SIO-1261 gitlab probe depend on.
	test("identifier matching is unchanged by the whitespace split", () => {
		const focus = ["prana-order-service"];
		expect(matchesFocus("order-service", focus)).toBe(true);
		expect(matchesFocus("eu-oit-prd-order-service", focus)).toBe(true);
		expect(matchesFocus("orders-service-prd", focus)).toBe(true);
		expect(matchesFocus("billing-service", focus)).toBe(false);
		// A slash-separated path does NOT match -- `/` is not in the split class, so this
		// tokenizes to one "pvhcorp/b2b/oit/order" token. Pre-existing behaviour, verified
		// unchanged by this fix; call sites needing it extract the last segment first
		// (cf. ecsLastSegment in sub-agent-loop-guard.ts).
		expect(matchesFocus("pvhcorp/b2b/oit/order-service", focus)).toBe(false);
	});
});
