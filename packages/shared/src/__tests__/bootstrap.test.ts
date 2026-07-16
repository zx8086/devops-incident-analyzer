// src/__tests__/bootstrap.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type BootstrapLogger, createMcpApplication, type McpApplicationOptions } from "../bootstrap.ts";
import { OAuthRequiresInteractiveAuthError } from "../oauth/errors.ts";

// Mock process.exit to prevent test runner from exiting
const originalExit = process.exit;
let exitCode: number | undefined;

beforeEach(() => {
	exitCode = undefined;
	process.exit = mock((code?: number) => {
		exitCode = code ?? 0;
		throw new Error(`process.exit(${code})`);
	}) as unknown as typeof process.exit;
});

afterEach(() => {
	process.exit = originalExit;
	// Remove signal handlers added by bootstrap
	process.removeAllListeners("SIGINT");
	process.removeAllListeners("SIGTERM");
	process.removeAllListeners("uncaughtException");
	process.removeAllListeners("unhandledRejection");
});

function createMockLogger(): BootstrapLogger & { calls: { method: string; args: unknown[] }[] } {
	const calls: { method: string; args: unknown[] }[] = [];
	return {
		calls,
		info(message: string, meta?: Record<string, unknown>) {
			calls.push({ method: "info", args: [message, meta] });
		},
		error(message: string, meta?: Record<string, unknown>) {
			calls.push({ method: "error", args: [message, meta] });
		},
		warn(message: string, meta?: Record<string, unknown>) {
			calls.push({ method: "warn", args: [message, meta] });
		},
		flush() {
			calls.push({ method: "flush", args: [] });
		},
	};
}

function createTestOptions<T>(overrides: Partial<McpApplicationOptions<T>> & { initDatasource: () => Promise<T> }) {
	const logger = createMockLogger();
	const { initDatasource, ...rest } = overrides;
	const options: McpApplicationOptions<T> = {
		name: "test-server",
		logger,
		initTracing: mock(() => {}),
		telemetry: { enabled: false, serviceName: "test", mode: "console", otlpEndpoint: "" },
		initDatasource,
		role: "elastic-mcp",
		version: "0.0.0-test",
		identityFingerprint: () => "test",
		createServerFactory: mock((_ds: T) => mock(() => ({}) as unknown as McpServer)),
		createTransport: mock(async () => ({ closeAll: mock(async () => {}) })),
		...rest,
	};
	return { options, logger };
}

