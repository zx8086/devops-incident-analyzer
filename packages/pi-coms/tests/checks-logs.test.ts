// tests/checks-logs.test.ts
import { describe, expect, test } from "bun:test";
import {
	type CollapsedEvent,
	checkLogs,
	collapseTraceEvents,
	logSignature,
	logsWindow,
	SAMPLE_CAPTURE,
	stripLogPrefix,
	summariseLogSample,
} from "../scripts/monitor/checks/logs.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

// What the fakes read off a command: its class name and the filter inputs.
type Cmd = {
	constructor: { name: string };
	input: { logGroupName?: string; startTime?: number; filterPattern?: string };
};
type LogsEvidence = { count: number; overflow: unknown[] };

function fakeClient(groups: string[], eventsByGroup: Record<string, { timestamp: number; message: string }[]>) {
	return {
		calls: [] as Cmd[],
		async send(cmd: Cmd) {
			this.calls.push(cmd);
			if (cmd.constructor.name === "DescribeLogGroupsCommand") {
				return { logGroups: groups.map((g) => ({ logGroupName: g })) };
			}
			if (cmd.constructor.name === "FilterLogEventsCommand") {
				const g = cmd.input.logGroupName as string;
				const since = cmd.input.startTime as number;
				return { events: (eventsByGroup[g] ?? []).filter((e) => e.timestamp >= since) };
			}
			throw new Error(`unexpected ${cmd.constructor.name}`);
		},
	};
}

describe("checkLogs", () => {
	test("signature is stable across ids and timestamps", () => {
		const a = logSignature("ERROR order 12345 failed at 2026-08-30T10:00:00Z req 6f9a0c2b4d1e8f37");
		const b = logSignature("ERROR order 99999 failed at 2026-08-31T11:11:11Z req deadbeefcafe0123");
		expect(a).toBe(b);
		expect(logSignature("WARN disk low")).not.toBe(a);
	});

	test("errors since the watermark become one grouped finding; watermark advances", async () => {
		const state = new MonitorState(":memory:");
		const now = 1_000_000_000_000;
		const client = fakeClient(["/aws/app"], {
			"/aws/app": [
				{ timestamp: now - 60_000, message: "ERROR db connect failed 1" },
				{ timestamp: now - 30_000, message: "ERROR db connect failed 2" },
			],
		});
		const out = await checkLogs(client, state, { now, slackMs: 0 });
		expect(out).toHaveLength(1);
		expect(out[0].severity).toBe("warn");
		expect((out[0].evidence as LogsEvidence).count).toBe(2);
		// SIO-1753: the window closes at its end, not at the last event.
		expect(state.getWatermark("logs:/aws/app")).toBe(now + 1);
	});

	test("second run with no new events is quiet; same signature within window is deduped", async () => {
		const state = new MonitorState(":memory:");
		const now = 1_000_000_000_000;
		const events = [{ timestamp: now - 60_000, message: "ERROR x failed" }];
		await checkLogs(fakeClient(["/g"], { "/g": events }), state, { now, slackMs: 0 });
		// new event, same signature, later timestamp
		const later = [{ timestamp: now + 10_000, message: "ERROR x failed" }];
		const out = await checkLogs(fakeClient(["/g"], { "/g": later }), state, { now: now + 20_000, slackMs: 0 });
		expect(out).toHaveLength(0); // fingerprinted
		expect(state.getWatermark("logs:/g")).toBe(now + 20_000 + 1);
	});

	test("first run only looks back lookbackMs", async () => {
		const state = new MonitorState(":memory:");
		const now = 1_000_000_000_000;
		const client = fakeClient(["/g"], {
			"/g": [{ timestamp: now - 3_600_000, message: "ERROR ancient" }],
		});
		const out = await checkLogs(client, state, { now, lookbackMs: 900_000 });
		expect(out).toHaveLength(0);
	});
});

