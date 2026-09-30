// src/__tests__/read-only-mode-env.test.ts
// SIO-1898: READ_ONLY_QUERY_MODE guards the SIO-1109/1813/1822 read-only gate, so
// an unrecognised value must fail safe to ON. The loader used to parse it as
// `value === "true"`, which turned the gate OFF for "1", "yes" or a typo. These
// tests drive the real loadConfigFromEnv, so they fail if the read-only field
// ever goes back to the opt-in parse the other booleans use.

import { afterEach, describe, expect, test } from "bun:test";
import { loadConfigFromEnv } from "../config/loader.ts";

const VAR = "READ_ONLY_QUERY_MODE";
const original = Bun.env[VAR];

function readOnlyWith(value: string | undefined): boolean | undefined {
	if (value === undefined) delete Bun.env[VAR];
	else Bun.env[VAR] = value;
	return loadConfigFromEnv().server?.readOnlyQueryMode;
}

afterEach(() => {
	if (original === undefined) delete Bun.env[VAR];
	else Bun.env[VAR] = original;
});

describe("SIO-1898: READ_ONLY_QUERY_MODE fails safe to read-only", () => {
	test.each([undefined, "true", "TRUE", "1", "yes", "on", "flase", ""])("%p keeps the gate on", (value) => {
		expect(readOnlyWith(value)).toBe(true);
	});

	test.each(["false", "FALSE", "False", "0", " false "])("%p turns the gate off", (value) => {
		expect(readOnlyWith(value)).toBe(false);
	});

	test("the opt-in booleans keep their strict parse", () => {
		const previous = Bun.env.DOCS_ENABLED;
		try {
			Bun.env.DOCS_ENABLED = "1";
			expect(loadConfigFromEnv().documentation?.enabled).toBe(false);
			Bun.env.DOCS_ENABLED = "true";
			expect(loadConfigFromEnv().documentation?.enabled).toBe(true);
		} finally {
			if (previous === undefined) delete Bun.env.DOCS_ENABLED;
			else Bun.env.DOCS_ENABLED = previous;
		}
	});
});
