// shared/src/transport/__tests__/agentcore-proxy.test.ts
import { beforeEach, describe, expect, mock, test } from "bun:test";

const startProxyMock = mock(async () => ({
	port: 3001,
	url: "http://localhost:3001/mcp",
	close: mock(async () => {}),
}));
const loadConfigMock = mock(() => ({
	runtimeArn: "arn:aws:bedrock-agentcore:eu-west-1:111111111111:runtime/test-rt-AAAA",
	region: "eu-west-1",
	port: 3001,
}));

mock.module("../../agentcore-proxy.ts", () => ({
	startAgentCoreProxy: startProxyMock,
	loadProxyConfigFromEnv: loadConfigMock,
}));

const spanCalls: Array<{ name: string; attrs?: Record<string, string | number>; ok?: boolean; err?: string }> = [];
mock.module("../../telemetry/telemetry.ts", () => ({
	traceSpan: async (
		_tracer: string,
		name: string,
		fn: () => Promise<unknown>,
		attrs?: Record<string, string | number>,
	) => {
		const call: { name: string; attrs?: Record<string, string | number>; ok?: boolean; err?: string } = {
			name,
			attrs,
		};
		spanCalls.push(call);
		try {
			const r = await fn();
			call.ok = true;
			return r;
		} catch (e) {
			call.ok = false;
			call.err = e instanceof Error ? e.message : String(e);
			throw e;
		}
	},
}));

const { createAgentCoreProxyTransport } = await import("../agentcore-proxy.ts");

function captureLogger() {
	const records: Array<{ level: string; msg: string; meta?: unknown }> = [];
	return {
		records,
		logger: {
			info: (msg: string, meta?: Record<string, unknown>) => records.push({ level: "info", msg, meta }),
			error: (msg: string, meta?: Record<string, unknown>) => records.push({ level: "error", msg, meta }),
			warn: (msg: string, meta?: Record<string, unknown>) => records.push({ level: "warn", msg, meta }),
		},
	};
}

describe("createAgentCoreProxyTransport", () => {
	beforeEach(() => {
		spanCalls.length = 0;
		startProxyMock.mockClear();
		loadConfigMock.mockClear();
	});

	test("loads config for the prefix and starts the proxy", async () => {
		const { logger } = captureLogger();
		await createAgentCoreProxyTransport("AWS", logger);
		expect(loadConfigMock).toHaveBeenCalledWith("AWS");
		expect(startProxyMock).toHaveBeenCalledTimes(1);
	});

	test("wraps connect in proxy.connect span with prefix attribute", async () => {
		const { logger } = captureLogger();
		await createAgentCoreProxyTransport("KAFKA", logger);
		const connect = spanCalls.find((c) => c.name === "proxy.connect");
		expect(connect).toBeDefined();
		expect(connect?.attrs).toMatchObject({ "proxy.prefix": "KAFKA" });
		expect(connect?.ok).toBe(true);
	});

	test("emits 'AgentCore proxy ready' log on connect", async () => {
		const { logger, records } = captureLogger();
		await createAgentCoreProxyTransport("AWS", logger);
		const ready = records.find((r) => r.msg === "AgentCore proxy ready");
		expect(ready).toBeDefined();
		expect(ready?.meta).toMatchObject({ prefix: "AWS", port: 3001 });
	});

	test("closeAll wraps proxy.close in proxy.close span and logs", async () => {
		const { logger, records } = captureLogger();
		const transport = await createAgentCoreProxyTransport("AWS", logger);
		await transport.closeAll();
		const close = spanCalls.find((c) => c.name === "proxy.close");
		expect(close).toBeDefined();
		expect(close?.attrs).toMatchObject({ "proxy.prefix": "AWS" });
		expect(close?.ok).toBe(true);
		const closedLog = records.find((r) => r.msg === "AgentCore proxy closed");
		expect(closedLog).toBeDefined();
	});

	test("propagates startProxy failure with error span", async () => {
		startProxyMock.mockImplementationOnce(async () => {
			throw new Error("boom");
		});
		const { logger } = captureLogger();
		await expect(createAgentCoreProxyTransport("AWS", logger)).rejects.toThrow("boom");
		const connect = spanCalls.find((c) => c.name === "proxy.connect");
		expect(connect?.ok).toBe(false);
		expect(connect?.err).toBe("boom");
	});
});
