// shared/src/agentcore-proxy.ts
//
// Local SigV4-signing HTTP proxy that bridges plain HTTP MCP clients to
// AWS Bedrock AgentCore Runtime. Parameterized so any MCP server can use it.

import { createHash, createHmac } from "node:crypto";
import { createMcpLogger } from "./logger.ts";

const logger = createMcpLogger("agentcore-proxy");

// SIO-737: retry policy for transient AgentCore JSON-RPC server errors.
// Codes in the JSON-RPC 2.0 -32099..-32000 "implementation-defined
// server-errors" band are the AgentCore transport layer's way of saying
// the runtime container is not ready (cold-start, throttled, paused).
// -32010 "Runtime health check failed or timed out" is the dominant case.
const JSONRPC_RETRY_BACKOFFS_MS = [300, 800, 1500, 3000] as const;
const JSONRPC_RETRY_MAX_ATTEMPTS = JSONRPC_RETRY_BACKOFFS_MS.length + 1; // 5
const JSONRPC_RETRY_DEADLINE_MS = 30_000;
const JSONRPC_SERVER_ERROR_MIN = -32099;
const JSONRPC_SERVER_ERROR_MAX = -32000;

export function computeJitteredBackoff(baseMs: number): number {
	if (baseMs <= 0) return 0;
	return Math.round(baseMs * (0.8 + Math.random() * 0.4));
}

function isRetryableJsonRpcCode(code: number | undefined): boolean {
	return code !== undefined && code >= JSONRPC_SERVER_ERROR_MIN && code <= JSONRPC_SERVER_ERROR_MAX;
}

function readProxyConfig() {
	const runtimeArn = process.env.AGENTCORE_RUNTIME_ARN;
	if (!runtimeArn) {
		logger.fatal(
			"AGENTCORE_RUNTIME_ARN is required. Example: arn:aws:bedrock:eu-central-1:123456789:agent-runtime/my_mcp_server-XXXXX",
		);
		process.exit(1);
	}

	const region = process.env.AGENTCORE_REGION || process.env.AWS_REGION || "eu-central-1";
	const port = parseInt(process.env.AGENTCORE_PROXY_PORT || "3000", 10);
	const qualifier = process.env.AGENTCORE_QUALIFIER || "DEFAULT";
	const serverName = process.env.MCP_SERVER_NAME || "mcp-server";

	const encodedArn = encodeURIComponent(runtimeArn);
	const basePath = `/runtimes/${encodedArn}/invocations`;
	const baseUrl = `https://bedrock-agentcore.${region}.amazonaws.com`;
	const queryString = `qualifier=${qualifier}`;
	const fullUrl = `${baseUrl}${basePath}?${queryString}`;

	return { runtimeArn, region, port, qualifier, serverName, basePath, baseUrl, queryString, fullUrl };
}

interface AwsCreds {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
}

let cachedCreds: AwsCreds | null = null;
let credsExpiresAt = 0;

// SIO-733: test seam. Lets the round-trip suite reset the cache between
// proxy restarts when credential env vars change mid-suite. Not used by
// production code.
export function clearCredentialCache(): void {
	cachedCreds = null;
	credsExpiresAt = 0;
}

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

function sha256(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
	return createHmac("sha256", key).update(data).digest();
}

// SigV4 requires double URI-encoding of path segments for non-S3 services.
function uriEncodePathForSigV4(pathname: string): string {
	return pathname
		.split("/")
		.map((segment) => encodeURIComponent(segment).replace(/!/g, "%21"))
		.join("/");
}

function signRequest(method: string, url: URL, body: string, creds: AwsCreds, region: string): Record<string, string> {
	const service = "bedrock-agentcore";
	const now = new Date();
	const amzDate = now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z/, "Z");
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
	const canonicalHeaders = `${signedHeaderKeys.map((k) => `${k}:${headers[k]?.trim()}`).join("\n")}\n`;
	const canonicalQs = url.search ? url.search.slice(1) : "";

	const canonicalRequest = [method, canonicalUri, canonicalQs, canonicalHeaders, signedHeaders, payloadHash].join("\n");

	// String to sign
	const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
	const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256(canonicalRequest)].join("\n");

	// Signing key
	const kDate = hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
	const kRegion = hmac(kDate, region);
	const kService = hmac(kRegion, service);
	const kSigning = hmac(kService, "aws4_request");
	const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

	headers.authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

	return headers;
}

