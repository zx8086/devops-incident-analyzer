#!/usr/bin/env bun
// mcp-server-kafka/src/agentcore-proxy.ts

import { createHash, createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const RUNTIME_ARN = process.env.AGENTCORE_RUNTIME_ARN;
const REGION = process.env.AGENTCORE_REGION || process.env.AWS_REGION || "eu-central-1";
const LOCAL_PORT = parseInt(process.env.AGENTCORE_PROXY_PORT || "3000", 10);
const QUALIFIER = process.env.AGENTCORE_QUALIFIER || "DEFAULT";

if (!RUNTIME_ARN) {
	console.error("AGENTCORE_RUNTIME_ARN is required");
	console.error("   Example: arn:aws:bedrock:eu-central-1:123456789:agent-runtime/kafka_mcp_server-XXXXX");
	process.exit(1);
}

const encodedArn = encodeURIComponent(RUNTIME_ARN);
const AGENTCORE_BASE = `https://bedrock-agentcore.${REGION}.amazonaws.com`;
const AGENTCORE_PATH = `/runtimes/${encodedArn}/invocations`;
const AGENTCORE_QS = `qualifier=${QUALIFIER}`;
const AGENTCORE_URL = `${AGENTCORE_BASE}${AGENTCORE_PATH}?${AGENTCORE_QS}`;

// ---------------------------------------------------------------------------
// AWS credential resolution
// ---------------------------------------------------------------------------
interface AwsCreds {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
}

let cachedCreds: AwsCreds | null = null;
let credsExpiresAt = 0;

async function getCredentials(): Promise<AwsCreds> {
	// Return cached if still valid (5min buffer)
	if (cachedCreds && Date.now() < credsExpiresAt - 300_000) {
		return cachedCreds;
	}

	// Try proxy-specific env vars first (AGENTCORE_AWS_*), then generic AWS_*
	const accessKeyId = process.env.AGENTCORE_AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
	const secretAccessKey = process.env.AGENTCORE_AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
	const sessionToken = process.env.AGENTCORE_AWS_SESSION_TOKEN || process.env.AWS_SESSION_TOKEN;

	if (accessKeyId && secretAccessKey) {
		cachedCreds = { accessKeyId, secretAccessKey, sessionToken };
		credsExpiresAt = Date.now() + 3600_000; // env creds don't expire, refresh hourly
		return cachedCreds;
	}

	// Fall back to AWS CLI credential export
	try {
		const proc = Bun.spawn(["aws", "configure", "export-credentials", "--format", "env-no-export"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const output = await new Response(proc.stdout).text();
		await proc.exited;

		const vars: Record<string, string> = {};
		for (const line of output.split("\n")) {
			const eq = line.indexOf("=");
			if (eq > 0) vars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
		}

		if (vars.AWS_ACCESS_KEY_ID && vars.AWS_SECRET_ACCESS_KEY) {
			cachedCreds = {
				accessKeyId: vars.AWS_ACCESS_KEY_ID,
				secretAccessKey: vars.AWS_SECRET_ACCESS_KEY,
				sessionToken: vars.AWS_SESSION_TOKEN,
			};
			// Session tokens typically expire in 1h; refresh after 45min
			credsExpiresAt = Date.now() + 2700_000;
			return cachedCreds;
		}
	} catch {
		// fall through
	}

	throw new Error("No AWS credentials found. Set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or configure AWS CLI.");
}

// ---------------------------------------------------------------------------
// SigV4 signing (minimal, for bedrock-agentcore service)
// ---------------------------------------------------------------------------
function sha256(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
	return createHmac("sha256", key).update(data).digest();
}

// SigV4 requires double URI-encoding of path segments for non-S3 services.
// The pathname from URL already has single-encoded chars (%3A, %2F).
// We need to encode each segment again so %3A becomes %253A.
function uriEncodePathForSigV4(pathname: string): string {
	return pathname
		.split("/")
		.map((segment) => encodeURIComponent(segment).replace(/!/g, "%21"))
		.join("/");
}

function signRequest(
	method: string,
	url: URL,
	body: string,
	creds: AwsCreds,
): Record<string, string> {
	const service = "bedrock-agentcore";
	const now = new Date();
	const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z/, "Z");
	const dateStamp = amzDate.slice(0, 8);

	const headers: Record<string, string> = {
		host: url.host,
		"x-amz-date": amzDate,
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
	};

	if (creds.sessionToken) {
		headers["x-amz-security-token"] = creds.sessionToken;
	}

	const payloadHash = sha256(body);

	// Canonical request -- double-encode path for SigV4
	const canonicalUri = uriEncodePathForSigV4(url.pathname);
	const signedHeaderKeys = Object.keys(headers).sort();
	const signedHeaders = signedHeaderKeys.join(";");
	const canonicalHeaders = signedHeaderKeys.map((k) => `${k}:${headers[k]!.trim()}`).join("\n") + "\n";
	const canonicalQs = url.search ? url.search.slice(1) : "";

	const canonicalRequest = [method, canonicalUri, canonicalQs, canonicalHeaders, signedHeaders, payloadHash].join(
		"\n",
	);

	// String to sign
	const credentialScope = `${dateStamp}/${REGION}/${service}/aws4_request`;
	const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256(canonicalRequest)].join("\n");

	// Signing key
	const kDate = hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
	const kRegion = hmac(kDate, REGION);
	const kService = hmac(kRegion, service);
	const kSigning = hmac(kService, "aws4_request");
	const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

	headers.authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

	return headers;
}

// ---------------------------------------------------------------------------
// MCP session tracking
// ---------------------------------------------------------------------------
let mcpSessionId: string | undefined;

// ---------------------------------------------------------------------------
// HTTP proxy server
// ---------------------------------------------------------------------------
const server = Bun.serve({
	port: LOCAL_PORT,
	hostname: "127.0.0.1",
	idleTimeout: 120,

	routes: {
		// MCP endpoint -- the agent's MultiServerMCPClient sends requests here
		"/mcp": {
			POST: async (req) => {
				try {
					const body = await req.text();
					const creds = await getCredentials();
					const targetUrl = new URL(`${AGENTCORE_PATH}?${AGENTCORE_QS}`, AGENTCORE_BASE);

					const headers = signRequest("POST", targetUrl, body, creds);

					// Forward MCP session ID if we have one
					if (mcpSessionId) {
						headers["mcp-session-id"] = mcpSessionId;
					}

					const response = await fetch(targetUrl.toString(), {
						method: "POST",
						headers,
						body,
					});

					// Capture session ID
					const respSessionId = response.headers.get("mcp-session-id");
					if (respSessionId) mcpSessionId = respSessionId;

					// Build response
					const respHeaders = new Headers();
					respHeaders.set("content-type", response.headers.get("content-type") || "application/json");
					if (respSessionId) respHeaders.set("mcp-session-id", respSessionId);

					return new Response(response.body, {
						status: response.status,
						headers: respHeaders,
					});
				} catch (error) {
					console.error("[agentcore-proxy] Error:", error);
					return Response.json(
						{
							jsonrpc: "2.0",
							error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
							id: null,
						},
						{ status: 502 },
					);
				}
			},

			// Some MCP clients probe with GET for SSE streams
			GET: () => new Response("Method not allowed", { status: 405 }),

			DELETE: () => {
				mcpSessionId = undefined;
				return new Response(null, { status: 200 });
			},
		},

		// Health endpoint -- used by mcp-bridge.ts health polling
		"/health": {
			GET: async () => {
				try {
					// Verify we can still get credentials (catches expired tokens)
					await getCredentials();
					return Response.json({ status: "ok", target: "agentcore", region: REGION });
				} catch {
					return Response.json({ status: "error", message: "credentials unavailable" }, { status: 503 });
				}
			},
		},

		// Ping -- matches the AgentCore container's /ping
		"/ping": {
			GET: () => Response.json({ status: "ok", proxy: true, target: AGENTCORE_URL }),
		},
	},

	fetch: () => Response.json({ error: "Not found" }, { status: 404 }),
});

console.log(`AgentCore Kafka MCP Proxy running at http://127.0.0.1:${server.port}`);
console.log(`    Target: ${AGENTCORE_URL}`);
console.log(`    Region: ${REGION}`);
console.log("");
console.log(`    Set in .env:`);
console.log(`    KAFKA_MCP_URL=http://localhost:${server.port}`);
