// src/oauth/seed-command.test.ts

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedCommandFor } from "./seed-command.ts";

const created: string[] = [];

afterEach(() => {
	for (const dir of created) rmSync(dir, { recursive: true, force: true });
	created.length = 0;
});

function manifestDir(scripts: Record<string, string> | null, raw?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "seed-cmd-"));
	created.push(dir);
	if (raw !== undefined) {
		writeFileSync(join(dir, "package.json"), raw);
	} else if (scripts) {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts }));
	}
	return dir;
}

describe("seedCommandFor", () => {
	test("uses the namespaced name when the cwd defines it (workspace root)", () => {
		const dir = manifestDir({ "oauth:seed:atlassian": "bun run --filter ... oauth:seed" });
		expect(seedCommandFor("atlassian", dir)).toBe("bun run oauth:seed:atlassian");
	});

	test("uses the bare name when only the package-level script exists", () => {
		const dir = manifestDir({ "oauth:seed": "bun src/cli/seed-oauth.ts" });
		expect(seedCommandFor("atlassian", dir)).toBe("bun run oauth:seed");
	});

	test("prefers the namespaced name when both are defined", () => {
		const dir = manifestDir({ "oauth:seed": "x", "oauth:seed:gitlab": "y" });
		expect(seedCommandFor("gitlab", dir)).toBe("bun run oauth:seed:gitlab");
	});

	test("falls back to the namespaced name when no manifest exists", () => {
		const dir = manifestDir(null);
		expect(seedCommandFor("gitlab", dir)).toBe("bun run oauth:seed:gitlab");
	});

	test("falls back rather than throwing on a malformed manifest", () => {
		const dir = manifestDir(null, "{not json");
		expect(seedCommandFor("gitlab", dir)).toBe("bun run oauth:seed:gitlab");
	});

	test("falls back when the manifest has no scripts block", () => {
		const dir = manifestDir(null, JSON.stringify({ name: "x" }));
		expect(seedCommandFor("atlassian", dir)).toBe("bun run oauth:seed:atlassian");
	});
});
