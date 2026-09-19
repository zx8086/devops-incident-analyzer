// tests/ftsTools.test.ts
//
// SIO-1823: every fixture below is a REAL shape captured from the live Capella cluster
// before the tools were written, not one invented to match the code. The captures that
// mattered:
//
//   cluster getAllIndexes() -> 8 indexes, two kinds:
//     { name: "default.styles.stylesIndex08052025", sourceName: "default", type: "fulltext-index" }
//     { name: "default.styles.stylesIndexAlias",    sourceName: "",        type: "fulltext-alias" }
//   scope("styles").searchIndexes().getAllIndexes() -> the SAME indexes under BARE names
//   cluster.search("stylesIndex08052025", ...)      -> IndexNotFoundError
//   scope("styles").search("stylesIndex08052025",...) -> OK
//   one index reported metrics.total_rows = 692316
//   diagnostics() -> { services: { kv: [{ state: 2, last_activity_us: 0, ... }] } }
//
// The alias' empty sourceName and the bare-vs-dotted naming are the two facts a
// hand-written fake would have gotten wrong, and both change tool behaviour.

import { describe, expect, test } from "bun:test";
import { summarizeFtsIndex } from "../src/lib/ftsIndexes";
import { decodeDiagnosticsReport } from "../src/tools/getClusterDiagnosticsReport";
import { DEFAULT_FTS_LIMIT, MAX_FTS_LIMIT, resolveFtsLimit } from "../src/tools/runFtsQuery";

// Captured verbatim (params/planParams elided -- they run to thousands of lines, which is
// itself why capella_list_fts_indexes returns a summary instead of the definition).
const CAPTURED_INDEX = {
	uuid: "10a9ba93b240b58a",
	name: "default.styles.stylesIndex08052025",
	sourceName: "default",
	type: "fulltext-index",
} as const;

const CAPTURED_ALIAS = {
	uuid: "2b8c01fe44a1",
	name: "default.styles.stylesIndexAlias",
	sourceName: "",
	type: "fulltext-alias",
} as const;

describe("summarizeFtsIndex (SIO-1823)", () => {
	test("projects a summary instead of the full definition", () => {
		const summary = summarizeFtsIndex(CAPTURED_INDEX as never);
		expect(summary).toEqual({
			name: "default.styles.stylesIndex08052025",
			type: "fulltext-index",
			sourceName: "default",
			queryName: "default.styles.stylesIndex08052025",
			isAlias: false,
		});
		// The definition body must not ride along -- that is the whole point of the summary.
		expect(Object.keys(summary)).not.toContain("params");
	});

	// A live alias reports sourceName "" rather than omitting it. Passing the empty string
	// through would have the agent report a source named "".
	test("an alias' empty sourceName normalises to null and is flagged", () => {
		const summary = summarizeFtsIndex(CAPTURED_ALIAS as never);
		expect(summary.sourceName).toBeNull();
		expect(summary.isAlias).toBe(true);
	});

	test("a scope-level listing records the scope it came from", () => {
		const summary = summarizeFtsIndex({ ...CAPTURED_INDEX, name: "stylesIndex08052025" } as never, "styles");
		expect(summary.scope).toBe("styles");
		// Verified live: this bare name works through scope.search and throws
		// IndexNotFoundError through cluster.search, so the name handed back to the agent
		// must be the one valid at the level it was listed from.
		expect(summary.queryName).toBe("stylesIndex08052025");
	});
});

describe("resolveFtsLimit (SIO-1823)", () => {
	test("defaults when no limit is given", () => {
		expect(resolveFtsLimit(undefined, false)).toBe(DEFAULT_FTS_LIMIT);
	});

	// One captured index reports 692,316 total rows. An uncapped limit is the difference
	// between an answer and a flooded context.
	test("clamps above the maximum", () => {
		expect(resolveFtsLimit(5000, false)).toBe(MAX_FTS_LIMIT);
		expect(resolveFtsLimit(MAX_FTS_LIMIT + 1, false)).toBe(MAX_FTS_LIMIT);
	});

	test("honours a limit within range", () => {
		expect(resolveFtsLimit(25, false)).toBe(25);
	});

	test("explain forces a single row, overriding any limit", () => {
		expect(resolveFtsLimit(50, true)).toBe(1);
		expect(resolveFtsLimit(undefined, true)).toBe(1);
	});

	test("a zero or negative limit floors at 1 rather than disabling the cap", () => {
		expect(resolveFtsLimit(0, false)).toBe(1);
		expect(resolveFtsLimit(-10, false)).toBe(1);
	});
});

describe("decodeDiagnosticsReport (SIO-1823)", () => {
	// Captured verbatim from cluster.diagnostics().
	const CAPTURED_REPORT = {
		version: 2,
		id: "495586-ae0a-ea46-2a39-b5687979f1d551",
		sdk: "cxx/1.3.1;Darwin/arm64",
		services: {
			kv: [{ last_activity_us: 0, remote: "3.71.5.123:11207", local: "192.168.178.158:54700", state: 2 }],
		},
	};

	// state arrives as a NUMBER. "2" tells an agent nothing, and the same integer means
	// something different in a ping report (PingState 0 = Ok vs EndpointState 0 =
	// Disconnected), so the decoded name is what makes the field readable.
	test("decodes the numeric endpoint state to a name, keeping the raw value", () => {
		const decoded = decodeDiagnosticsReport(CAPTURED_REPORT) as {
			services: { kv: Array<{ state: number; stateName: string }> };
		};
		expect(decoded.services.kv[0].stateName).toBe("connected");
		expect(decoded.services.kv[0].state).toBe(2);
	});

	test.each([
		[0, "disconnected"],
		[1, "connecting"],
		[2, "connected"],
		[3, "disconnecting"],
	])("decodes state %i as %s", (state, expected) => {
		const decoded = decodeDiagnosticsReport({ services: { kv: [{ state }] } }) as {
			services: { kv: Array<{ stateName: string }> };
		};
		expect(decoded.services.kv[0].stateName).toBe(expected);
	});

	// last_activity_us was 0 on the live capture: a fresh connection, not one idle since
	// the epoch. Deriving a "0 ms ago" reading from it would invite exactly that misread.
	test("omits the derived activity age when the SDK reports zero", () => {
		const decoded = decodeDiagnosticsReport(CAPTURED_REPORT) as {
			services: { kv: Array<{ lastActivityMs?: number }> };
		};
		expect(decoded.services.kv[0].lastActivityMs).toBeUndefined();
	});

	test("converts a non-zero activity age to milliseconds", () => {
		const decoded = decodeDiagnosticsReport({
			services: { kv: [{ state: 2, last_activity_us: 1_500_000 }] },
		}) as { services: { kv: Array<{ lastActivityMs: number }> } };
		expect(decoded.services.kv[0].lastActivityMs).toBe(1500);
	});

	test("passes through a report with no services rather than throwing", () => {
		expect(decodeDiagnosticsReport({ version: 2 })).toEqual({ version: 2 });
		expect(decodeDiagnosticsReport(undefined)).toBeUndefined();
	});
});
