// test/proxy.test.ts
import { describe, expect, test } from "bun:test";
import { AtlassianMcpProxy, type McpClientLike } from "../src/atlassian-client/proxy.js";

function makeClient(overrides: Partial<McpClientLike> = {}): McpClientLike {
	return {
		listTools: async () => ({ tools: [] }),
		callTool: async () => ({ content: [] }),
		...overrides,
	};
}

describe("AtlassianMcpProxy.resolveCloudId", () => {
	test("passes empty arguments object to getAccessibleAtlassianResources (Rovo Zod requires object)", async () => {
		const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
		const client = makeClient({
			callTool: async (req: { name: string; arguments?: Record<string, unknown> }) => {
				calls.push({ name: req.name, arguments: req.arguments });
				return { content: [{ type: "text", text: JSON.stringify([{ id: "c-x", name: "any" }]) }] };
			},
		});
		const proxy = new AtlassianMcpProxy({ mcpEndpoint: "x", callbackPort: 0, client, siteName: undefined });
		await proxy.resolveCloudId();
		const call = calls.find((c) => c.name === "getAccessibleAtlassianResources");
		expect(call).toBeDefined();
		expect(call?.arguments).toEqual({});
	});

	test("selects first resource when siteName unset", async () => {
		const client = makeClient({
			callTool: async ({ name }: { name: string }) => {
				if (name === "getAccessibleAtlassianResources") {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify([
									{ id: "c-first", name: "primary" },
									{ id: "c-second", name: "secondary" },
								]),
							},
						],
					};
				}
				return { content: [] };
			},
		});
		const proxy = new AtlassianMcpProxy({ mcpEndpoint: "x", callbackPort: 0, client, siteName: undefined });
		await proxy.resolveCloudId();
		expect(proxy.getCloudId()).toBe("c-first");
	});

	test("selects matching siteName", async () => {
		const client = makeClient({
			callTool: async () => ({
				content: [
					{
						type: "text",
						text: JSON.stringify([
							{ id: "c-first", name: "primary" },
							{ id: "c-target", name: "tommy" },
						]),
					},
				],
			}),
		});
		const proxy = new AtlassianMcpProxy({ mcpEndpoint: "x", callbackPort: 0, client, siteName: "tommy" });
		await proxy.resolveCloudId();
		expect(proxy.getCloudId()).toBe("c-target");
	});

	test("throws when no accessible resources", async () => {
		const client = makeClient({
			callTool: async () => ({ content: [{ type: "text", text: "[]" }] }),
		});
		const proxy = new AtlassianMcpProxy({ mcpEndpoint: "x", callbackPort: 0, client, siteName: undefined });
		await expect(proxy.resolveCloudId()).rejects.toThrow(/no accessible resources/i);
	});
});

