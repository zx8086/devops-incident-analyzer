// packages/shared/src/transport/__tests__/proxy-readiness.test.ts
import { describe, expect, test } from "bun:test";
import { createProxyReadinessProbe } from "../proxy-readiness.ts";

function mockSigv4Fetch(body: unknown, status = 200) {
	return async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// SIO-780: AgentCore's streamable-HTTP MCP transport returns SSE-framed JSON-RPC
// when the upstream is warm. Body is "event: message\ndata: <json>\n\n".
function mockSseSigv4Fetch(jsonBody: unknown, status = 200) {
	const sse = `event: message\ndata: ${JSON.stringify(jsonBody)}\n\n`;
	return async () => new Response(sse, { status, headers: { "Content-Type": "text/event-stream" } });
}

describe("createProxyReadinessProbe", () => {
	test("credentials + sentinel tool present -> ready", async () => {
		const probe = createProxyReadinessProbe({
			role: "kafka-proxy",
			getCredentials: async () => ({}),
			upstreamUrl: "http://example.test/mcp",
			sigv4Fetch: mockSigv4Fetch({ result: { tools: [{ name: "kafka_list_topics" }] } }),
		});
		const snap = await probe();
		expect(snap.ready).toBe(true);
		expect(snap.components).toEqual({ credentials: "ok", agentcoreUpstream: "ok" });
	});

	test("credentials fail -> not ready, agentcoreUpstream still probed", async () => {
		const probe = createProxyReadinessProbe({
			role: "aws-proxy",
			getCredentials: async () => {
				throw new Error("expired creds");
			},
			upstreamUrl: "http://example.test/mcp",
			sigv4Fetch: mockSigv4Fetch({ result: { tools: [{ name: "aws_cloudwatch_describe_alarms" }] } }),
		});
		const snap = await probe();
		expect(snap.ready).toBe(false);
		expect(snap.components.credentials).toBe("unreachable");
		expect(snap.errors?.credentials).toBe("expired creds");
	});

	test("upstream returns wrong sentinel -> not ready", async () => {
		const probe = createProxyReadinessProbe({
			role: "kafka-proxy",
			getCredentials: async () => ({}),
			upstreamUrl: "http://example.test/mcp",
			sigv4Fetch: mockSigv4Fetch({ result: { tools: [{ name: "elastic_search" }] } }),
		});
		const snap = await probe();
		expect(snap.ready).toBe(false);
		expect(snap.components.agentcoreUpstream).toBe("unreachable");
		expect(snap.errors?.agentcoreUpstream).toContain("kafka_list_topics");
	});

	test("upstream returns 503 -> not ready", async () => {
		const probe = createProxyReadinessProbe({
			role: "aws-proxy",
			getCredentials: async () => ({}),
			upstreamUrl: "http://example.test/mcp",
			sigv4Fetch: mockSigv4Fetch({}, 503),
		});
		const snap = await probe();
		expect(snap.ready).toBe(false);
		expect(snap.components.agentcoreUpstream).toBe("unreachable");
		expect(snap.errors?.agentcoreUpstream).toContain("503");
	});

	test("empty tools list -> not ready", async () => {
		const probe = createProxyReadinessProbe({
			role: "kafka-proxy",
			getCredentials: async () => ({}),
			upstreamUrl: "http://example.test/mcp",
			sigv4Fetch: mockSigv4Fetch({ result: { tools: [] } }),
		});
		const snap = await probe();
		expect(snap.ready).toBe(false);
		expect(snap.components.agentcoreUpstream).toBe("unreachable");
	});

	// SIO-780 follow-up: AgentCore returns Content-Type: text/event-stream with
	// "event: message\ndata: <json>" framing once the runtime is warm. The original
	// probe called res.json() and threw "Failed to parse JSON", masking healthy
	// upstreams as unready in production.
	test("SSE-framed success body -> ready", async () => {
		const probe = createProxyReadinessProbe({
			role: "kafka-proxy",
			getCredentials: async () => ({}),
			upstreamUrl: "http://example.test/mcp",
			sigv4Fetch: mockSseSigv4Fetch({ result: { tools: [{ name: "kafka_list_topics" }] }, jsonrpc: "2.0", id: 1 }),
		});
		const snap = await probe();
		expect(snap.ready).toBe(true);
		expect(snap.components.agentcoreUpstream).toBe("ok");
	});

	test("SSE-framed wrong sentinel -> not ready with sentinel error", async () => {
		const probe = createProxyReadinessProbe({
			role: "aws-proxy",
			getCredentials: async () => ({}),
			upstreamUrl: "http://example.test/mcp",
			sigv4Fetch: mockSseSigv4Fetch({ result: { tools: [{ name: "kafka_list_topics" }] }, jsonrpc: "2.0", id: 1 }),
		});
		const snap = await probe();
		expect(snap.ready).toBe(false);
		expect(snap.errors?.agentcoreUpstream).toContain("aws_cloudwatch_describe_alarms");
	});

	// AgentCore returns this JSON-RPC envelope (Content-Type: application/json,
	// HTTP 200) while the runtime is cold-starting. The pre-fix probe parsed it
	// successfully, then mis-reported "expected sentinel tool ... 0 tools" because
	// the sentinel check ran on an error response. Detect -32010 explicitly so the
	// operator sees the actual failure mode.
	test("cold-start -32010 -> not ready with cold-start error", async () => {
		const probe = createProxyReadinessProbe({
			role: "kafka-proxy",
			getCredentials: async () => ({}),
			upstreamUrl: "http://example.test/mcp",
			sigv4Fetch: mockSigv4Fetch({
				jsonrpc: "2.0",
				error: { code: -32010, message: "Runtime health check failed or timed out." },
				id: 1,
			}),
		});
		const snap = await probe();
		expect(snap.ready).toBe(false);
		expect(snap.components.agentcoreUpstream).toBe("unreachable");
		expect(snap.errors?.agentcoreUpstream).toContain("cold-start");
		expect(snap.errors?.agentcoreUpstream).toContain("-32010");
	});

	// Real AWS MCP server registers per-service tools (e.g. aws_cloudwatch_describe_alarms);
	// it does NOT expose a generic dispatcher. The sentinel must match a tool that's
	// always registered. cloudwatch_describe_alarms is the agent's primary triage entry
	// per agents/incident-analyzer/agents/aws-agent/RULES.md.
	test("aws-proxy sentinel is aws_cloudwatch_describe_alarms (single underscore)", async () => {
		const probe = createProxyReadinessProbe({
			role: "aws-proxy",
			getCredentials: async () => ({}),
			upstreamUrl: "http://example.test/mcp",
			sigv4Fetch: mockSigv4Fetch({
				result: {
					tools: [
						{ name: "aws_cloudformation_list_stacks" },
						{ name: "aws_cloudwatch_describe_alarms" },
						{ name: "aws_ec2_describe_instances" },
					],
				},
			}),
		});
		const snap = await probe();
		expect(snap.ready).toBe(true);
		expect(snap.components.agentcoreUpstream).toBe("ok");
	});

	test("SSE-framed -32010 -> not ready with cold-start error", async () => {
		const probe = createProxyReadinessProbe({
			role: "aws-proxy",
			getCredentials: async () => ({}),
			upstreamUrl: "http://example.test/mcp",
			sigv4Fetch: mockSseSigv4Fetch({
				jsonrpc: "2.0",
				error: { code: -32010, message: "Runtime health check failed or timed out." },
				id: 1,
			}),
		});
		const snap = await probe();
		expect(snap.ready).toBe(false);
		expect(snap.errors?.agentcoreUpstream).toContain("cold-start");
	});
});

// SIO-1477: the credentials component used to be a presence check -- it only
// proved getCredentials() did not throw. An expired/revoked/wrong-account key
// still resolves cleanly, so the probe reported credentials:"ok" while every
// signed request was rejected, and the failure surfaced as
// "agentcoreUpstream: unreachable" -- pointing at the network, not at auth.
describe("SIO-1477 credentials validation via signed sts:GetCallerIdentity", () => {
	const STS_URL = "https://sts.eu-central-1.amazonaws.com/";
	const okUpstream = () => mockSigv4Fetch({ result: { tools: [{ name: "aws_cloudwatch_describe_alarms" }] } });

	test("expired token -> credentials fails with the STS reason, not 'ok'", async () => {
		const probe = createProxyReadinessProbe({
			role: "aws-proxy",
			getCredentials: async () => ({ accessKeyId: "ASIA...", secretAccessKey: "x" }),
			upstreamUrl: "http://example.test/mcp",
			sigv4Fetch: okUpstream(),
			stsUrl: STS_URL,
			stsFetch: async () =>
				new Response(
					"<ErrorResponse><Error><Code>ExpiredToken</Code><Message>The security token included in the request is expired</Message></Error></ErrorResponse>",
					{ status: 403 },
				),
		});
		const snap = await probe();
		expect(snap.ready).toBe(false);
		expect(snap.components.credentials).not.toBe("ok");
		expect(snap.errors?.credentials).toContain("ExpiredToken");
		expect(snap.errors?.credentials).toContain("security token included in the request is expired");
	});

	test("wrong-account key -> surfaces InvalidClientTokenId", async () => {
		const probe = createProxyReadinessProbe({
			role: "kafka-proxy",
			getCredentials: async () => ({ accessKeyId: "AKIA...", secretAccessKey: "x" }),
			upstreamUrl: "http://example.test/mcp",
			sigv4Fetch: mockSigv4Fetch({ result: { tools: [{ name: "kafka_list_topics" }] } }),
			stsUrl: STS_URL,
			stsFetch: async () =>
				new Response(
					"<ErrorResponse><Error><Code>InvalidClientTokenId</Code><Message>The security token included in the request is invalid</Message></Error></ErrorResponse>",
					{ status: 403 },
				),
		});
		const snap = await probe();
		expect(snap.ready).toBe(false);
		expect(snap.errors?.credentials).toContain("InvalidClientTokenId");
	});

	test("valid credentials -> credentials ok and probe ready", async () => {
		const probe = createProxyReadinessProbe({
			role: "aws-proxy",
			getCredentials: async () => ({ accessKeyId: "AKIA...", secretAccessKey: "x" }),
			upstreamUrl: "http://example.test/mcp",
			sigv4Fetch: okUpstream(),
			stsUrl: STS_URL,
			stsFetch: async () => new Response(JSON.stringify({ GetCallerIdentityResponse: {} }), { status: 200 }),
		});
		const snap = await probe();
		expect(snap.ready).toBe(true);
		expect(snap.components).toEqual({ credentials: "ok", agentcoreUpstream: "ok" });
	});

	test("no STS seam wired -> falls back to the presence check (back-compat)", async () => {
		const probe = createProxyReadinessProbe({
			role: "aws-proxy",
			getCredentials: async () => ({}),
			upstreamUrl: "http://example.test/mcp",
			sigv4Fetch: okUpstream(),
		});
		const snap = await probe();
		expect(snap.components.credentials).toBe("ok");
	});

	test("getCredentials resolving null -> fails rather than passing silently", async () => {
		const probe = createProxyReadinessProbe({
			role: "aws-proxy",
			getCredentials: async () => null,
			upstreamUrl: "http://example.test/mcp",
			sigv4Fetch: okUpstream(),
		});
		const snap = await probe();
		expect(snap.ready).toBe(false);
		expect(snap.errors?.credentials).toContain("no AWS credentials");
	});
});

// SIO-1477: a 401/403 from the upstream is an auth REJECTION -- the endpoint
// answered. Reporting it as "unreachable" sent operators hunting for a network
// fault when the real cause was a bad credential.
describe("SIO-1477 auth rejection is distinguished from unreachability", () => {
	test("403 -> names authorization, not a transport failure", async () => {
		const probe = createProxyReadinessProbe({
			role: "aws-proxy",
			getCredentials: async () => ({}),
			upstreamUrl: "http://example.test/mcp",
			sigv4Fetch: async () =>
				new Response('{"message":"The security token included in the request is expired"}', { status: 403 }),
		});
		const snap = await probe();
		expect(snap.ready).toBe(false);
		expect(snap.errors?.agentcoreUpstream).toContain("authorization rejected");
		expect(snap.errors?.agentcoreUpstream).toContain("HTTP 403");
		// the upstream's own explanation must survive into the snapshot
		expect(snap.errors?.agentcoreUpstream).toContain("security token included in the request is expired");
	});

	test("401 -> also classified as authorization", async () => {
		const probe = createProxyReadinessProbe({
			role: "kafka-proxy",
			getCredentials: async () => ({}),
			upstreamUrl: "http://example.test/mcp",
			sigv4Fetch: async () => new Response("denied", { status: 401 }),
		});
		const snap = await probe();
		expect(snap.errors?.agentcoreUpstream).toContain("authorization rejected");
	});

	test("503 -> stays a plain status failure, not mislabelled as auth", async () => {
		const probe = createProxyReadinessProbe({
			role: "kafka-proxy",
			getCredentials: async () => ({}),
			upstreamUrl: "http://example.test/mcp",
			sigv4Fetch: async () => new Response("upstream boom", { status: 503 }),
		});
		const snap = await probe();
		expect(snap.errors?.agentcoreUpstream).toContain("503");
		expect(snap.errors?.agentcoreUpstream).not.toContain("authorization rejected");
	});
});

// SIO-1477: STS answers in XML or JSON depending on Accept/error class. The
// JSON shape is what a bad key actually returns over Accept: application/json
// (live-verified), so both must parse to a clean "Code: Message".
describe("SIO-1477 STS error parsing covers both wire formats", () => {
	const base = {
		role: "aws-proxy" as const,
		getCredentials: async () => ({ accessKeyId: "AKIA...", secretAccessKey: "x" }),
		upstreamUrl: "http://example.test/mcp",
		sigv4Fetch: mockSigv4Fetch({ result: { tools: [{ name: "aws_cloudwatch_describe_alarms" }] } }),
		stsUrl: "https://sts.eu-central-1.amazonaws.com/",
	};

	test("JSON error body -> Code: Message, no raw JSON leaked", async () => {
		const snap = await createProxyReadinessProbe({
			...base,
			stsFetch: async () =>
				new Response(
					JSON.stringify({
						Error: { Code: "InvalidClientTokenId", Message: "The security token included in the request is invalid" },
					}),
					{ status: 403 },
				),
		})();
		expect(snap.errors?.credentials).toBe(
			"InvalidClientTokenId: The security token included in the request is invalid",
		);
		expect(snap.errors?.credentials).not.toContain("{");
	});

	test("XML error body -> Code: Message", async () => {
		const snap = await createProxyReadinessProbe({
			...base,
			stsFetch: async () =>
				new Response(
					"<ErrorResponse><Error><Code>ExpiredToken</Code><Message>Token expired</Message></Error></ErrorResponse>",
					{
						status: 403,
					},
				),
		})();
		expect(snap.errors?.credentials).toBe("ExpiredToken: Token expired");
	});

	test("unparseable body -> still reports status without throwing", async () => {
		const snap = await createProxyReadinessProbe({
			...base,
			stsFetch: async () => new Response("<<not xml or json>>", { status: 500 }),
		})();
		expect(snap.errors?.credentials).toContain("500");
	});
});

// SIO-1477 (Greptile P1): a VALID key from the WRONG account returns HTTP 200
// from GetCallerIdentity. Live-verified against real AWS: the previously
// configured key returns 200 for account 356994971776 while the runtime lives
// in 399987695868. Status alone therefore cannot catch this -- and wrong-account
// is this repo's documented historical AgentCore failure mode.
describe("SIO-1477 wrong-account credentials are rejected", () => {
	const base = {
		role: "aws-proxy" as const,
		getCredentials: async () => ({ accessKeyId: "AKIA...", secretAccessKey: "x" }),
		upstreamUrl: "http://example.test/mcp",
		sigv4Fetch: mockSigv4Fetch({ result: { tools: [{ name: "aws_cloudwatch_describe_alarms" }] } }),
		stsUrl: "https://sts.eu-central-1.amazonaws.com/",
	};
	const identityJson = (account: string) =>
		JSON.stringify({ GetCallerIdentityResponse: { GetCallerIdentityResult: { Account: account } } });

	test("valid key from another account -> credentials fails, naming both accounts", async () => {
		const snap = await createProxyReadinessProbe({
			...base,
			expectedAccountId: "399987695868",
			stsFetch: async () => new Response(identityJson("356994971776"), { status: 200 }),
		})();
		expect(snap.ready).toBe(false);
		expect(snap.components.credentials).not.toBe("ok");
		expect(snap.errors?.credentials).toContain("356994971776");
		expect(snap.errors?.credentials).toContain("399987695868");
	});

	test("matching account -> credentials ok", async () => {
		const snap = await createProxyReadinessProbe({
			...base,
			expectedAccountId: "399987695868",
			stsFetch: async () => new Response(identityJson("399987695868"), { status: 200 }),
		})();
		expect(snap.ready).toBe(true);
		expect(snap.components.credentials).toBe("ok");
	});

	test("XML identity body is parsed too", async () => {
		const snap = await createProxyReadinessProbe({
			...base,
			expectedAccountId: "399987695868",
			stsFetch: async () =>
				new Response(
					"<GetCallerIdentityResponse><GetCallerIdentityResult><Account>111122223333</Account></GetCallerIdentityResult></GetCallerIdentityResponse>",
					{
						status: 200,
					},
				),
		})();
		expect(snap.errors?.credentials).toContain("111122223333");
	});

	test("no expectedAccountId -> account check skipped (back-compat)", async () => {
		const snap = await createProxyReadinessProbe({
			...base,
			stsFetch: async () => new Response(identityJson("356994971776"), { status: 200 }),
		})();
		expect(snap.components.credentials).toBe("ok");
	});

	test("unparseable success body -> degrades to 'key is live', does not fail the probe", async () => {
		const snap = await createProxyReadinessProbe({
			...base,
			expectedAccountId: "399987695868",
			stsFetch: async () => new Response("<<unparseable>>", { status: 200 }),
		})();
		expect(snap.components.credentials).toBe("ok");
	});
});
