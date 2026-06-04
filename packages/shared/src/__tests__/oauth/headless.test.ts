// src/__tests__/oauth/headless.test.ts

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isHeadless } from "../../oauth/headless.ts";

// isHeadless() reads process.env + process.stdout.isTTY directly, so each test
// must restore both (the Bun-env-leak class of order-dependent failure).
describe("isHeadless", () => {
	let savedHeadless: string | undefined;
	let savedForce: string | undefined;
	let savedIsTTY: boolean | undefined;

	beforeEach(() => {
		savedHeadless = process.env.MCP_OAUTH_HEADLESS;
		savedForce = process.env.MCP_OAUTH_FORCE_INTERACTIVE;
		savedIsTTY = process.stdout.isTTY;
		delete process.env.MCP_OAUTH_HEADLESS;
		delete process.env.MCP_OAUTH_FORCE_INTERACTIVE;
	});

	afterEach(() => {
		if (savedHeadless === undefined) delete process.env.MCP_OAUTH_HEADLESS;
		else process.env.MCP_OAUTH_HEADLESS = savedHeadless;
		if (savedForce === undefined) delete process.env.MCP_OAUTH_FORCE_INTERACTIVE;
		else process.env.MCP_OAUTH_FORCE_INTERACTIVE = savedForce;
		process.stdout.isTTY = savedIsTTY as boolean;
	});

	test("FORCE_INTERACTIVE overrides MCP_OAUTH_HEADLESS and non-TTY stdout", () => {
		process.env.MCP_OAUTH_FORCE_INTERACTIVE = "true";
		process.env.MCP_OAUTH_HEADLESS = "true";
		process.stdout.isTTY = false;
		expect(isHeadless()).toBe(false);
	});

	test("headless when MCP_OAUTH_HEADLESS=true and flag absent", () => {
		process.env.MCP_OAUTH_HEADLESS = "true";
		process.stdout.isTTY = true;
		expect(isHeadless()).toBe(true);
	});

	test("headless when stdout is not a TTY and flag absent", () => {
		process.stdout.isTTY = false;
		expect(isHeadless()).toBe(true);
	});

	test("not headless when neither signal present", () => {
		process.stdout.isTTY = true;
		expect(isHeadless()).toBe(false);
	});
});