describe("AtlassianMcpProxy.callTool", () => {
	test("injects cloudId into every call", async () => {
		const captured: Array<{ name: string; arguments: Record<string, unknown> }> = [];
		const client = makeClient({
			callTool: async (req: { name: string; arguments?: Record<string, unknown> }) => {
				captured.push({ name: req.name, arguments: req.arguments ?? {} });
				if (req.name === "getAccessibleAtlassianResources") {
					return { content: [{ type: "text", text: JSON.stringify([{ id: "c-xyz", name: "s" }]) }] };
				}
				return { content: [] };
			},
		});
		const proxy = new AtlassianMcpProxy({ mcpEndpoint: "x", callbackPort: 0, client, siteName: undefined });
		await proxy.resolveCloudId();
		await proxy.callTool("searchJiraIssuesUsingJql", { jql: "project = INC" });
		const searchCall = captured.find((c) => c.name === "searchJiraIssuesUsingJql");
		expect(searchCall?.arguments.cloudId).toBe("c-xyz");
		expect(searchCall?.arguments.jql).toBe("project = INC");
	});

	test("retries once after UnauthorizedError then succeeds", async () => {
		const { UnauthorizedError } = await import("@modelcontextprotocol/sdk/client/auth.js");
		let callCount = 0;
		const client = makeClient({
			callTool: async (req: { name: string }) => {
				if (req.name === "getAccessibleAtlassianResources") {
					return { content: [{ type: "text", text: JSON.stringify([{ id: "c1", name: "s" }]) }] };
				}
				callCount++;
				if (callCount === 1) throw new UnauthorizedError("expired");
				return { content: [{ type: "text", text: "ok" }] };
			},
		});
		let reauthCalled = 0;
		const proxy = new AtlassianMcpProxy({
			mcpEndpoint: "x",
			callbackPort: 0,
			client,
			siteName: undefined,
			reauth: async () => {
				reauthCalled++;
			},
		});
		await proxy.resolveCloudId();
		const result = await proxy.callTool("searchJiraIssuesUsingJql", {});
		expect(reauthCalled).toBe(1);
		expect(callCount).toBe(2);
		expect((result as { content: Array<{ text: string }> }).content[0].text).toBe("ok");
	});

	test("returns ATLASSIAN_AUTH_REQUIRED error result after second failure", async () => {
		const { UnauthorizedError } = await import("@modelcontextprotocol/sdk/client/auth.js");
		const client = makeClient({
			callTool: async (req: { name: string }) => {
				if (req.name === "getAccessibleAtlassianResources") {
					return { content: [{ type: "text", text: JSON.stringify([{ id: "c1", name: "s" }]) }] };
				}
				throw new UnauthorizedError("expired");
			},
		});
		const proxy = new AtlassianMcpProxy({
			mcpEndpoint: "x",
			callbackPort: 0,
			client,
			siteName: undefined,
			reauth: async () => {},
		});
		await proxy.resolveCloudId();
		const result = (await proxy.callTool("searchJiraIssuesUsingJql", {})) as {
			isError?: boolean;
			content: Array<{ text: string }>;
		};
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("ATLASSIAN_AUTH_REQUIRED");
	});
});

