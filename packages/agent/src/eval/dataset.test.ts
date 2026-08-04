// packages/agent/src/eval/dataset.test.ts
import { describe, expect, test } from "bun:test";
import type { EvalExample } from "./dataset.ts";

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
