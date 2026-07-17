// shared/src/hil-learning.test.ts
import { describe, expect, test } from "bun:test";
import { HIL_EDITABLE_FIELDS, HilItemEditsSchema } from "./hil-learning.ts";

describe("SIO-1128 HilItemEdits contract", () => {
	test("HIL_EDITABLE_FIELDS lists only invariant-free prose fields per kind", () => {
		expect(HIL_EDITABLE_FIELDS.rootCause).toEqual(["description", "resolution"]);
		expect(HIL_EDITABLE_FIELDS.binding).toEqual(["reason"]);
		expect(HIL_EDITABLE_FIELDS.heuristic).toEqual(["description", "whenToUse", "procedure"]);
		expect(HIL_EDITABLE_FIELDS.memoryFact).toEqual(["text"]);
	});

	test("HilItemEditsSchema accepts an id->field->string map and rejects non-string values", () => {
		expect(HilItemEditsSchema.safeParse({ "fact-1": { text: "edited" } }).success).toBe(true);
		expect(HilItemEditsSchema.safeParse({}).success).toBe(true);
		expect(HilItemEditsSchema.safeParse({ "fact-1": { text: 5 } }).success).toBe(false);
		expect(HilItemEditsSchema.safeParse({ "fact-1": "not-an-object" }).success).toBe(false);
	});
});