// SIO-1111: readiness must answer from passive freshness instead of enqueueing a
// live upstream probe behind fan-out tool calls on the SIO-1097 serialized queue.
describe("AtlassianMcpProxy.probeReadiness (SIO-1111)", () => {
	function makeCountingClient(state: { upstreamCalls: number; resourceId: string }): McpClientLike {
		return makeClient({
			callTool: async (req: { name: string }) => {
				state.upstreamCalls++;
				if (req.name === "getAccessibleAtlassianResources") {
					return { content: [{ type: "text", text: JSON.stringify([{ id: state.resourceId, name: "s" }]) }] };
				}
				return { content: [{ type: "text", text: "ok" }] };
			},
		});
	}

	test("fresh window: returns without an upstream call", async () => {
		let t = 0;
		const state = { upstreamCalls: 0, resourceId: "c-1" };
		const proxy = new AtlassianMcpProxy({
			mcpEndpoint: "x",
			callbackPort: 0,
			client: makeCountingClient(state),
			siteName: undefined,
			now: () => t,
		});
		await proxy.resolveCloudId();
		expect(state.upstreamCalls).toBe(1);

		t = 89_000; // still inside the default 90s window
		await proxy.probeReadiness();
		expect(state.upstreamCalls).toBe(1);
	});

	test("stale window: performs a live resolve and refreshes cloudId", async () => {
		let t = 0;
		const state = { upstreamCalls: 0, resourceId: "c-1" };
		const proxy = new AtlassianMcpProxy({
			mcpEndpoint: "x",
			callbackPort: 0,
			client: makeCountingClient(state),
			siteName: undefined,
			now: () => t,
		});
		await proxy.resolveCloudId();

		t = 91_000;
		state.resourceId = "c-migrated";
		await proxy.probeReadiness();
		expect(state.upstreamCalls).toBe(2);
		expect(proxy.getCloudId()).toBe("c-migrated");
	});

	test("honors a custom readinessFreshnessWindowMs", async () => {
		let t = 0;
		const state = { upstreamCalls: 0, resourceId: "c-1" };
		const proxy = new AtlassianMcpProxy({
			mcpEndpoint: "x",
			callbackPort: 0,
			client: makeCountingClient(state),
			siteName: undefined,
			readinessFreshnessWindowMs: 10_000,
			now: () => t,
		});
		await proxy.resolveCloudId();

		t = 10_001;
		await proxy.probeReadiness();
		expect(state.upstreamCalls).toBe(2);
	});

	test("busy queue: probe resolves immediately while a slow tool call is in flight (the incident)", async () => {
		let t = 0;
		let releaseSlowCall: (() => void) | undefined;
		const slowGate = new Promise<void>((resolve) => {
			releaseSlowCall = resolve;
		});
		const client = makeClient({
			callTool: async (req: { name: string }) => {
				if (req.name === "getAccessibleAtlassianResources") {
					return { content: [{ type: "text", text: JSON.stringify([{ id: "c-1", name: "s" }]) }] };
				}
				await slowGate;
				return { content: [{ type: "text", text: "slow-ok" }] };
			},
		});
		const proxy = new AtlassianMcpProxy({
			mcpEndpoint: "x",
			callbackPort: 0,
			client,
			siteName: undefined,
			now: () => t,
		});
		await proxy.resolveCloudId();

		const slowCall = proxy.callTool("searchJiraIssuesUsingJql", {});
		t = 30_000; // fresh (stamp at 0, window 90s)
		const probeOutcome = await Promise.race([
			proxy.probeReadiness().then(() => "probe-resolved"),
			new Promise<string>((resolve) => setTimeout(() => resolve("probe-stuck"), 50)),
		]);
		expect(probeOutcome).toBe("probe-resolved");

		releaseSlowCall?.();
		await slowCall;
	});

	test("a successful tool call extends freshness", async () => {
		let t = 0;
		const state = { upstreamCalls: 0, resourceId: "c-1" };
		const proxy = new AtlassianMcpProxy({
			mcpEndpoint: "x",
			callbackPort: 0,
			client: makeCountingClient(state),
			siteName: undefined,
			now: () => t,
		});
		await proxy.resolveCloudId(); // stamp at t=0

		t = 60_000;
		await proxy.callTool("searchJiraIssuesUsingJql", {}); // stamp at t=60_000
		expect(state.upstreamCalls).toBe(2);

		t = 140_000; // >90s after boot, <90s after the tool call
		await proxy.probeReadiness();
		expect(state.upstreamCalls).toBe(2);
	});

	test("failed calls do not extend freshness; a failing live probe rejects (renders unreachable)", async () => {
		let t = 0;
		let failUpstream = false;
		const client = makeClient({
			callTool: async (req: { name: string }) => {
				if (failUpstream) throw new Error("ECONNRESET talking to Rovo");
				if (req.name === "getAccessibleAtlassianResources") {
					return { content: [{ type: "text", text: JSON.stringify([{ id: "c-1", name: "s" }]) }] };
				}
				return { content: [{ type: "text", text: "ok" }] };
			},
		});
		const proxy = new AtlassianMcpProxy({
			mcpEndpoint: "x",
			callbackPort: 0,
			client,
			siteName: undefined,
			now: () => t,
		});
		await proxy.resolveCloudId(); // stamp at t=0

		failUpstream = true;
		t = 60_000;
		await expect(proxy.callTool("searchJiraIssuesUsingJql", {})).rejects.toThrow("ECONNRESET");

		t = 95_000; // stamp still 0 -> stale -> live probe, which also fails
		await expect(proxy.probeReadiness()).rejects.toThrow("ECONNRESET");
	});

	// SIO-1111 review: a live probe can fail AFTER the transport call fulfilled
	// (parse/site validation) -- the enqueue stamp fires on fulfillment, so without
	// the reset a failed probe would flap back to healthy for a whole window.
	test("a failed live probe does not flap back to healthy on the next probe", async () => {
		let t = 0;
		let siteMissing = false;
		const state = { upstreamCalls: 0 };
		const client = makeClient({
			callTool: async () => {
				state.upstreamCalls++;
				// Transport always fulfills; after the flip the configured site is gone.
				const resources = siteMissing ? [{ id: "c-other", name: "other-site" }] : [{ id: "c-1", name: "tommy" }];
				return { content: [{ type: "text", text: JSON.stringify(resources) }] };
			},
		});
		const proxy = new AtlassianMcpProxy({ mcpEndpoint: "x", callbackPort: 0, client, siteName: "tommy", now: () => t });
		await proxy.resolveCloudId(); // stamp at t=0
		expect(state.upstreamCalls).toBe(1);

		siteMissing = true;
		t = 91_000; // stale -> live probe: transport fulfills (stamps 91k) but validation fails
		await expect(proxy.probeReadiness()).rejects.toThrow(/not found/i);

		t = 92_000; // within 90s of the fulfilled-but-invalid call -- must NOT read healthy
		await expect(proxy.probeReadiness()).rejects.toThrow(/not found/i);
		expect(state.upstreamCalls).toBe(3);
	});
});

