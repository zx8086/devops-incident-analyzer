// packages/agent/src/eval/dataset.test.ts
import { describe, expect, test } from "bun:test";
import type { EvalExample } from "./dataset.ts";
import { INCIDENT_REPLAY_DATASET } from "./incident-replay-dataset.ts";

describe("EvalExample.outputs.referenceFindings (SIO-1374)", () => {
	test("referenceFindings is optional and can be omitted", () => {
		const example: EvalExample = {
			inputs: { query: "test" },
			outputs: { expectedDatasources: [], minConfidence: 0.6, qualityRubric: "check X" },
		};
		expect(example.outputs.referenceFindings).toBeUndefined();
	});

	test("referenceFindings accepts a per-datasource string map", () => {
		const example: EvalExample = {
			inputs: { query: "test" },
			outputs: {
				expectedDatasources: ["elastic", "kafka"],
				minConfidence: 0.6,
				qualityRubric: "check X",
				referenceFindings: {
					elastic: "the deadlock exception chain",
					kafka: "the DLQ headers showing CHANNEL_CLOSED",
				},
			},
		};
		expect(example.outputs.referenceFindings?.elastic).toBe("the deadlock exception chain");
		expect(Object.keys(example.outputs.referenceFindings ?? {})).toHaveLength(2);
	});
});

describe("INCIDENT_REPLAY_DATASET metadata (SIO-1378)", () => {
	test("every entry has metadata defined", () => {
		expect(INCIDENT_REPLAY_DATASET).toHaveLength(32);
		for (const example of INCIDENT_REPLAY_DATASET) {
			expect(example.metadata).toBeDefined();
		}
	});

	test("every ticketKey matches DEVOPS-<n>", () => {
		for (const example of INCIDENT_REPLAY_DATASET) {
			expect(example.metadata?.ticketKey).toMatch(/^DEVOPS-\d+$/);
		}
	});

	test("every era matches YYYY-MM", () => {
		for (const example of INCIDENT_REPLAY_DATASET) {
			expect(example.metadata?.era).toMatch(/^\d{4}-\d{2}$/);
		}
	});

	test("provenance counts match the per-entry markers", () => {
		// The file-header prose claims a 13 VERBATIM / 1 VERBATIM-adjacent / 18 RECONSTRUCTED
		// split, but the per-entry provenance comments (the source of truth) mark
		// 15 / 1 / 16 -- the header's tally is stale.
		const counts: Record<"verbatim" | "verbatim-adjacent" | "reconstructed", number> = {
			verbatim: 0,
			"verbatim-adjacent": 0,
			reconstructed: 0,
		};
		for (const example of INCIDENT_REPLAY_DATASET) {
			const provenance = example.metadata?.queryProvenance;
			if (provenance) counts[provenance] += 1;
		}
		expect(counts.verbatim).toBe(15);
		expect(counts["verbatim-adjacent"]).toBe(1);
		expect(counts.reconstructed).toBe(16);
	});

	test("ticketKeys are unique across all entries", () => {
		const keys = INCIDENT_REPLAY_DATASET.map((example) => example.metadata?.ticketKey);
		expect(new Set(keys).size).toBe(INCIDENT_REPLAY_DATASET.length);
	});

	test("incidentDate, when present, matches YYYY-MM-DD", () => {
		for (const example of INCIDENT_REPLAY_DATASET) {
			if (example.metadata?.incidentDate !== undefined) {
				expect(example.metadata.incidentDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			}
		}
	});
});
