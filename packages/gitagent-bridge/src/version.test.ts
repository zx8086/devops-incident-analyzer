// gitagent-bridge/src/version.test.ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgent } from "./manifest-loader.ts";
import { assertValidVersion, assertVersionMatchesTag, parseSemver, provenanceHeader } from "./version.ts";

describe("version (SIO-1649)", () => {
	test("parseSemver accepts MAJOR.MINOR.PATCH with an optional prerelease", () => {
		expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
		expect(parseSemver("0.1.0-rc.1")).toEqual({ major: 0, minor: 1, patch: 0, prerelease: "rc.1" });
		expect(parseSemver("1.2")).toBeUndefined();
		expect(parseSemver("v1.2.3")).toBeUndefined();
		expect(parseSemver("01.2.3")).toBeUndefined();
	});

	test("assertValidVersion names the agent in the error", () => {
		expect(() => assertValidVersion("pi-fleet", "banana")).toThrow('agent "pi-fleet": version "banana" is not semver');
		expect(() => assertValidVersion("pi-fleet", "0.1.0")).not.toThrow();
	});

	test("assertVersionMatchesTag compares the tag suffix with the manifest version", () => {
		expect(() => assertVersionMatchesTag("0.1.0", "pi-fleet-v0.1.0")).not.toThrow();
		expect(() => assertVersionMatchesTag("0.1.0", "pi-fleet-v0.2.0")).toThrow(
			'tag "pi-fleet-v0.2.0" names version "0.2.0" but the manifest says "0.1.0"',
		);
		expect(() => assertVersionMatchesTag("0.1.0", "v0.1.0")).toThrow('does not start with "pi-fleet-v"');
	});

	test("provenanceHeader stamps name, version and the analyzer sha", () => {
		expect(provenanceHeader("pi-fleet", "0.1.0", "abc1234")).toBe("<!-- pi-fleet v0.1.0 (analyzer abc1234) -->");
		expect(provenanceHeader("pi-fleet", "0.1.0")).toBe("<!-- pi-fleet v0.1.0 -->");
	});

	test("loadAgent rejects a non-semver version", () => {
		const root = mkdtempSync(join(tmpdir(), "gitagent-version-"));
		try {
			mkdirSync(join(root, "agents", "bad"), { recursive: true });
			writeFileSync(join(root, "agents", "bad", "agent.yaml"), "name: bad\nversion: banana\ndescription: test\n");
			expect(() => loadAgent(join(root, "agents", "bad"))).toThrow('agent "bad": version "banana" is not semver');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