describe("createMcpApplication", () => {
	describe("lifecycle ordering", () => {
		test("calls init steps in correct order", async () => {
			const callOrder: string[] = [];

			const { options } = createTestOptions({
				initTracing: mock(() => {
					callOrder.push("initTracing");
				}),
				initDatasource: async () => {
					callOrder.push("initDatasource");
					return { client: "test" };
				},
				createServerFactory: mock((_ds) => {
					callOrder.push("createServerFactory");
					return mock(() => ({}) as unknown as McpServer);
				}),
				createTransport: mock(async () => {
					callOrder.push("createTransport");
					return { closeAll: mock(async () => {}) };
				}),
				onStarted: mock(() => {
					callOrder.push("onStarted");
				}),
			});

			await createMcpApplication(options);

			expect(callOrder).toEqual([
				"initTracing",
				"initDatasource",
				"createServerFactory",
				"createTransport",
				"onStarted",
			]);
		});

		test("returns datasource and transport", async () => {
			const mockDatasource = { id: "test-ds" };
			const mockTransport = { closeAll: mock(async () => {}) };

			const { options } = createTestOptions({
				initDatasource: async () => mockDatasource,
				createTransport: mock(async () => mockTransport),
			});

			const app = await createMcpApplication(options);

			expect(app.datasource).toBe(mockDatasource);
			expect(app.transport).toBe(mockTransport);
			expect(typeof app.shutdown).toBe("function");
		});

		test("passes datasource to createServerFactory and createTransport", async () => {
			const mockDatasource = { id: "ds-123" };
			let factoryReceivedDs: unknown;
			let transportReceivedDs: unknown;

			const { options } = createTestOptions({
				initDatasource: async () => mockDatasource,
				createServerFactory: mock((ds) => {
					factoryReceivedDs = ds;
					return mock(() => ({}) as unknown as McpServer);
				}),
				createTransport: mock(async (_factory, ds) => {
					transportReceivedDs = ds;
					return { closeAll: mock(async () => {}) };
				}),
			});

			await createMcpApplication(options);

			expect(factoryReceivedDs).toBe(mockDatasource);
			expect(transportReceivedDs).toBe(mockDatasource);
		});
	});

	describe("shutdown", () => {
		test("calls shutdown steps in correct order", async () => {
			const shutdownOrder: string[] = [];
			const mockTransport = {
				closeAll: mock(async () => {
					shutdownOrder.push("closeAll");
				}),
			};

			const { options } = createTestOptions({
				initDatasource: async () => ({ id: "test" }),
				createTransport: mock(async () => mockTransport),
				cleanupDatasource: async () => {
					shutdownOrder.push("cleanupDatasource");
				},
			});

			const app = await createMcpApplication(options);

			try {
				await app.shutdown();
			} catch {
				// process.exit throws in our mock
			}

			expect(shutdownOrder).toEqual(["closeAll", "cleanupDatasource"]);
			expect(exitCode).toBe(0);
		});

		test("continues shutdown if transport close fails", async () => {
			const shutdownOrder: string[] = [];
			const mockTransport = {
				closeAll: mock(async () => {
					shutdownOrder.push("closeAll");
					throw new Error("transport close failed");
				}),
			};

			const { options, logger } = createTestOptions({
				initDatasource: async () => ({ id: "test" }),
				createTransport: mock(async () => mockTransport),
				cleanupDatasource: async () => {
					shutdownOrder.push("cleanupDatasource");
				},
			});

			const app = await createMcpApplication(options);

			try {
				await app.shutdown();
			} catch {
				// process.exit throws
			}

			expect(shutdownOrder).toEqual(["closeAll", "cleanupDatasource"]);

			const warnCalls = logger.calls.filter((c) => c.method === "warn");
			expect(warnCalls.some((c) => (c.args[0] as string).includes("Error closing transport"))).toBe(true);
			expect(exitCode).toBe(0);
		});

		test("re-entrancy guard prevents double shutdown", async () => {
			let closeCallCount = 0;
			const mockTransport = {
				closeAll: mock(async () => {
					closeCallCount++;
				}),
			};

			const { options } = createTestOptions({
				initDatasource: async () => ({ id: "test" }),
				createTransport: mock(async () => mockTransport),
			});

			const app = await createMcpApplication(options);

			// Call shutdown twice concurrently
			const p1 = app.shutdown().catch(() => {});
			const p2 = app.shutdown().catch(() => {});
			await Promise.allSettled([p1, p2]);

			expect(closeCallCount).toBe(1);
		});

		test("skips cleanupDatasource if not provided", async () => {
			const mockTransport = { closeAll: mock(async () => {}) };

			const { options } = createTestOptions({
				initDatasource: async () => ({ id: "test" }),
				createTransport: mock(async () => mockTransport),
			});
			// Ensure no cleanupDatasource
			delete (options as Partial<typeof options>).cleanupDatasource;

			const app = await createMcpApplication(options);

			try {
				await app.shutdown();
			} catch {
				// process.exit
			}

			expect(exitCode).toBe(0);
		});
	});

	describe("startup failure", () => {
		test("logs error and exits on datasource init failure", async () => {
			const { options, logger } = createTestOptions({
				initDatasource: async () => {
					throw new Error("connection refused");
				},
			});

			try {
				await createMcpApplication(options);
			} catch {
				// process.exit throws
			}

			expect(exitCode).toBe(1);
			const errorCalls = logger.calls.filter((c) => c.method === "error");
			expect(errorCalls.some((c) => (c.args[0] as string).includes("Fatal error starting test-server"))).toBe(true);
		});

		test("logs error and exits on transport creation failure", async () => {
			const { options, logger } = createTestOptions({
				initDatasource: async () => ({ id: "test" }),
				createTransport: mock(async () => {
					throw new Error("port in use");
				}),
			});

			try {
				await createMcpApplication(options);
			} catch {
				// process.exit throws
			}

			expect(exitCode).toBe(1);
			const errorCalls = logger.calls.filter((c) => c.method === "error");
			expect(errorCalls.some((c) => (c.args[0] as string).includes("Fatal error"))).toBe(true);
		});
	});
});

