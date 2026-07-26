// agent/src/normalizer-sanitize.test.ts
import { describe, expect, test } from "bun:test";
import { parseLlmJson } from "./llm-json.ts";
import {
	extractServiceCandidates,
	isServiceRecoveryEnabled,
	NormalizationSchema,
	sanitizeJsonControlChars,
} from "./normalizer.ts";

describe("sanitizeJsonControlChars (SIO-1220)", () => {
	// Regression: Claude Sonnet 5 echoed a pasted multi-line incident query verbatim into
	// a JSON string value without escaping the embedded newlines, producing malformed JSON
	// that JSON.parse rejects ("Bad control character in string literal" / "Unterminated
	// string"). Observed live: normalizeIncident failed, normalizedIncident stayed
	// undefined, and the downstream runbook selector then threw RunbookSelectionFallbackError
	// because severity was missing.
	test("escapes a raw newline embedded inside a JSON string value", () => {
		const malformed = `{"severity": "high", "extractedMetrics": [{"name": "error", "value": "Couldn't fetch seasons\nI/O error on GET request"}]}`;
		const sanitized = sanitizeJsonControlChars(malformed);
		const parsed = JSON.parse(sanitized);
		expect(parsed.extractedMetrics[0].value).toBe("Couldn't fetch seasons\nI/O error on GET request");
	});

	test("escapes raw carriage return and tab inside a string value", () => {
		const malformed = `{"a": "line1\r\nline2\ttabbed"}`;
		const parsed = JSON.parse(sanitizeJsonControlChars(malformed));
		expect(parsed.a).toBe("line1\r\nline2\ttabbed");
	});

	test("leaves already-valid JSON with escaped newlines unchanged in meaning", () => {
		const valid = `{"a": "line1\\nline2"}`;
		const parsed = JSON.parse(sanitizeJsonControlChars(valid));
		expect(parsed.a).toBe("line1\nline2");
	});

	test("does not touch whitespace outside string literals (formatting-only newlines)", () => {
		const pretty = `{\n  "severity": "high",\n  "affectedServices": []\n}`;
		const parsed = JSON.parse(sanitizeJsonControlChars(pretty));
		expect(parsed.severity).toBe("high");
	});

	test("preserves existing backslash-escapes (e.g. escaped quotes) without double-escaping", () => {
		const withEscape = `{"a": "she said \\"hi\\"\nthen left"}`;
		const parsed = JSON.parse(sanitizeJsonControlChars(withEscape));
		expect(parsed.a).toBe('she said "hi"\nthen left');
	});

	test("handles multiple string values each with embedded control characters", () => {
		const malformed = `{"a": "one\ntwo", "b": "three\rfour"}`;
		const parsed = JSON.parse(sanitizeJsonControlChars(malformed));
		expect(parsed.a).toBe("one\ntwo");
		expect(parsed.b).toBe("three\rfour");
	});
});

// SIO-1233: NormalizationSchema is all-.nullish(), so the drift that fails the entity extractor
// LOUDLY validates cleanly here and degrades in silence to serviceCount: 0. An empty focus then
// makes resolveIdentifiers a no-op and forces every findings card to filterMode "show-all".
describe("NormalizationSchema key aliases (SIO-1233)", () => {
	test.each([
		["affected_services", '{"affected_services":[{"name":"prana-order-service"}]}'],
		["time_window", '{"time_window":{"from":"2026-07-26T00:00:00Z","to":"2026-07-26T01:00:00Z"}}'],
		["extracted_metrics", '{"extracted_metrics":[{"name":"error rate","value":"15%"}]}'],
	])("maps the %s alias onto its canonical key", (label, body) => {
		const result = parseLlmJson(body, NormalizationSchema);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		if (label === "affected_services") expect(result.data.affectedServices?.[0]?.name).toBe("prana-order-service");
		if (label === "time_window") expect(result.data.timeWindow?.from).toBe("2026-07-26T00:00:00Z");
		if (label === "extracted_metrics") expect(result.data.extractedMetrics?.[0]?.name).toBe("error rate");
	});

	// IMPORTANT, and the reason the recovery pass exists: the single-key unwrap CANNOT help this
	// schema. Every field is .nullish(), so a container-key envelope validates VACUOUSLY -- zod
	// strips the unknown "incident" key and every field is legitimately absent. The parse
	// SUCCEEDS, so the failure-path unwrap never runs and the node gets a valid empty incident.
	//
	// That is deliberate, not an oversight: firing the unwrap on a SUCCESSFUL parse would change
	// behaviour at all 13 call sites (absence-judge.ts passes z.unknown(), which accepts anything
	// and would then unwrap every payload it is given). The mitigation for this shape is the
	// query-token recovery below, not the unwrap.
	test("does NOT unwrap a container envelope -- it parses vacuously (recovery covers it)", () => {
		const result = parseLlmJson('{"incident":{"severity":"critical"}}', NormalizationSchema);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data.severity).toBeUndefined();
			expect(result.data.affectedServices).toBeUndefined();
		}
	});

	// The end-to-end guarantee that actually matters: whatever shape the drift takes, a query
	// naming a service still produces a focus rather than an empty one.
	test("the vacuous-parse case is still recovered from the query", () => {
		expect(extractServiceCandidates("why is prana-order-service down")).toEqual(["prana-order-service"]);
	});

	// extractedMetrics[].name is free text -- a blanket snake_case rewrite would mangle it.
	test("does NOT rewrite snake_case inside metric names", () => {
		const result = parseLlmJson('{"extractedMetrics":[{"name":"consumer_lag","value":"10000"}]}', NormalizationSchema);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data.extractedMetrics?.[0]?.name).toBe("consumer_lag");
	});
});

