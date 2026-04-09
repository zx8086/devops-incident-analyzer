// shared/src/__tests__/immutable-log.test.ts
import { describe, expect, test } from "bun:test";
import { createHashChainDestination, verifyHashChain } from "../immutable-log.ts";

describe("createHashChainDestination", () => {
	test("injects _prevHash and _lineHash into JSON log lines", () => {
		const output: string[] = [];
		const dest = createHashChainDestination({ write: (d) => output.push(d) });

		dest.write(JSON.stringify({ msg: "hello" }));
		expect(output).toHaveLength(1);

		const parsed = JSON.parse(output[0]!);
		expect(parsed.msg).toBe("hello");
		expect(parsed._prevHash).toBeString();
		expect(parsed._lineHash).toBeString();
		expect(parsed._prevHash).toHaveLength(64);
		expect(parsed._lineHash).toHaveLength(64);
	});

	test("chains hashes across multiple writes", () => {
		const output: string[] = [];
		const dest = createHashChainDestination({ write: (d) => output.push(d) });

		dest.write(JSON.stringify({ msg: "first" }));
		dest.write(JSON.stringify({ msg: "second" }));

		const first = JSON.parse(output[0]!);
		const second = JSON.parse(output[1]!);

		// Second entry's _prevHash should equal first entry's _lineHash
		expect(second._prevHash).toBe(first._lineHash);
	});

	test("first entry has seed hash as _prevHash", () => {
		const output: string[] = [];
		const dest = createHashChainDestination({ write: (d) => output.push(d) });

		dest.write(JSON.stringify({ msg: "first" }));
		const parsed = JSON.parse(output[0]!);
		expect(parsed._prevHash).toBe("0".repeat(64));
	});

	test("passes through non-JSON lines unchanged", () => {
		const output: string[] = [];
		const dest = createHashChainDestination({ write: (d) => output.push(d) });

		dest.write("not json\n");
		expect(output[0]!).toBe("not json\n");
	});
});

describe("verifyHashChain", () => {
	test("validates a correct chain", () => {
		const output: string[] = [];
		const dest = createHashChainDestination({ write: (d) => output.push(d) });

		dest.write(JSON.stringify({ msg: "one" }));
		dest.write(JSON.stringify({ msg: "two" }));
		dest.write(JSON.stringify({ msg: "three" }));

		const result = verifyHashChain(output);
		expect(result.valid).toBe(true);
		expect(result.brokenAt).toBeUndefined();
	});

	test("detects a broken chain when a line is tampered with", () => {
		const output: string[] = [];
		const dest = createHashChainDestination({ write: (d) => output.push(d) });

		dest.write(JSON.stringify({ msg: "one" }));
		dest.write(JSON.stringify({ msg: "two" }));
		dest.write(JSON.stringify({ msg: "three" }));

		// Tamper with line 1's _prevHash to break the chain at line 1
		const tampered = JSON.parse(output[1]!);
		tampered._prevHash = "deadbeef".repeat(8);
		output[1] = JSON.stringify(tampered);

		const result = verifyHashChain(output);
		expect(result.valid).toBe(false);
		expect(result.brokenAt).toBe(1);
	});

	test("handles empty input", () => {
		expect(verifyHashChain([]).valid).toBe(true);
	});
});