describe("checkLogs relevance caps", () => {
	const now = 1_000_000_000_000;
	const ev = (msg: string, i = 0) => ({ timestamp: now - 60_000 + i, message: msg });

	test("excluded prefixes are never scanned", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient(["/aws/codebuild/x", "/aws/app"], {
			"/aws/codebuild/x": [ev("ERROR noisy build")],
			"/aws/app": [ev("ERROR real problem")],
		});
		const out = await checkLogs(client, state, { now, excludePrefixes: ["/aws/codebuild/"] });
		expect(out).toHaveLength(1);
		expect(out[0].resource).toBe("/aws/app");
	});

	test("per-group cap keeps loudest signatures, folds the rest into one info overflow", async () => {
		const state = new MonitorState(":memory:");
		const events = [
			ev("ERROR alpha broke", 1),
			ev("ERROR alpha broke", 2),
			ev("ERROR alpha broke", 3),
			ev("ERROR beta broke", 4),
			ev("ERROR beta broke", 5),
			ev("ERROR gamma broke", 6),
			ev("ERROR gamma broke", 7),
			ev("ERROR delta broke", 8),
			ev("ERROR epsilon broke", 9),
		];
		const client = fakeClient(["/aws/app"], { "/aws/app": events });
		const out = await checkLogs(client, state, { now, maxSigsPerGroup: 3 });
		const warns = out.filter((f) => f.severity === "warn");
		const infos = out.filter((f) => f.severity === "info");
		expect(warns).toHaveLength(3);
		expect((warns[0].evidence as LogsEvidence).count).toBe(3); // loudest first
		expect(infos).toHaveLength(1);
		expect((infos[0].evidence as LogsEvidence).overflow).toHaveLength(2);
	});

	test("per-cycle cap bounds warn findings across groups", async () => {
		const state = new MonitorState(":memory:");
		const groups = ["/g1", "/g2", "/g3"];
		const byGroup: Record<string, { timestamp: number; message: string }[]> = {};
		for (const g of groups) byGroup[g] = [ev(`ERROR ${g} one`), ev(`ERROR ${g} two x`)];
		const client = fakeClient(groups, byGroup);
		const out = await checkLogs(client, state, { now, maxFindingsPerCycle: 4 });
		expect(out.filter((f) => f.severity === "warn")).toHaveLength(4);
		expect(out.filter((f) => f.severity === "info")).toHaveLength(1);
	});

	test("default filter pattern excludes WARN", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient(["/aws/app"], { "/aws/app": [ev("ERROR x")] });
		await checkLogs(client, state, { now });
		const filterCall = client.calls.find((c) => c.constructor.name === "FilterLogEventsCommand");
		expect(filterCall?.input.filterPattern).toBe("?ERROR ?Exception");
	});
});

describe("checkLogs noise controls (SIO-1590)", () => {
	const now = 1_000_000_000_000;

	test("UUIDs normalize to a stable signature", () => {
		const a = logSignature('{"id":"d41c3231-612b-fc56-b455-b41b62a98d89","detail-type":"AWS API Call"} ERROR');
		const b = logSignature('{"id":"bd1480c6-3363-32ba-2d95-53a9b323fded","detail-type":"AWS API Call"} ERROR');
		expect(a).toBe(b);
	});

	test("/aws/events/ groups are excluded by default; explicit opt-in overrides", async () => {
		const events = [{ timestamp: now - 60_000, message: "ERROR delivery echo" }];
		const groups = ["/aws/events/eventbridge-logs"];
		const byGroup = { "/aws/events/eventbridge-logs": events };

		const out = await checkLogs(fakeClient(groups, byGroup), new MonitorState(":memory:"), { now });
		expect(out).toHaveLength(0);

		const optIn = await checkLogs(fakeClient(groups, byGroup), new MonitorState(":memory:"), {
			now,
			excludePrefixes: [],
		});
		expect(optIn).toHaveLength(1);
	});
});

