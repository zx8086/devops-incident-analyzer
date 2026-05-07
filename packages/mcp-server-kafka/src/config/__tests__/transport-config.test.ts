import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getConfig, resetConfigCache } from "../config.ts";

describe("transport config", () => {
	const savedTransport = process.env.MCP_TRANSPORT;

	beforeEach(() => {
		// Tests expect defaults -- clear any env overrides
		delete process.env.MCP_TRANSPORT;
		resetConfigCache();
	});

	afterEach(() => {
		// Restore original env
		if (savedTransport !== undefined) process.env.MCP_TRANSPORT = savedTransport;
		else delete process.env.MCP_TRANSPORT;
		resetConfigCache();
	});

	test("defaults to stdio transport", () => {
		const config = getConfig();
		expect(config.transport.mode).toBe("stdio");
	});

	test("defaults to port 9081", () => {
		const config = getConfig();
		expect(config.transport.port).toBe(9081);
	});

	test("defaults to localhost binding", () => {
		const config = getConfig();
		expect(config.transport.host).toBe("127.0.0.1");
	});

	test("defaults to /mcp path", () => {
		const config = getConfig();
		expect(config.transport.path).toBe("/mcp");
	});

	test("defaults to stateless session mode", () => {
		const config = getConfig();
		expect(config.transport.sessionMode).toBe("stateless");
	});

	test("defaults to 120s idle timeout", () => {
		const config = getConfig();
		expect(config.transport.idleTimeout).toBe(120);
	});
});
