// tests/tools/prompts-tags.test.ts
import { describe, expect, test } from "bun:test";

import * as connectPrompts from "../../src/tools/connect/prompts.ts";
import * as destructivePrompts from "../../src/tools/destructive/prompts.ts";
import * as ksqlPrompts from "../../src/tools/ksql/prompts.ts";
import * as readPrompts from "../../src/tools/read/prompts.ts";
import * as readExtendedPrompts from "../../src/tools/read/prompts-extended.ts";
import * as restproxyPrompts from "../../src/tools/restproxy/prompts.ts";
import * as schemaPrompts from "../../src/tools/schema/prompts.ts";
import * as writePrompts from "../../src/tools/write/prompts.ts";

// SIO-730: every tool description string exported from the prompts modules must
// start with one of [READ], [WRITE], or [DESTRUCTIVE]. Locks the routing-hint
// invariant at the source layer; SIO-732 will add a complementary registered-set
// check against server.listTools() output.
const TAG_REGEX = /^\[(READ|WRITE|DESTRUCTIVE)\] /;

const MODULES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
	["read/prompts", readPrompts],
	["read/prompts-extended", readExtendedPrompts],
	["write/prompts", writePrompts],
	["destructive/prompts", destructivePrompts],
	["schema/prompts", schemaPrompts],
	["ksql/prompts", ksqlPrompts],
	["connect/prompts", connectPrompts],
	["restproxy/prompts", restproxyPrompts],
];

function collectDescriptions(): Array<{ module: string; name: string; value: string }> {
	const out: Array<{ module: string; name: string; value: string }> = [];
	for (const [moduleName, mod] of MODULES) {
		for (const [name, value] of Object.entries(mod)) {
			if (!name.endsWith("_DESCRIPTION")) continue;
			if (typeof value !== "string") continue;
			out.push({ module: moduleName, name, value });
		}
	}
	return out;
}

describe("tool description tag prefixes (SIO-730)", () => {
	test("every *_DESCRIPTION export starts with [READ]/[WRITE]/[DESTRUCTIVE]", () => {
		const descriptions = collectDescriptions();
		const violations = descriptions
			.filter(({ value }) => !TAG_REGEX.test(value))
			.map(({ module, name, value }) => `${module}.${name}: ${value.slice(0, 60)}...`);
		expect(violations).toEqual([]);
	});

	test("expected total description count (canary against silent additions/removals)", () => {
		// SIO-742: +5 health-check descriptions
		// SIO-770: +1 read description (LIST_DLQ_TOPICS_DESCRIPTION) -> read = 8
		// 61 = 8 (read) + 3 (read-extended) + 3 (write) + 2 (destructive)
		//    + 16 (schema: 8 kafka_* + 7 sr_* + 1 schema_registry_health_check)
		//    + 9 (ksql: 7 + ksql_health_check + ksql_cluster_status)
		//    + 10 (connect: 9 + connect_health_check)
		//    + 10 (restproxy: 9 + restproxy_health_check)
		// Bump this count when adding a new tool description; do not bypass.
		expect(collectDescriptions().length).toBe(61);
	});
});