// SIO-718: classify a proxied JSON-RPC response body so the dev log can show
// the actual tool outcome on each line. The AgentCore HTTP envelope is always
// 200 when AgentCore is reachable, even if the MCP tool inside returned
// isError: true with an upstream 5xx -- without this, a healthy AgentCore
// masking a sick upstream looks identical to a fully working call.
export function classifyToolStatus(rawBody: string): string {
	// SSE responses arrive as "event: message\ndata: <json>\n\n" -- strip framing
	// before JSON-parsing. The MCP streamable-HTTP transport emits at most one
	// data frame per tool result; we look at the last data: line to cover any
	// future multi-frame case.
	const dataLines = rawBody.split("\n").filter((l) => l.startsWith("data: "));
	const jsonText = dataLines.length > 0 ? dataLines[dataLines.length - 1]?.slice(6) : rawBody.trim();
	if (!jsonText) {
		return "unparseable";
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		return "unparseable";
	}

	if (typeof parsed !== "object" || parsed === null) {
		return "unparseable";
	}

	const obj = parsed as Record<string, unknown>;
	// Transport-level JSON-RPC error (distinct from a tool returning isError)
	if (obj.error && typeof obj.error === "object") {
		return "jsonrpc-error";
	}

	const result = obj.result;
	if (typeof result !== "object" || result === null) {
		return "unparseable";
	}
	const resultObj = result as Record<string, unknown>;
	if (!resultObj.isError) {
		return "ok";
	}

	// isError: true -- extract a short class label from the first text content
	const content = resultObj.content;
	if (!Array.isArray(content) || content.length === 0) {
		return "error (unclassified)";
	}
	const first = content[0] as Record<string, unknown> | undefined;
	const text = typeof first?.text === "string" ? first.text : "";
	if (!text) {
		return "error (no-text)";
	}

	// Match "MCP error -32603: ksqlDB error 503:" pattern produced by our
	// service wrappers (ksql-service, connect-service, schema-registry-service,
	// restproxy-service). Captures "ksqlDB 503", "Kafka Connect 503", etc.
	const serviceCodeMatch = text.match(/MCP error -?\d+:\s+([\w\s]+?)\s+error\s+(\d+):/);
	if (serviceCodeMatch) {
		return `error (${serviceCodeMatch[1]?.trim()} ${serviceCodeMatch[2]})`;
	}

	// Generic "MCP error -32603: ..." fallback -- take the first line of the
	// message, capped at 60 chars to keep the log line skimmable.
	const genericMatch = text.match(/MCP error -?\d+:\s+([^\n]+)/);
	if (genericMatch) {
		const snippet = genericMatch[1]?.trim().slice(0, 60) ?? "";
		return `error (${snippet})`;
	}

	return "error (unparsed)";
}

// SIO-737: parse out the JSON-RPC error.code from a response body so the
// POST handler can decide whether to retry. Returns undefined for a
// success body, malformed body, or an error object without a numeric
// code. Shares SSE-frame stripping with classifyToolStatus.
export function extractJsonRpcErrorCode(rawBody: string): number | undefined {
	const dataLines = rawBody.split("\n").filter((l) => l.startsWith("data: "));
	const jsonText = dataLines.length > 0 ? dataLines[dataLines.length - 1]?.slice(6) : rawBody.trim();
	if (!jsonText) return undefined;

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		return undefined;
	}

	if (typeof parsed !== "object" || parsed === null) return undefined;
	const obj = parsed as Record<string, unknown>;
	const err = obj.error;
	if (typeof err !== "object" || err === null) return undefined;
	const code = (err as Record<string, unknown>).code;
	return typeof code === "number" ? code : undefined;
}

// SIO-718: pick the log severity for a proxied tool call based on its tool
// status. Successful calls stay at info so the bulk of normal traffic is
// unobtrusive; everything else (real upstream errors, parse failures,
// transport-level JSON-RPC errors) escalates to warn so failures are visually
// distinguishable in a wall of info lines.
export function severityForToolStatus(status: string): "info" | "warn" {
	return status === "ok" ? "info" : "warn";
}

// Proxy handle returned to bootstrap for lifecycle management
export interface AgentCoreProxyHandle {
	port: number;
	url: string;
	close(): Promise<void>;
}