describe("createMcpApplication proxy mode", () => {
	test("mode: 'proxy' without createServerFactory does not throw", async () => {
		const { options } = createTestOptions<{ proxy: string }>({
			initDatasource: async () => ({ proxy: "ok" }),
		});
		// Remove createServerFactory; proxy mode shouldn't need it
		const proxyOptions: McpApplicationOptions<{ proxy: string }> = {
			...options,
			mode: "proxy",
			createServerFactory: undefined,
		};
		const app = await createMcpApplication(proxyOptions);
		expect(app.datasource).toEqual({ proxy: "ok" });
		try {
			await app.shutdown();
		} catch {
			// process.exit(0) throws in our mock
		}
		expect(exitCode).toBe(0);
	});

	test("mode: 'server' (default) without createServerFactory throws", async () => {
		const { options } = createTestOptions<{ x: number }>({
			initDatasource: async () => ({ x: 1 }),
		});
		const bad: McpApplicationOptions<{ x: number }> = {
			...options,
			createServerFactory: undefined,
		};
		// createMcpApplication catches and calls process.exit(1) on fatal error
		await expect(createMcpApplication(bad)).rejects.toThrow(/process\.exit\(1\)/);
	});

	test("mode: 'proxy' runs initTracing, telemetry, initDatasource, createTransport", async () => {
		const initTracing = mock(() => {});
		const initDatasource = mock(async () => ({ proxy: "ok" }));
		const createTransport = mock(async () => ({ closeAll: mock(async () => {}) }));
		const createServerFactory = mock((_ds: { proxy: string }) => mock(() => ({}) as unknown as McpServer));
		const { options } = createTestOptions<{ proxy: string }>({
			initDatasource,
		});
		await createMcpApplication({
			...options,
			mode: "proxy",
			initTracing,
			initDatasource,
			createTransport,
			createServerFactory, // should NOT be called in proxy mode
		});
		expect(initTracing).toHaveBeenCalledTimes(1);
		expect(initDatasource).toHaveBeenCalledTimes(1);
		expect(createTransport).toHaveBeenCalledTimes(1);
		expect(createServerFactory).not.toHaveBeenCalled();
	});

	test("mode: 'proxy' registers SIGINT/SIGTERM/uncaughtException/unhandledRejection handlers", async () => {
		const before = {
			sigint: process.listenerCount("SIGINT"),
			sigterm: process.listenerCount("SIGTERM"),
			uncaught: process.listenerCount("uncaughtException"),
			unhandled: process.listenerCount("unhandledRejection"),
		};
		const { options } = createTestOptions<{ proxy: string }>({
			initDatasource: async () => ({ proxy: "ok" }),
		});
		await createMcpApplication({ ...options, mode: "proxy", createServerFactory: undefined });
		expect(process.listenerCount("SIGINT")).toBe(before.sigint + 1);
		expect(process.listenerCount("SIGTERM")).toBe(before.sigterm + 1);
		expect(process.listenerCount("uncaughtException")).toBe(before.uncaught + 1);
		expect(process.listenerCount("unhandledRejection")).toBe(before.unhandled + 1);
	});
});

