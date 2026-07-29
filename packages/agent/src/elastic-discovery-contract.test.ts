// agent/src/elastic-discovery-contract.test.ts
//
// SIO-1277: the 2026-07-27 run reported "no order-service logs or APM traces exist" while
// 3.4M documents sat under prana-order-service. Two independent defects produced it, and
// this file pins the fix for each.
//
//   Defect A -- PHASE 2 was skipped. The agent ran PHASE 1 six times, never queried the
//     candidates it had, and declared absence. The absence judge should have caught the
//     contradiction, but it rules on PERSISTED toolOutputs and the recovered discovery
//     call used elasticsearch_multi_search, which was not in TYPED_FINDING_TOOLS -- so the
//     judge was shown nothing and upheld the claim.
//
//   Defect B -- PHASE 1 filtered by an anchor-token wildcard. `tokenize("order-service")`
//     yields "order", and *order* cannot match `ordo`, `sampleor` or `otcwdis` (all real
//     eu-b2b services). The filtered agg then reports sum_other_doc_count: 0 and LOOKS
//     complete while being silently scoped to a guess.
//
// Defect B is the reason fixing A alone is insufficient: a perfectly-executing agent still
// cannot see a candidate the filter excluded.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tokenize } from "./correlation/focus-match.ts";
import { TYPED_FINDING_TOOLS } from "./sub-agent-instrumentation.ts";

const SOUL_PATH = join(import.meta.dir, "../../../agents/incident-analyzer/agents/elastic-agent/SOUL.md");

async function soul(): Promise<string> {
	return await Bun.file(SOUL_PATH).text();
}

// Slice on the literal PHASE HEADING -- line-start, followed by the ` -- ` separator the
// headings actually use. Two weaker patterns were tried and both mis-sliced against real
// prose (found while addressing CodeRabbit on PR #518):
//   indexOf("PHASE 2")  -> matched phase 1 prose REFERRING to phase 2, truncating phase 1
//   /^PHASE \d /m       -> matched the hard-wrapped line "PHASE 1 is never a substitute"
//                          inside phase 2, truncating phase 2
// Both failed assertions about content that was present, which is the worst kind of test
// failure: it points at the document when the bug is in the reader.
const HEADING = (n: number) => new RegExp(`^PHASE ${n} -- `, "m");

function phase(text: string, n: 1 | 2 | 3): string {
	const start = text.search(HEADING(n));
	if (start < 0) throw new Error(`PHASE ${n} heading not found in SOUL.md`);
	const rest = text.slice(start);
	const next = rest.slice(1).search(/^PHASE \d -- /m);
	return next < 0 ? rest : rest.slice(0, next + 1);
}

describe("Defect A -- discovery payloads reach the absence judge (SIO-1277)", () => {
	// buildAbsenceEvidenceDigest renders only PERSISTED toolOutputs, so a tool absent from
	// this set is invisible to judgeContradictedAbsenceClaims. Both elastic search tools can
	// carry a by_service discovery aggregation; persisting only one makes the contradiction
	// check depend on which tool happened to succeed.
	test.each(["elasticsearch_search", "elasticsearch_multi_search"])(
		"%s is persisted so its buckets can refute an absence claim",
		(tool) => {
			expect(
				TYPED_FINDING_TOOLS.has(tool),
				`${tool} must be in TYPED_FINDING_TOOLS -- the absence judge only sees persisted tool outputs, so an unpersisted discovery result cannot contradict a false "no telemetry" claim`,
			).toBe(true);
		},
	);
});