describe("checkLogs id normalization (SIO-1592)", () => {
	test("mixed alphanumeric ids (option codes) share one signature", () => {
		const a = logSignature(
			"NotFoundException: No order items with option code UW0UW061470LZ in order 1002029318 could be found",
		);
		const b = logSignature(
			"NotFoundException: No order items with option code MW0MW25037YBR in order 1002027574 could be found",
		);
		expect(a).toBe(b);
	});

	test("a single version digit does not turn a class name into an id", () => {
		// V2 vs V3 collapse via plain digit normalization (by design), but the
		// class name's letters survive -- unlike an <id>, which erases them.
		const a = logSignature("ERROR ImagesClientV2 request failed");
		const b = logSignature("ERROR StockClientV2 request failed");
		expect(a).not.toBe(b);
	});
});

function failingClient(
	groups: string[],
	failures: Record<string, string>,
	eventsByGroup: Record<string, { timestamp: number; message: string }[]> = {},
) {
	return {
		async send(cmd: Cmd) {
			if (cmd.constructor.name === "DescribeLogGroupsCommand") {
				return { logGroups: groups.map((g) => ({ logGroupName: g })) };
			}
			const g = cmd.input.logGroupName as string;
			if (failures[g]) throw new Error(failures[g]);
			const since = cmd.input.startTime as number;
			return { events: (eventsByGroup[g] ?? []).filter((e) => e.timestamp >= since) };
		},
	};
}

describe("checkLogs scope tolerance (SIO-1592)", () => {
	const now = 1_000_000_000_000;
	const denied =
		"User: arn:aws:sts::1:assumed-role/x is not authorized to perform: logs:FilterLogEvents on resource: y because no identity-based policy allows the logs:FilterLogEvents action";

	test("a denied group is one info scoping finding; the scan continues", async () => {
		const state = new MonitorState(":memory:");
		const client = failingClient(
			["/aws-dynamodb/x", "/aws/app"],
			{ "/aws-dynamodb/x": denied },
			{
				"/aws/app": [{ timestamp: now - 60_000, message: "ERROR real problem" }],
			},
		);
		const out = await checkLogs(client, state, { now });
		const scope = out.filter((f) => f.severity === "info");
		const warns = out.filter((f) => f.severity === "warn");
		expect(scope).toHaveLength(1);
		expect(scope[0].summary).toContain("outside the readable name scope");
		expect(warns).toHaveLength(1);
		expect(warns[0].resource).toBe("/aws/app");
		// second cycle: scope finding is deduped, real scanning still works
		const again = await checkLogs(client, state, { now: now + 60_000 });
		expect(again.filter((f) => f.severity === "info")).toHaveLength(0);
	});

	test("a non-auth failure on one group skips it without killing the check", async () => {
		const state = new MonitorState(":memory:");
		const client = failingClient(
			["/g1", "/g2"],
			{ "/g1": "ThrottlingException: slow down" },
			{
				"/g2": [{ timestamp: now - 60_000, message: "ERROR still seen" }],
			},
		);
		const out = await checkLogs(client, state, { now });
		expect(out.filter((f) => f.severity === "warn")).toHaveLength(1);
	});

	test("non-auth failure on every group throws (real check failure)", async () => {
		const state = new MonitorState(":memory:");
		const client = failingClient(["/g1", "/g2"], {
			"/g1": "ThrottlingException",
			"/g2": "ThrottlingException",
		});
		await expect(checkLogs(client, state, { now })).rejects.toThrow("all 2 log group scan(s) failed");
	});
});