describe("OAuth not-authorized clean hard-fail", () => {
	test("renders OAuthRequiresInteractiveAuthError as one actionable line (no stack), exits 1", async () => {
		const { options, logger } = createTestOptions({
			initDatasource: async () => {
				throw new OAuthRequiresInteractiveAuthError("atlassian", new URL("https://mcp.atlassian.com/v1/authorize"));
			},
		});

		try {
			await createMcpApplication(options);
		} catch {
			// process.exit throws in our mock
		}

		expect(exitCode).toBe(1);
		const errorCalls = logger.calls.filter((c) => c.method === "error");
		const oauthCall = errorCalls.find((c) => (c.args[0] as string).includes("oauth:seed:atlassian"));
		// The clean remediation line replaces the generic stack-trace log
		expect(oauthCall).toBeDefined();
		expect(errorCalls.some((c) => (c.args[0] as string).includes("Fatal error starting"))).toBe(false);
		// The deep SDK auth stack is deliberately omitted; namespace is structured metadata
		const meta = oauthCall?.args[1] as Record<string, unknown> | undefined;
		expect(meta?.stack).toBeUndefined();
		expect(meta?.namespace).toBe("atlassian");
	});

	test("non-OAuth errors still log the generic fatal stack and exit 1", async () => {
		const { options, logger } = createTestOptions({
			initDatasource: async () => {
				throw new Error("connection refused");
			},
		});

		try {
			await createMcpApplication(options);
		} catch {
			// process.exit throws
		}

		expect(exitCode).toBe(1);
		const errorCalls = logger.calls.filter((c) => c.method === "error");
		expect(errorCalls.some((c) => (c.args[0] as string).includes("Fatal error starting test-server"))).toBe(true);
	});
});

describe("startup port logging", () => {
	test("logs a uniform 'listening on' line with the bound port for an HTTP transport", async () => {
		const { options, logger } = createTestOptions({
			initDatasource: async () => ({ id: "test" }),
			createTransport: mock(async () => ({
				listen: { mode: "http", port: 9085, url: "http://0.0.0.0:9085/mcp" },
				closeAll: mock(async () => {}),
			})),
		});

		await createMcpApplication(options);

		const infoCalls = logger.calls.filter((c) => c.method === "info");
		const listenCall = infoCalls.find((c) => (c.args[0] as string).includes("listening on"));
		expect(listenCall).toBeDefined();
		expect(listenCall?.args[0]).toContain("http://0.0.0.0:9085/mcp");
		expect((listenCall?.args[1] as Record<string, unknown>)?.port).toBe(9085);
	});

	test("logs a stdio ready line (no port) when the transport exposes no port", async () => {
		const { options, logger } = createTestOptions({
			initDatasource: async () => ({ id: "test" }),
			createTransport: mock(async () => ({
				listen: { mode: "stdio" },
				closeAll: mock(async () => {}),
			})),
		});

		await createMcpApplication(options);

		const infoCalls = logger.calls.filter((c) => c.method === "info");
		expect(infoCalls.some((c) => (c.args[0] as string).includes("ready (stdio transport, no port)"))).toBe(true);
	});

	// SIO-986: a standalone MCP process exits on a fatal start error; an EMBEDDED (in-process) server
	// must rethrow so the host app's catch can degrade gracefully instead of being killed.
	describe("embedded mode", () => {
		test("a standalone server process.exit(1)s on a fatal start error (default)", async () => {
			const { options } = createTestOptions({
				initDatasource: async () => {
					throw new Error("datasource boom");
				},
			});
			// The mocked process.exit throws `process.exit(1)`; the original error is swallowed by exit.
			await expect(createMcpApplication(options)).rejects.toThrow("process.exit(1)");
		});

		test("an embedded server rethrows the original error instead of exiting", async () => {
			const { options, logger } = createTestOptions({
				embedded: true,
				initDatasource: async () => {
					throw new Error("datasource boom");
				},
			});
			// Rethrows the real error -> the host's .catch handles it; process.exit is NOT called.
			await expect(createMcpApplication(options)).rejects.toThrow("datasource boom");
			expect(exitCode).toBeUndefined();
			// SIO-987: embedded mode does NOT log a misleading level:50 "Fatal" line (the host logs its
			// own actionable WARN); a standalone process still does (asserted in "startup failure" above).
			const errorCalls = logger.calls.filter((c) => c.method === "error");
			expect(errorCalls.some((c) => (c.args[0] as string).includes("Fatal error starting"))).toBe(false);
		});

		test("an embedded server does not install process-global signal handlers", async () => {
			const before = process.listenerCount("SIGINT");
			const { options } = createTestOptions({ embedded: true, initDatasource: async () => ({ id: "x" }) });
			await createMcpApplication(options);
			// No new SIGINT listener was added (the host owns process-global handlers).
			expect(process.listenerCount("SIGINT")).toBe(before);
		});
	});
});