describe("Defect B -- PHASE 1 enumerates rather than filters (SIO-1277)", () => {
	// The concrete miss, asserted against the real matcher rather than described in prose.
	test("the anchor token cannot match the eu-b2b services a wildcard would exclude", () => {
		const anchor = [...tokenize("order-service")][0];
		// Narrow before use: an empty token set would otherwise make every includes() below
		// throw rather than fail with the intended message.
		if (anchor === undefined) throw new Error("tokenize('order-service') produced no anchor token");
		expect(anchor).toBe("order");

		// Real services in eu-b2b (logs-kubernetes.prd-default), verified 2026-07-29.
		for (const name of ["ordo", "sampleor", "otcwdis"]) {
			expect(name.includes(anchor), `*${anchor}* must NOT match ${name} -- that is the blind spot`).toBe(false);
		}
		// Sanity: the wildcard does match the obvious ones, so the assertion above is about
		// the filter's reach, not a broken anchor.
		for (const name of ["order-service", "prana-order-service", "orders-service"]) {
			expect(name.includes(anchor)).toBe(true);
		}
	});

	test("PHASE 1 no longer prescribes a service.name wildcard", async () => {
		const text = await soul();
		const phase1 = phase(text, 1);
		expect(phase1.length).toBeGreaterThan(0);

		expect(
			/"wildcard":\s*\{\s*"service\.name"/.test(phase1),
			"PHASE 1 must ENUMERATE service.name for the deployment, not filter by an anchor wildcard -- a filtered agg reports sum_other_doc_count: 0 and looks complete while being scoped to a guess",
		).toBe(false);
	});

	test("PHASE 1 requires an explicit deployment and a completeness check", async () => {
		const phase1 = phase(await soul(), 1);
		expect(phase1).toContain("deployment");
		expect(phase1).toContain("sum_other_doc_count");
		// The multi-deployment hazard must be stated, not merely implied by the placeholder.
		expect(phase1.toLowerCase()).toContain("unscoped");
	});

	// CodeRabbit on PR #518: PHASE 1 enumerated at now-24h while PHASE 2 and the absence
	// rule use now-30d. A narrower discovery window than the search window is a
	// false-absence generator -- a service quiet for a day is omitted from discovery, so
	// PHASE 2 never queries it and "absent" stays eligible. Measured in eu-b2b:
	// order-service-v2 and sample-order-hub_Mdx have docs in the 2-30 day band and none in
	// the last 24h.
	test("PHASE 1 discovery window matches the PHASE 2 / absence window", async () => {
		const text = await soul();
		const phase1 = phase(text, 1);
		const gte = /"gte":\s*"now-(\d+)([dh])"/.exec(phase1);
		expect(gte, "PHASE 1 must state an explicit @timestamp lower bound").not.toBeNull();

		const [, amount, unit] = gte ?? [];
		const hours = unit === "d" ? Number(amount) * 24 : Number(amount);
		expect(
			hours,
			"PHASE 1 must discover over a window at least as wide as PHASE 2 (now-30d), or a service quiet for a day is silently undiscoverable",
		).toBeGreaterThanOrEqual(30 * 24);
	});

	// CodeRabbit on PR #518: as SIBLING aggs, idx/agent/env describe the deployment as a
	// whole rather than each service -- and with size:0 there are no hits to read the
	// fields from. The classification contract would then have nothing per candidate to
	// classify on. They must be nested under by_service.
	test("classification metadata is nested under by_service, not a sibling agg", async () => {
		const phase1 = phase(await soul(), 1);
		const json = phase1.match(/```json([\s\S]*?)```/)?.[1] ?? "";
		expect(json).toContain("by_service");

		// The nested block must sit inside by_service's own "aggs", which only exists when
		// by_service has a second "aggs" key after its "terms".
		const byService = json.slice(json.indexOf('"by_service"'));
		const termsAt = byService.indexOf('"terms"');
		const nestedAggsAt = byService.indexOf('"aggs"', termsAt);
		expect(
			nestedAggsAt,
			"by_service must carry a nested aggs block -- sibling aggs describe the deployment, not the candidate",
		).toBeGreaterThan(termsAt);

		for (const field of ["_index", "agent.name", "service.environment"]) {
			expect(byService.slice(nestedAggsAt)).toContain(field);
		}
	});

	test("PHASE 1 teaches the app / gateway / container-log distinction", async () => {
		const phase1 = phase(await soul(), 1);
		// A matching name is not necessarily the application: order-service is Kong data.
		expect(phase1).toContain("agent.name");
		expect(phase1).toContain("logs-kong");
		expect(phase1).toContain("logs-kubernetes");
	});
});

describe("Defect A -- absence requires PHASE 2 to have run (SIO-1277)", () => {
	test("PHASE 2 is mandatory once PHASE 1 returns a candidate", async () => {
		const text = await soul();
		const phase2 = phase(text, 2);
		expect(phase2).toContain("MANDATORY");
		// Re-running discovery instead of advancing is the observed failure mode. Collapse
		// whitespace first: the prose is hard-wrapped, so the phrase spans a newline.
		const flat = phase2.toLowerCase().replace(/\s+/g, " ");
		expect(flat).toContain("re-running phase 1 is never a substitute");
	});

	test("an unqueried candidate forbids an absence conclusion", async () => {
		const text = await soul();
		const tail = text.slice(text.search(/^PHASE 3 -- /m));
		expect(tail).toContain("did not query");
		expect(tail.toLowerCase()).toContain("have not established absence");
	});
});