// Live on eu-oit-prd: four findings in one log group all read "3 error-pattern
// event(s) in /ecs/fargate/catalog-prd-log-group". They are DISTINCT signatures
// (so collapsing them would lose signal) and the digest could not tell them apart.
describe("stripLogPrefix (SIO-1874)", () => {
	// Both strings are verbatim from live journals on 2026-09-23. A stripper
	// tested against ONE producer format is untested, so both real shapes are
	// pinned here.
	const QUARKUS =
		"2026-09-22 10:39:37,736 ERROR f7b06144c52da311f3efd9c68f15145c 128552bcaa91de80 context= [com.pvh.listsapi.service.impl.UserServiceImpl] (executor-thread-316) Failed to update sold to dependent data";
	const SPRING =
		"2026-09-22T10:39:11.020Z trace_id=6ab25ace4231834e5353a57a1e7b09cb span_id=8b553a2e03eaa2cd ERROR 1 --- [Container#1-582] c.p.b.n.m.UserNotificationSubscriber : Failed to process message";

	test("strips the Quarkus timestamp, level, trace and span ids", () => {
		const out = stripLogPrefix(QUARKUS);
		expect(out.startsWith("[com.pvh.listsapi.service.impl.UserServiceImpl]")).toBe(true);
		expect(out).toContain("Failed to update sold to dependent data");
		expect(out).not.toContain("f7b06144c52da311f3efd9c68f15145c");
	});

	test("strips the Spring Boot trace_id=/span_id= form and the sequence number", () => {
		const out = stripLogPrefix(SPRING);
		expect(out.startsWith("[Container#1-582]")).toBe(true);
		expect(out).toContain("Failed to process message");
		expect(out).not.toContain("6ab25ace4231834e5353a57a1e7b09cb");
	});

	test("recovers real message characters, which is the whole point", () => {
		// 76 of 188 characters were ids on eu-oit-prd; those characters were
		// pushing the message past the excerpt cap.
		expect(stripLogPrefix(QUARKUS).length).toBeLessThan(QUARKUS.length - 60);
	});

	test("a line with no recognisable prefix is left alone", () => {
		// A bare stack frame must never be eaten by best-effort stripping.
		const frame = "at org.springframework.jdbc.core.JdbcTemplate.translateException(JdbcTemplate.java:1538)";
		expect(stripLogPrefix(frame)).toBe(frame);
		const exc = 'java.lang.NullPointerException: Cannot invoke "java.util.UUID.toString()"';
		expect(stripLogPrefix(exc)).toBe(exc);
	});

	test("a populated context= is kept; only the empty one is dropped", () => {
		const kept = "context=tenant-42 [com.pvh.Svc] boom";
		expect(stripLogPrefix(kept)).toContain("context=tenant-42");
	});

	test("an ids-only line returns the original rather than an empty string", () => {
		const idsOnly = "2026-09-22 10:39:37,736 ERROR f7b06144c52da311f3efd9c68f15145c";
		expect(stripLogPrefix(idsOnly)).not.toBe("");
	});

	test("a hex-looking WORD in the message is not mistaken for an id", () => {
		const msg = "deadbeefdeadbeef is the checksum we expected";
		expect(stripLogPrefix(msg)).toBe(msg);
	});

	// Greptile P2 on #902. The test above used the UNPREFIXED form, which never
	// reached the bare-id branch, so it did not protect the case it looked like
	// it protected. These carry the full structured prefix.
	test("a hex payload token survives behind a real timestamp and level", () => {
		expect(stripLogPrefix("2026-09-22 10:39:37,736 ERROR deadbeefdeadbeef is the checksum we expected")).toBe(
			"deadbeefdeadbeef is the checksum we expected",
		);
		expect(stripLogPrefix("2026-09-22 10:39:37,736 ERROR 9f8e7d6c5b4a3210 build failed")).toBe(
			"9f8e7d6c5b4a3210 build failed",
		);
	});

	test("an id RUN followed by structure is still stripped", () => {
		// The discriminator: a tracer emits ids in a run and then structure
		// (`context=` or `[`), which prose never does. Measured on 11 of 14 live
		// eu-oit-prd lines.
		const out = stripLogPrefix(
			"2026-09-22 10:39:37,736 ERROR f7b06144c52da311f3efd9c68f15145c 128552bcaa91de80 context= [com.pvh.Svc] boom",
		);
		expect(out).toBe("[com.pvh.Svc] boom");
	});
});