describe("extractServiceCandidates (SIO-1233)", () => {
	test("picks multi-segment service names out of prose", () => {
		expect(extractServiceCandidates("why is prana-order-service failing")).toEqual(["prana-order-service"]);
	});

	test.each([
		["dotted names", "check orders.api now", ["orders.api"]],
		["underscored names", "check order_service now", ["order_service"]],
		["trailing punctuation stripped", "is prana-order-service down?", ["prana-order-service"]],
		["surrounding quotes stripped", 'the "prana-order-service" is down', ["prana-order-service"]],
	])("handles %s", (_label, query, expected) => {
		expect(extractServiceCandidates(query)).toEqual(expected);
	});

	test.each([
		["a bare single word", "why is checkout failing"],
		["a URL", "see https://grafana.internal/d/abc"],
		["an email", "ping simon@example.com"],
		["a host:port", "connect to db-host:5432"],
		["a semver version", "we deployed 1.2.3 yesterday"],
		["a file path", "check /var/log/app.log"],
		// CodeRabbit on PR #484: these three families satisfied SERVICE_TOKEN and slipped past
		// the original filters. Each one seeded a WRONG focus, which the design note above calls
		// strictly worse than an empty one -- so they are correctness cases, not cosmetics.
		["a pre-release version", "we deployed 1.2.3-rc1 yesterday"],
		["a v-prefixed version", "rolled back to v1.2.3"],
		["a dotted pre-release", "we deployed 2.0.0-beta.1"],
		["a bare log filename", "check app.log"],
		["a bare yaml filename", "look at config.yaml"],
		["a bare json filename", "dump.json is huge"],
		["a purely numeric token", "check 1-2-3 now"],
		["an IP address", "traffic from 10.0.0.1 spiked"],
	])("rejects %s", (_label, query) => {
		expect(extractServiceCandidates(query)).toEqual([]);
	});

	// The rejections above must not over-reach: these are real service names that merely
	// resemble the rejected shapes.
	test.each([
		["a v-prefixed service", "v2-api is down", ["v2-api"]],
		["a service with a digit suffix", "check s3-uploader", ["s3-uploader"]],
		["a dotted service that is not a filename", "orders.api is slow", ["orders.api"]],
	])("still accepts %s", (_label, query, expected) => {
		expect(extractServiceCandidates(query)).toEqual(expected);
	});

	// Infra vocabulary is service-SHAPED but never a service, and appears in incident prose
	// constantly. Seeding a focus from it would scope the whole investigation to a non-entity.
	test.each(["data-source", "merge-request", "time-window", "error-rate"])("stop-lists %s", (token) => {
		expect(extractServiceCandidates(`look at the ${token} please`)).toEqual([]);
	});

	test("caps at 3 candidates", () => {
		const query = "a-one b-two c-three d-four e-five";
		expect(extractServiceCandidates(query)).toEqual(["a-one", "b-two", "c-three"]);
	});

	test("deduplicates case-insensitively but keeps the ORIGINAL spelling", () => {
		// resolveIdentifiers probes datasources with the literal token, so casing must survive.
		expect(extractServiceCandidates("Prana-Order-Service and prana-order-service")).toEqual(["Prana-Order-Service"]);
	});

	test("returns empty for a query with no service-shaped token", () => {
		expect(extractServiceCandidates("is anything degraded right now")).toEqual([]);
	});
});

describe("isServiceRecoveryEnabled (SIO-1233)", () => {
	test("defaults ON when unset", () => {
		expect(isServiceRecoveryEnabled({})).toBe(true);
	});

	test.each([
		["false", false],
		["0", false],
		["true", true],
		["1", true],
	])("NORMALIZER_SERVICE_RECOVERY_ENABLED=%s -> %s", (value, expected) => {
		expect(isServiceRecoveryEnabled({ NORMALIZER_SERVICE_RECOVERY_ENABLED: value })).toBe(expected);
	});
});
