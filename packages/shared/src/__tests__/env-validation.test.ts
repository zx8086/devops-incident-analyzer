// packages/shared/src/__tests__/env-validation.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readPositiveIntEnv, readPositiveMsEnv } from "../env-validation.ts";

const TEST_VAR = "__ENV_VALIDATION_TEST_VAR__";

function makeSpyLogger() {
	const calls: Array<{ obj: Record<string, unknown>; msg: string }> = [];
	return {
		logger: {
			warn: (obj: Record<string, unknown>, msg: string) => {
				calls.push({ obj, msg });
			},
		},
		calls,
	};
}

describe("readPositiveMsEnv", () => {
	beforeEach(() => {
		delete process.env[TEST_VAR];
	});
	afterEach(() => {
		delete process.env[TEST_VAR];
	});

	test("returns the parsed value for a valid numeric string, no warning", () => {
		process.env[TEST_VAR] = "5000";
		const { logger, calls } = makeSpyLogger();
		expect(readPositiveMsEnv(TEST_VAR, 1000, logger)).toBe(5000);
		expect(calls.length).toBe(0);
	});

	test("returns the default when the var is unset, no warning", () => {
		const { logger, calls } = makeSpyLogger();
		expect(readPositiveMsEnv(TEST_VAR, 1000, logger)).toBe(1000);
		expect(calls.length).toBe(0);
	});

	test("allows fractional milliseconds", () => {
		process.env[TEST_VAR] = "5000.5";
		const { logger, calls } = makeSpyLogger();
		expect(readPositiveMsEnv(TEST_VAR, 1000, logger)).toBe(5000.5);
		expect(calls.length).toBe(0);
	});

	test("falls back to default and warns on a garbage (NaN) string", () => {
		process.env[TEST_VAR] = "not-a-number";
		const { logger, calls } = makeSpyLogger();
		expect(readPositiveMsEnv(TEST_VAR, 1000, logger)).toBe(1000);
		expect(calls.length).toBe(1);
		// biome-ignore lint/style/noNonNullAssertion: SIO-1308 - calls.length is guaranteed to be 1
		expect(calls[0]!.obj).toMatchObject({ name: TEST_VAR, raw: "not-a-number", defaultValue: 1000 });
	});

	test("falls back to default and warns on zero", () => {
		process.env[TEST_VAR] = "0";
		const { logger, calls } = makeSpyLogger();
		expect(readPositiveMsEnv(TEST_VAR, 1000, logger)).toBe(1000);
		expect(calls.length).toBe(1);
	});

	test("falls back to default and warns on a negative value", () => {
		process.env[TEST_VAR] = "-500";
		const { logger, calls } = makeSpyLogger();
		expect(readPositiveMsEnv(TEST_VAR, 1000, logger)).toBe(1000);
		expect(calls.length).toBe(1);
	});

	test("falls back to default and warns on Infinity", () => {
		process.env[TEST_VAR] = "Infinity";
		const { logger, calls } = makeSpyLogger();
		expect(readPositiveMsEnv(TEST_VAR, 1000, logger)).toBe(1000);
		expect(calls.length).toBe(1);
	});

	test("works without a logger argument (defaults to no-op)", () => {
		process.env[TEST_VAR] = "not-a-number";
		expect(readPositiveMsEnv(TEST_VAR, 1000)).toBe(1000);
	});
});

describe("readPositiveIntEnv", () => {
	beforeEach(() => {
		delete process.env[TEST_VAR];
	});
	afterEach(() => {
		delete process.env[TEST_VAR];
	});

	test("returns the parsed value for a valid integer string, no warning", () => {
		process.env[TEST_VAR] = "4";
		const { logger, calls } = makeSpyLogger();
		expect(readPositiveIntEnv(TEST_VAR, 1, logger)).toBe(4);
		expect(calls.length).toBe(0);
	});

	test("returns the default when the var is unset, no warning", () => {
		const { logger, calls } = makeSpyLogger();
		expect(readPositiveIntEnv(TEST_VAR, 4, logger)).toBe(4);
		expect(calls.length).toBe(0);
	});

	test("falls back to default and warns on a fractional value", () => {
		process.env[TEST_VAR] = "4.5";
		const { logger, calls } = makeSpyLogger();
		expect(readPositiveIntEnv(TEST_VAR, 4, logger)).toBe(4);
		expect(calls.length).toBe(1);
	});

	test("falls back to default and warns on zero", () => {
		process.env[TEST_VAR] = "0";
		const { logger, calls } = makeSpyLogger();
		expect(readPositiveIntEnv(TEST_VAR, 4, logger)).toBe(4);
		expect(calls.length).toBe(1);
	});

	test("falls back to default and warns on a negative value", () => {
		process.env[TEST_VAR] = "-1";
		const { logger, calls } = makeSpyLogger();
		expect(readPositiveIntEnv(TEST_VAR, 4, logger)).toBe(4);
		expect(calls.length).toBe(1);
	});

	test("falls back to default and warns on Infinity", () => {
		process.env[TEST_VAR] = "Infinity";
		const { logger, calls } = makeSpyLogger();
		expect(readPositiveIntEnv(TEST_VAR, 4, logger)).toBe(4);
		expect(calls.length).toBe(1);
	});
});