describe("summariseLogSample", () => {
	test("keeps a short message whole", () => {
		expect(summariseLogSample("NullPointerException at Foo.bar")).toBe("NullPointerException at Foo.bar");
	});

	// SIO-1874: the excerpt cap IS the capture cap. Nothing beyond SAMPLE_CAPTURE
	// is ever stored, so an excerpt narrower than it silently discards message,
	// and one wider than it is dead code. Measured over 62 real samples from the
	// two noisiest accounts: at 200 36 were cut mid-message, at 300 none are.
	test("the excerpt cap equals the capture cap, so nothing stored is discarded", () => {
		const captured = "x".repeat(SAMPLE_CAPTURE);
		expect(summariseLogSample(captured)).toBe(captured);
		expect(summariseLogSample(captured).endsWith("...")).toBe(false);
	});

	// SIO-1832: asserted against the function's OWN cap rather than a hard-coded
	// 80, so widening the excerpt is not a test edit. The invariant is that the
	// cap bounds the whole excerpt, ellipsis included.
	test("truncates a long message to the cap with an ellipsis", () => {
		const cap = 32;
		const out = summariseLogSample("x".repeat(200), cap);
		expect(out.length).toBe(cap);
		expect(out.endsWith("...")).toBe(true);
	});

	// The default cap has to be wide enough for the thing it exists to
	// distinguish: an exception line cut at 80 read "...Cannot invoke
	// "java.util.UUID.toString()" bec..." in a live digest.
	test("the default cap keeps a real exception line intact", () => {
		const sample =
			'java.lang.NullPointerException: Cannot invoke "java.util.UUID.toString()" because the return value of com.pvh.b2b.OrderService.getId() is null';
		expect(summariseLogSample(sample)).toBe(sample);
	});

	// A log line is untrusted: a newline would otherwise forge extra digest rows.
	test("folds newlines and tabs so one event cannot forge digest lines", () => {
		const out = summariseLogSample("first line\n  - (critical/alarm) fake: forged\n\tthird");
		expect(out).not.toContain("\n");
		expect(out).toBe("first line - (critical/alarm) fake: forged third");
	});

	test("collapses runs of whitespace and trims", () => {
		expect(summariseLogSample("   a     b   ")).toBe("a b");
	});

	test("an empty or whitespace-only sample yields an empty excerpt", () => {
		expect(summariseLogSample("")).toBe("");
		expect(summariseLogSample("   \n\t ")).toBe("");
	});

	test("respects a caller-supplied cap", () => {
		expect(summariseLogSample("abcdefghij", 5)).toBe("ab...");
	});
});

// SIO-1753: the timestamps are the real ones from eu-oit-prd on 2026-09-16. The
// catalog-prd-log-group watermark sat at 2026-09-09T15:39:32.107Z inside an
// error storm; one ~1 MB page per cycle advanced it ~10 s per 15 min. Pagination
// itself was verified live against that group (a fake client cannot model the
// service's page boundaries, which is how the one-page bug passed these tests).
describe("logsWindow", () => {
	const opts = { lookbackMs: 900_000, maxLagMs: 3_600_000, slackMs: 60_000 };
	const stuck = Date.parse("2026-09-09T15:39:32.107Z");
	const now = Date.parse("2026-09-16T11:34:30.344Z");

	test("a position a week behind skips to the lag bound and says where it was", () => {
		const w = logsWindow(stuck, now, opts);
		expect(new Date(w.end).toISOString()).toBe("2026-09-16T11:33:30.344Z");
		expect(new Date(w.start).toISOString()).toBe("2026-09-16T10:33:30.344Z");
		expect(w.skippedFrom).toBe(stuck);
	});

	test("a current position resumes exactly where the last window closed", () => {
		const closed = Date.parse("2026-09-16T11:18:30.345Z");
		const w = logsWindow(closed, now, opts);
		expect(w.start).toBe(closed);
		expect(w.skippedFrom).toBeNull();
	});

	test("a position exactly at the lag bound is not a skip", () => {
		const bound = now - opts.slackMs - opts.maxLagMs;
		expect(logsWindow(bound, now, opts).skippedFrom).toBeNull();
		expect(logsWindow(bound - 1, now, opts).skippedFrom).toBe(bound - 1);
	});

	test("no position yet looks back lookbackMs from the slack-adjusted end", () => {
		const w = logsWindow(null, now, opts);
		expect(w.end - w.start).toBe(opts.lookbackMs);
		expect(now - w.end).toBe(opts.slackMs);
	});

	test("a position ahead of the window end never produces an inverted window", () => {
		const w = logsWindow(now, now, opts);
		expect(w.start).toBe(w.end);
	});
});