export async function startAgentCoreProxy(): Promise<AgentCoreProxyHandle> {
	const cfg = readProxyConfig();
	let mcpSessionId: string | undefined;

	const server = Bun.serve({
		port: cfg.port,
		hostname: "127.0.0.1",
		idleTimeout: 120,

		routes: {
			"/mcp": {
				POST: async (req: Request) => {
					const body = await req.text();
					const maxAttempts = 2;

					// SIO-626: Log tool calls passing through the proxy for observability
					let toolName: string | undefined;
					try {
						const parsed = JSON.parse(body);
						if (parsed.method === "tools/call" && parsed.params?.name) {
							toolName = parsed.params.name;
							logger.info({ tool: toolName, id: parsed.id }, `Proxying tool call: ${toolName}`);
						}
					} catch {
						// Not valid JSON or not a tool call -- continue silently
					}

					for (let attempt = 1; attempt <= maxAttempts; attempt++) {
						try {
							const creds = await getCredentials();
							const targetUrl = new URL(`${cfg.basePath}?${cfg.queryString}`, cfg.baseUrl);

							const headers = signRequest("POST", targetUrl, body, creds, cfg.region);

							if (mcpSessionId) {
								headers["mcp-session-id"] = mcpSessionId;
							}

							const response = await fetch(targetUrl.toString(), {
								method: "POST",
								headers,
								body,
								signal: AbortSignal.timeout(30_000),
							});

							const respSessionId = response.headers.get("mcp-session-id");
							if (respSessionId) mcpSessionId = respSessionId;

							const respHeaders = new Headers();
							respHeaders.set("content-type", response.headers.get("content-type") || "application/json");
							if (respSessionId) respHeaders.set("mcp-session-id", respSessionId);

							// SIO-718: read the cloned body so we can log the actual tool
							// outcome on each line. Clone leaves response.body intact for
							// streaming back to the caller. The HTTP envelope status is
							// only surfaced when non-2xx -- on the happy path it is always
							// 200 even when the wrapped tool failed, so logging it on every
							// line is pure noise that obscures the tool result.
							let toolStatus: string | undefined;
							if (toolName) {
								try {
									const clonedBody = await response.clone().text();
									toolStatus = classifyToolStatus(clonedBody);
								} catch (err) {
									toolStatus = "unparseable";
									logger.debug(
										{ tool: toolName, err: err instanceof Error ? err.message : String(err) },
										"Failed to read cloned response body for tool-status logging",
									);
								}
								// Emit at warn when the tool call failed (any non-ok status),
								// info when it succeeded. Without this, real upstream failures
								// sit in the same column as the dozens of successful calls in
								// a typical agent run and get visually missed.
								const severity = severityForToolStatus(toolStatus ?? "unparseable");
								const logFn = severity === "info" ? logger.info.bind(logger) : logger.warn.bind(logger);
								const httpAbnormal = response.status >= 300;
								const logFields: Record<string, unknown> = { tool: toolName, status: toolStatus };
								if (httpAbnormal) logFields.httpStatus = response.status;
								const msgSuffix = httpAbnormal ? `${toolStatus} (http ${response.status})` : toolStatus;
								logFn(logFields, `Tool call proxied: ${toolName} -> ${msgSuffix}`);
							}

							return new Response(response.body, {
								status: response.status,
								headers: respHeaders,
							});
						} catch (error) {
							const isRetryable =
								error instanceof Error &&
								(error.name === "TimeoutError" ||
									error.message.includes("aborted") ||
									error.message.includes("ECONNRESET"));

							if (isRetryable && attempt < maxAttempts) {
								logger.warn(
									{ attempt, error: error instanceof Error ? error.message : String(error) },
									"Proxy request failed, retrying",
								);
								continue;
							}

							logger.error(
								{ err: error instanceof Error ? error : new Error(String(error)), path: "/mcp", attempt },
								"Proxy request failed",
							);
							return Response.json(
								{
									jsonrpc: "2.0",
									error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
									id: null,
								},
								{ status: 502 },
							);
						}
					}

					// Unreachable, but TypeScript requires a return
					return Response.json(
						{ jsonrpc: "2.0", error: { code: -32000, message: "Max retries exceeded" }, id: null },
						{ status: 502 },
					);
				},

				GET: () => new Response("Method not allowed", { status: 405 }),

				DELETE: () => {
					mcpSessionId = undefined;
					return new Response(null, { status: 200 });
				},
			},

			"/health": {
				GET: async () => {
					try {
						await getCredentials();
						return Response.json({ status: "ok", target: "agentcore", region: cfg.region });
					} catch {
						return Response.json({ status: "error", message: "credentials unavailable" }, { status: 503 });
					}
				},
			},

			"/ping": {
				GET: () => Response.json({ status: "ok", proxy: true, target: cfg.fullUrl }),
			},
		},

		fetch: () => Response.json({ error: "Not found" }, { status: 404 }),
	});

	const proxyUrl = `http://127.0.0.1:${server.port}`;

	logger.info(
		{ port: server.port, target: cfg.fullUrl, region: cfg.region, serverName: cfg.serverName },
		`AgentCore SigV4 Proxy running at ${proxyUrl}`,
	);

	return {
		port: server.port ?? 0,
		url: proxyUrl,
		async close() {
			server.stop(true);
			logger.info("AgentCore proxy closed");
		},
	};
}

// Standalone execution: `bun run shared/src/agentcore-proxy.ts`
if (import.meta.main) {
	startAgentCoreProxy();
}