// SIO-1111: the previously dead atlassian.timeout config must bound every
// upstream Rovo call via the SDK's RequestOptions (positional third argument).
describe("AtlassianMcpProxy upstream timeout wiring (SIO-1111)", () => {
	function makeOptionsCapturingClient(captured: Array<{ name: string; timeout?: number }>): McpClientLike {
		return makeClient({
			callTool: async (req: { name: string }, _schema?: unknown, options?: { timeout?: number }) => {
				captured.push({ name: req.name, timeout: options?.timeout });
				if (req.name === "getAccessibleAtlassianResources") {
					return { content: [{ type: "text", text: JSON.stringify([{ id: "c-1", name: "s" }]) }] };
				}
				return { content: [{ type: "text", text: "ok" }] };
			},
		});
	}

	test("passes the configured timeout on resolveCloudId and callTool", async () => {
		const captured: Array<{ name: string; timeout?: number }> = [];
		const proxy = new AtlassianMcpProxy({
			mcpEndpoint: "x",
			callbackPort: 0,
			client: makeOptionsCapturingClient(captured),
			siteName: undefined,
			timeout: 12_345,
		});
		await proxy.resolveCloudId();
		await proxy.callTool("searchJiraIssuesUsingJql", {});
		expect(captured).toEqual([
			{ name: "getAccessibleAtlassianResources", timeout: 12_345 },
			{ name: "searchJiraIssuesUsingJql", timeout: 12_345 },
		]);
	});

	test("defaults to 30s when no timeout is configured", async () => {
		const captured: Array<{ name: string; timeout?: number }> = [];
		const proxy = new AtlassianMcpProxy({
			mcpEndpoint: "x",
			callbackPort: 0,
			client: makeOptionsCapturingClient(captured),
			siteName: undefined,
		});
		await proxy.resolveCloudId();
		expect(captured[0]?.timeout).toBe(30_000);
	});

	// SIO-1111 review: startup discovery must honor the per-call timeout too.
	test("passes the configured timeout on listTools", async () => {
		let capturedTimeout: number | undefined;
		const client = makeClient({
			listTools: async (_params?: unknown, options?: { timeout?: number }) => {
				capturedTimeout = options?.timeout;
				return { tools: [] };
			},
		});
		const proxy = new AtlassianMcpProxy({
			mcpEndpoint: "x",
			callbackPort: 0,
			client,
			siteName: undefined,
			timeout: 12_345,
		});
		await proxy.listTools();
		expect(capturedTimeout).toBe(12_345);
	});
});

describe("AtlassianMcpProxy.disconnect invalidates readiness state (SIO-1111)", () => {
	test("cloudId and freshness reset; next probe performs a live resolve", async () => {
		let t = 0;
		const state = { upstreamCalls: 0, resourceId: "c-1" };
		const client = makeClient({
			callTool: async (req: { name: string }) => {
				state.upstreamCalls++;
				if (req.name === "getAccessibleAtlassianResources") {
					return { content: [{ type: "text", text: JSON.stringify([{ id: state.resourceId, name: "s" }]) }] };
				}
				return { content: [] };
			},
		});
		const proxy = new AtlassianMcpProxy({
			mcpEndpoint: "x",
			callbackPort: 0,
			client,
			siteName: undefined,
			now: () => t,
		});
		await proxy.resolveCloudId();
		expect(state.upstreamCalls).toBe(1);

		await proxy.disconnect();
		expect(() => proxy.getCloudId()).toThrow(/not resolved/i);

		t = 1_000; // still inside the window relative to the old stamp, but stamp was reset
		await proxy.probeReadiness();
		expect(state.upstreamCalls).toBe(2);
	});
});