// SIO-1820. Measured live (eu-shared-services-prd, 2026-09-19): CloudWatch
// delivers a Java trace as SEPARATE one-line events -- 0 of 8 sampled events
// were multi-line. So each frame arrived as its own event and, at 120
// normalized characters apiece, became its own finding. The grouping has to
// happen ACROSS events, which is what collapseTraceEvents does.
describe("collapseTraceEvents (SIO-1820)", () => {
	// One Reactor/WebClient trace exactly as CloudWatch delivers it: one line
	// per event, same log stream, ascending timestamps.
	const TRACE = [
		"2026-09-18T10:00:01.123Z ERROR [catalog] o.s.w.r.f.c.ExchangeFunctions - [3f2a1b] HTTP POST /v2/prices failed",
		"org.springframework.web.reactive.function.client.WebClientResponseException$NotFound: 404 Not Found from POST https://prices/v2/prices",
		"\tat org.springframework.web.reactive.function.client.WebClientResponseException.create(WebClientResponseException.java:322)",
		"\tSuppressed: reactor.core.publisher.FluxOnAssembly$OnAssemblyException: Error has been observed at the following site(s):",
		"\t\t*__checkpoint - 502 BAD_GATEWAY from POST https://prices/v2/prices [DefaultWebClient]",
		"Caused by: java.net.ConnectException: Connection refused: prices-svc/10.3.4.5:8443",
	];
	const evs = (msgs: string[], stream = "s1", t0 = 1_000) =>
		msgs.map((message, i) => ({ timestamp: t0 + i, message, logStreamName: stream }));

	test("a whole trace collapses to ONE incident", () => {
		const out = collapseTraceEvents(evs(TRACE), logSignature);
		// The leading plain ERROR line is its own event and carries no exception
		// type, so it stays separate; the trace proper is one incident.
		const traceOnly = collapseTraceEvents(evs(TRACE.slice(1)), logSignature);
		expect(traceOnly).toHaveLength(1);
		expect(traceOnly[0].frames).toBe(5);
		expect(out.length).toBeLessThan(TRACE.length);
	});

	test("the incident is signed by its ROOT CAUSE, not its first line", () => {
		const out = collapseTraceEvents(evs(TRACE.slice(1)), logSignature);
		expect(out[0].signature).toBe(
			logSignature("java.net.ConnectException: Connection refused: prices-svc/10.3.4.5:8443"),
		);
	});

	// The payoff: two occurrences whose leading exception differs (404 vs 502)
	// but whose root cause is identical now dedup to one signature.
	test("two occurrences of one fault with different leading lines dedup", () => {
		const a = collapseTraceEvents(evs(TRACE.slice(1), "s1"), logSignature);
		const b = collapseTraceEvents(
			evs(
				[
					"org.springframework.web.reactive.function.client.WebClientResponseException$BadGateway: 502 Bad Gateway from POST https://prices/v2/prices",
					"\tat org.springframework.web.reactive.function.client.WebClientResponseException.create(WebClientResponseException.java:999)",
					"Caused by: java.net.ConnectException: Connection refused: prices-svc/10.3.4.9:8443",
				],
				"s2",
			),
			logSignature,
		);
		expect(a[0].signature).toBe(b[0].signature);
	});

	test("a DIFFERENT root cause stays a different incident", () => {
		const npe = collapseTraceEvents(
			evs(["java.lang.IllegalStateException: boom", "Caused by: java.lang.NullPointerException: s is null"], "s3"),
			logSignature,
		);
		const conn = collapseTraceEvents(evs(TRACE.slice(1), "s4"), logSignature);
		expect(npe[0].signature).not.toBe(conn[0].signature);
	});

	// Concurrent requests interleave in a shared group: frames must attach to
	// their OWN stream's exception, never to whichever event came last.
	test("interleaved traces from two streams do not cross-contaminate", () => {
		const mixed = [
			{ timestamp: 1, message: "java.lang.IllegalStateException: alpha", logStreamName: "a" },
			{ timestamp: 2, message: "java.lang.IllegalStateException: beta", logStreamName: "b" },
			{ timestamp: 3, message: "Caused by: java.net.ConnectException: alpha-cause", logStreamName: "a" },
			{ timestamp: 4, message: "Caused by: java.lang.NullPointerException: beta-cause", logStreamName: "b" },
		];
		const out = collapseTraceEvents(mixed, logSignature);
		expect(out).toHaveLength(2);
		expect(out[0].signature).toBe(logSignature("java.net.ConnectException: alpha-cause"));
		expect(out[1].signature).toBe(logSignature("java.lang.NullPointerException: beta-cause"));
	});

	test("a plain one-line ERROR does not adopt the next unrelated event", () => {
		const out = collapseTraceEvents(
			evs(["ERROR disk almost full on /var", "ERROR queue depth exceeded on orders"]),
			logSignature,
		);
		expect(out).toHaveLength(2);
	});

	// The window can open mid-trace; an orphan frame must still be reported.
	test("a continuation with no preceding identity is kept, not dropped", () => {
		const out = collapseTraceEvents(evs(["\tat com.example.Foo.bar(Foo.java:1)"]), logSignature);
		expect(out).toHaveLength(1);
		expect(out[0].frames).toBe(1);
	});

	test("events with no stream name still group (single-stream groups)", () => {
		const out = collapseTraceEvents(
			[
				{ timestamp: 1, message: "java.lang.IllegalStateException: x" },
				{ timestamp: 2, message: "Caused by: java.net.ConnectException: y" },
			],
			logSignature,
		);
		expect(out).toHaveLength(1);
	});

	// SIO-1820 follow-up (Greptile P1, verified): FilterLogEvents pages, and an
	// exception can end one page while its frames and `Caused by:` line begin the
	// next. Collapsing each page independently resets the open-trace map at every
	// boundary, so those continuations become separate incidents and the original
	// never receives its root-cause signature. The reducer therefore takes the
	// open state in and hands it back.
	test("a trace split across a page boundary is still ONE incident", () => {
		const page1 = evs(TRACE.slice(1, 3), "s1", 1000);
		const page2 = evs(TRACE.slice(3), "s1", 2000);
		const open = new Map<string, CollapsedEvent>();
		const a = collapseTraceEvents(page1, logSignature, open);
		const b = collapseTraceEvents(page2, logSignature, open);
		expect([...a, ...b]).toHaveLength(1);
		expect(a[0].signature).toBe(
			logSignature("java.net.ConnectException: Connection refused: prices-svc/10.3.4.5:8443"),
		);
	});

	test("carrying state across pages still separates different streams", () => {
		const open = new Map<string, CollapsedEvent>();
		const a = collapseTraceEvents(
			[{ timestamp: 1, message: "java.lang.IllegalStateException: alpha", logStreamName: "a" }],
			logSignature,
			open,
		);
		const b = collapseTraceEvents(
			[
				{ timestamp: 2, message: "java.lang.IllegalStateException: beta", logStreamName: "b" },
				{ timestamp: 3, message: "Caused by: java.net.ConnectException: alpha-cause", logStreamName: "a" },
			],
			logSignature,
			open,
		);
		expect([...a, ...b]).toHaveLength(2);
		expect(a[0].signature).toBe(logSignature("java.net.ConnectException: alpha-cause"));
	});

	test("omitting the state argument keeps the single-page behaviour", () => {
		const out = collapseTraceEvents(evs(TRACE.slice(1)), logSignature);
		expect(out).toHaveLength(1);
	});

	// SIO-1820 constraint: the excerpt stays untrusted text.
	test("a trace cannot forge a digest line through the excerpt", () => {
		expect(summariseLogSample(TRACE.join("\n"), 200)).not.toContain("\n");
	});
});
