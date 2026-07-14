// knowledge-graph/src/confirm-binding.test.ts
import { describe, expect, test } from "bun:test";
import { parseArgs } from "./confirm-binding.ts";

describe("SIO-1103 confirm-binding parseArgs", () => {
	test("parses the required flags and infers datasource from the kind", () => {
		expect(parseArgs(["--service", "orders", "--kind", "logGroup", "--resourceId", "/ecs/orders-prd"])).toEqual({
			service: "orders",
			kind: "logGroup",
			resourceId: "/ecs/orders-prd",
			datasource: "aws", // inferred from logGroup
			locator: undefined,
			aliasRaw: undefined,
		});
	});

	test("accepts explicit --datasource, --locator, --alias", () => {
		expect(
			parseArgs([
				"--service",
				"orders",
				"--kind",
				"serviceName",
				"--resourceId",
				"orders-api",
				"--datasource",
				"elastic",
				"--locator",
				"eu-b2b",
				"--alias",
				"prices-api",
			]),
		).toMatchObject({ datasource: "elastic", locator: "eu-b2b", aliasRaw: "prices-api" });
	});

	test("rejects a missing required flag", () => {
		expect(() => parseArgs(["--service", "orders", "--kind", "logGroup"])).toThrow(/required:/);
		expect(() => parseArgs(["--kind", "logGroup", "--resourceId", "x"])).toThrow(/required:/);
	});

	test("rejects an unknown binding kind", () => {
		expect(() => parseArgs(["--service", "orders", "--kind", "not-a-kind", "--resourceId", "x"])).toThrow(
			/--kind must be one of/,
		);
	});

	test("rejects a valueless flag", () => {
		expect(() => parseArgs(["--service", "--kind", "logGroup", "--resourceId", "x"])).toThrow(
			/--service requires a value/,
		);
	});

	// SIO-1103 (CodeRabbit): a typo'd flag must not be silently dropped (which would let
	// datasource fall back to the wrong default and record the wrong binding).
	test("rejects an unknown flag (typo) instead of silently ignoring it", () => {
		expect(() =>
			parseArgs(["--service", "orders", "--kind", "logGroup", "--resourceId", "/ecs/x", "--datasouce", "elastic"]),
		).toThrow(/unknown flag --datasouce/);
	});
});
