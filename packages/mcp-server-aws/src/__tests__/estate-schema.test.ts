// src/__tests__/estate-schema.test.ts
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { AwsConfig } from "../config/schemas.ts";
import { estateEnum, withEstate } from "../tools/estate-schema.ts";

const config: AwsConfig = {
	region: "eu-central-1",
	estates: {
		"eu-oit-prd": { assumedRoleArn: "arn:aws:iam::111111111111:role/DevOpsAgentReadOnly", externalId: "id" },
		"eu-shared-services-prd": {
			assumedRoleArn: "arn:aws:iam::399987695868:role/DevOpsAgentReadOnly",
			externalId: "id",
		},
	},
};

describe("estate-schema (SIO-853)", () => {
	// The estate field must be a permissive string, NOT a z.enum. The enum baked the
	// estate-ID list into every tool schema, so an agent/server config drift made every
	// estate-scoped tool reject calls opaquely. resolveEstate (client-factory) is the
	// single runtime validation point.
	test("estate field is a string, not an enum", () => {
		const field = estateEnum(config);
		expect(field).toBeInstanceOf(z.ZodString);
		expect(field).not.toBeInstanceOf(z.ZodEnum);
	});

	test("accepts an estate id NOT in the configured list (drift tolerance)", () => {
		const field = estateEnum(config);
		// A value this server doesn't know must pass the SCHEMA gate (it fails later at
		// resolveEstate with a clear "Unknown estate" error, not here).
		expect(field.safeParse("eu-not-yet-deployed-prd").success).toBe(true);
	});

	test("describe text still lists the current estate ids for visibility", () => {
		const field = estateEnum(config);
		expect(field.description).toContain("eu-oit-prd");
		expect(field.description).toContain("eu-shared-services-prd");
	});

	test("rejects empty string", () => {
		expect(estateEnum(config).safeParse("").success).toBe(false);
	});

	test("withEstate injects the estate field over the tool shape", () => {
		const shape = withEstate(config, { cluster: z.string() });
		expect(shape).toHaveProperty("estate");
		expect(shape).toHaveProperty("cluster");
		expect(shape.estate).toBeInstanceOf(z.ZodString);
	});

	test("throws when no estates configured", () => {
		expect(() => estateEnum({ region: "eu-central-1", estates: {} })).toThrow(/No estates configured/);
	});
});
