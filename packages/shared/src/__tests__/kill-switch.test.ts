// shared/src/__tests__/kill-switch.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isKillSwitchActive, KillSwitchError } from "../kill-switch.ts";

const SENTINEL = join(tmpdir(), `kill-switch-test-${Date.now()}`);

afterEach(() => {
	delete process.env.AGENT_KILL_SWITCH;
	try {
		unlinkSync(SENTINEL);
	} catch {
		// file may not exist
	}
});

describe("isKillSwitchActive", () => {
	test("returns false when nothing is set", () => {
		expect(isKillSwitchActive()).toBe(false);
	});

	test("returns true when env var is 'true'", () => {
		process.env.AGENT_KILL_SWITCH = "true";
		expect(isKillSwitchActive()).toBe(true);
	});

	test("returns true when env var is '1'", () => {
		process.env.AGENT_KILL_SWITCH = "1";
		expect(isKillSwitchActive()).toBe(true);
	});

	test("returns false for other env values", () => {
		process.env.AGENT_KILL_SWITCH = "false";
		expect(isKillSwitchActive()).toBe(false);
	});

	test("returns true when sentinel file exists", () => {
		writeFileSync(SENTINEL, "");
		expect(isKillSwitchActive({ sentinelPath: SENTINEL })).toBe(true);
	});

	test("returns false when sentinel path is missing", () => {
		expect(isKillSwitchActive({ sentinelPath: "/tmp/nonexistent-kill-switch-file" })).toBe(false);
	});

	test("supports custom env var name", () => {
		process.env.MY_KILL = "true";
		expect(isKillSwitchActive({ envVar: "MY_KILL" })).toBe(true);
		delete process.env.MY_KILL;
	});
});

describe("KillSwitchError", () => {
	test("has correct name and message", () => {
		const err = new KillSwitchError();
		expect(err.name).toBe("KillSwitchError");
		expect(err.message).toContain("kill switch");
	});
});
