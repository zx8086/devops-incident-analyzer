// tests/getSchemaForCollection.test.ts
// SIO-1168: regression tests asserting rendered field names are backtick-wrapped
// so a reserved word (e.g. `option`) is never copied unescaped into a query.

import { describe, expect, test } from "bun:test";
import { formatInferSchema, formatSchema } from "../src/tools/getSchemaForCollection";

describe("formatSchema field-name escaping (SIO-1168)", () => {
	test("backtick-wraps a reserved-word field name", () => {
		const text = formatSchema({ option: "CK07", salesOrganization: "CK07" });
		expect(text).toContain("`option`: string");
		expect(text).not.toContain("\noption:");
	});

	test("backtick-wraps nested field names", () => {
		const text = formatSchema({ nested: { option: "value" } });
		expect(text).toContain("`option`: string");
	});

	test("escapes an embedded backtick in a field name by doubling it", () => {
		const text = formatSchema({ "a`b": "value" });
		expect(text).toContain("`a``b`: string");
	});
});

describe("formatInferSchema field-name escaping (SIO-1168)", () => {
	test("backtick-wraps a reserved-word field name in INFER output", () => {
		const rows = [
			[
				{
					"#docs": 10,
					properties: {
						option: { type: "string", samples: ["CK07"] },
						priceListCode: { type: "string", samples: ["PL1"] },
					},
				},
			],
		];

		const text = formatInferSchema(rows);
		expect(text).not.toBeNull();
		expect(text).toContain("`option`: string");
		expect(text).toContain("`priceListCode`: string");
	});

	test("backtick-wraps a reserved-word field with an unknown/non-object spec", () => {
		const rows = [
			[
				{
					"#docs": 10,
					properties: {
						option: null,
					},
				},
			],
		];

		const text = formatInferSchema(rows);
		expect(text).not.toBeNull();
		expect(text).toContain("`option`: unknown");
	});

	test("escapes an embedded backtick in a field name by doubling it", () => {
		const rows = [
			[
				{
					"#docs": 10,
					properties: {
						"a`b": { type: "string", samples: ["x"] },
					},
				},
			],
		];

		const text = formatInferSchema(rows);
		expect(text).not.toBeNull();
		expect(text).toContain("`a``b`: string");
	});
});
