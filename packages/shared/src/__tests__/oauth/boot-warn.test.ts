// src/__tests__/oauth/boot-warn.test.ts

import { describe, expect, test } from "bun:test";
import type { OAuthProviderLogger } from "../../oauth/base-provider.ts";
import { warnIfOAuthNotSeeded } from "../../oauth/boot-warn.ts";

interface CapturedCall {
	method: "info" | "warn" | "error";
	meta: Record<string, unknown>;
	msg: string;
}

function makeRecordingLogger(): OAuthProviderLogger & { calls: CapturedCall[] } {
	const calls: CapturedCall[] = [];
	return {
		calls,
		info(meta, msg) {
			calls.push({ method: "info", meta, msg });
		},
		warn(meta, msg) {
			calls.push({ method: "warn", meta, msg });
		},
		error(meta, msg) {
			calls.push({ method: "error", meta, msg });
		},
	};
}

const baseOptions = {
	namespace: "gitlab",
	key: "https://gitlab.com",
	endpointLabel: "instanceUrl",
	seedCommand: "bun run oauth:seed:gitlab",
};

describe("warnIfOAuthNotSeeded", () => {
	test("warns when not seeded and not headless", () => {
		const logger = makeRecordingLogger();
		warnIfOAuthNotSeeded({
			...baseOptions,
			logger,
			hasSeededTokensFn: () => false,
			isHeadlessFn: () => false,
		});

		expect(logger.calls).toHaveLength(1);
		const call = logger.calls[0];
		if (!call) throw new Error("expected one logger call");
		expect(call.method).toBe("warn");
		expect(call.msg).toMatch(/!!! GITLAB OAUTH NOT SEEDED .* MCP_OAUTH_HEADLESS/);
		expect(call.msg).toContain("bun run oauth:seed:gitlab");
		expect(call.meta).toMatchObject({
			namespace: "gitlab",
			instanceUrl: "https://gitlab.com",
			remediation: "bun run oauth:seed:gitlab",
			docs: ".env.example MCP_OAUTH_HEADLESS",
		});
	});

	test("info-logs when headless is on (regardless of seeded state)", () => {
		const logger = makeRecordingLogger();
		warnIfOAuthNotSeeded({
			...baseOptions,
			logger,
			hasSeededTokensFn: () => false,
			isHeadlessFn: () => true,
		});

		expect(logger.calls).toHaveLength(1);
		const call = logger.calls[0];
		if (!call) throw new Error("expected one logger call");
		expect(call.method).toBe("info");
		expect(call.msg).toContain("MCP_OAUTH_HEADLESS active");
		expect(call.meta).toMatchObject({ namespace: "gitlab", seeded: false });
	});

	test("silent when seeded and not headless", () => {
		const logger = makeRecordingLogger();
		warnIfOAuthNotSeeded({
			...baseOptions,
			logger,
			hasSeededTokensFn: () => true,
			isHeadlessFn: () => false,
		});

		expect(logger.calls).toHaveLength(0);
	});

	test("info-logs with seeded:true when seeded and headless", () => {
		const logger = makeRecordingLogger();
		warnIfOAuthNotSeeded({
			...baseOptions,
			logger,
			hasSeededTokensFn: () => true,
			isHeadlessFn: () => true,
		});

		expect(logger.calls).toHaveLength(1);
		const call = logger.calls[0];
		if (!call) throw new Error("expected one logger call");
		expect(call.method).toBe("info");
		expect(call.meta).toMatchObject({ namespace: "gitlab", seeded: true });
	});

	test("uppercases namespace in WARN subject for atlassian", () => {
		const logger = makeRecordingLogger();
		warnIfOAuthNotSeeded({
			namespace: "atlassian",
			key: "https://mcp.atlassian.com/v1/mcp",
			endpointLabel: "mcpEndpoint",
			seedCommand: "bun run oauth:seed:atlassian",
			logger,
			hasSeededTokensFn: () => false,
			isHeadlessFn: () => false,
		});

		expect(logger.calls).toHaveLength(1);
		const call = logger.calls[0];
		if (!call) throw new Error("expected one logger call");
		expect(call.method).toBe("warn");
		expect(call.msg).toMatch(/!!! ATLASSIAN OAUTH NOT SEEDED/);
		expect(call.meta).toMatchObject({
			namespace: "atlassian",
			mcpEndpoint: "https://mcp.atlassian.com/v1/mcp",
			remediation: "bun run oauth:seed:atlassian",
		});
	});
});
