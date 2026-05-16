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

export function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) {
		return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
	}
	return new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
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

export interface ProxyCredentials {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
}

/**
 * Configuration for one running SigV4 proxy instance. Passed explicitly to
 * startAgentCoreProxy(); no process.env reads inside the proxy.
 */
export interface ProxyConfig {
	runtimeArn: string;
	region: string;
	port: number;
	qualifier: string;
	serverName: string;
	/**
	 * Either a static credentials object (for env-var creds) or an async
	 * function (for AWS-CLI profile fallback, which may need to re-shell when
	 * session-tokens expire).
	 */
	credentials: ProxyCredentials | (() => Promise<ProxyCredentials>);
}

/**
 * Build a ProxyConfig from per-server-prefixed env vars. Reads ONLY the
 * <prefix>_AGENTCORE_* namespace; never falls back to a generic AGENTCORE_*
 * var. Throws if required vars are missing.
 *
 * Required env vars per prefix:
 *   - <PREFIX>_AGENTCORE_RUNTIME_ARN
 *   - <PREFIX>_AGENTCORE_REGION
 *   - <PREFIX>_AGENTCORE_PROXY_PORT
 *
 * Optional env vars:
 *   - <PREFIX>_AGENTCORE_QUALIFIER (default "DEFAULT")
 *   - <PREFIX>_AGENTCORE_SERVER_NAME (default "mcp-server")
 *   - <PREFIX>_AGENTCORE_AWS_ACCESS_KEY_ID + _SECRET_ACCESS_KEY (+ _SESSION_TOKEN)
 *   - <PREFIX>_AGENTCORE_AWS_PROFILE (AWS CLI profile for lazy fallback)
 */
export function loadProxyConfigFromEnv(prefix: string): ProxyConfig {
	const runtimeArn = process.env[`${prefix}_AGENTCORE_RUNTIME_ARN`];
	if (!runtimeArn) {
		throw new Error(`${prefix}_AGENTCORE_RUNTIME_ARN is required`);
	}
	const region = process.env[`${prefix}_AGENTCORE_REGION`];
	if (!region) {
		throw new Error(`${prefix}_AGENTCORE_REGION is required`);
	}
	const portRaw = process.env[`${prefix}_AGENTCORE_PROXY_PORT`];
	if (!portRaw) {
		throw new Error(`${prefix}_AGENTCORE_PROXY_PORT is required`);
	}
	const port = Number.parseInt(portRaw, 10);
	if (!Number.isFinite(port) || port < 1 || port > 65535) {
		throw new Error(`${prefix}_AGENTCORE_PROXY_PORT must be an integer in 1..65535, got: ${portRaw}`);
	}
	const qualifier = process.env[`${prefix}_AGENTCORE_QUALIFIER`] ?? "DEFAULT";
	const serverName = process.env[`${prefix}_AGENTCORE_SERVER_NAME`] ?? "mcp-server";

	const accessKeyId = process.env[`${prefix}_AGENTCORE_AWS_ACCESS_KEY_ID`];
	const secretAccessKey = process.env[`${prefix}_AGENTCORE_AWS_SECRET_ACCESS_KEY`];
	const sessionToken = process.env[`${prefix}_AGENTCORE_AWS_SESSION_TOKEN`];
	const awsProfile = process.env[`${prefix}_AGENTCORE_AWS_PROFILE`];

	let credentials: ProxyConfig["credentials"];
	if (accessKeyId && secretAccessKey) {
		credentials = { accessKeyId, secretAccessKey, sessionToken };
	} else {
		// Lazy AWS-CLI fallback. The function shells out on each call; the
		// proxy caches the result per-handle (see startAgentCoreProxy below).
		credentials = async () => {
			const args = ["configure", "export-credentials", "--format", "env-no-export"];
			if (awsProfile) args.push("--profile", awsProfile);
			const proc = Bun.spawn(["aws", ...args], { stdout: "pipe", stderr: "pipe" });
			const output = await new Response(proc.stdout).text();
			await proc.exited;

			const vars: Record<string, string> = {};
			for (const line of output.split("\n")) {
				const eq = line.indexOf("=");
				if (eq > 0) vars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
			}
			if (!vars.AWS_ACCESS_KEY_ID || !vars.AWS_SECRET_ACCESS_KEY) {
				const profileNote = awsProfile ? ` (profile: ${awsProfile})` : "";
				throw new Error(`No AWS credentials from 'aws configure export-credentials'${profileNote}`);
			}
			return {
				accessKeyId: vars.AWS_ACCESS_KEY_ID,
				secretAccessKey: vars.AWS_SECRET_ACCESS_KEY,
				sessionToken: vars.AWS_SESSION_TOKEN,
			};
		};
	}

	return { runtimeArn, region, port, qualifier, serverName, credentials };
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

export interface JsonRpcErrorInfo {
	code: number;
	message?: string;
}

// SIO-740: parse error.code AND error.message so logs can surface what the
// upstream actually said, not just the numeric class. message is only set
// when present and non-empty after trimming, so callers can spread the
// field conditionally without emitting jsonRpcMessage: "".
export function extractJsonRpcError(rawBody: string): JsonRpcErrorInfo | undefined {
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
	const err = (parsed as Record<string, unknown>).error;
	if (typeof err !== "object" || err === null) return undefined;
	const errObj = err as Record<string, unknown>;
	if (typeof errObj.code !== "number") return undefined;
	const info: JsonRpcErrorInfo = { code: errObj.code };
	if (typeof errObj.message === "string" && errObj.message.trim() !== "") {
		info.message = errObj.message;
	}
	return info;
}

// SIO-737: kept for callers that only need the numeric code. Delegates to
// extractJsonRpcError so the two helpers stay in lockstep.
export function extractJsonRpcErrorCode(rawBody: string): number | undefined {
	return extractJsonRpcError(rawBody)?.code;
}

// SIO-718: pick the log severity for a proxied tool call based on its tool
// status. Successful calls stay at info so the bulk of normal traffic is
// unobtrusive; everything else (real upstream errors, parse failures,
// transport-level JSON-RPC errors) escalates to warn so failures are visually
// distinguishable in a wall of info lines.
export function severityForToolStatus(status: string): "info" | "warn" {
	return status === "ok" ? "info" : "warn";
}

// SIO-745: AgentCore Runtime cold-starts emit -32010 "Runtime health check
// failed or timed out" for the first 1-2 requests after the container wakes,
// then recovers. Logging every cold-start retry at warn floods incident reports
// with 4-8 lines that look like a failure even when the recovery is automatic.
// Log attempt 1 of -32010 at debug; escalate to warn from attempt 2 onward.
// All other retryable -320xx codes stay at warn from attempt 1.
const AGENTCORE_HEALTH_CHECK_CODE = -32010;

export function severityForJsonRpcRetry(jsonRpcCode: number | undefined, attempt: number): "debug" | "warn" {
	if (jsonRpcCode === AGENTCORE_HEALTH_CHECK_CODE && attempt <= 1) return "debug";
	return "warn";
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
	// SIO-737: paired with mcpSessionId. DELETE aborts whichever retry
	// loop is mid-flight for the session being torn down. Lazy-initialised
	// on the first POST so an idle proxy holds no signal.
	let currentSessionAbort: AbortController | undefined;

	const server = Bun.serve({
		port: cfg.port,
		hostname: "127.0.0.1",
		idleTimeout: 120,

		routes: {
			"/mcp": {
				POST: async (req: Request) => {
					const body = await req.text();
					const tcpMaxAttempts = 2;
					const requestStart = Date.now();
					const deadline = requestStart + JSONRPC_RETRY_DEADLINE_MS;

					if (!currentSessionAbort) currentSessionAbort = new AbortController();
					const sessionAbort = currentSessionAbort;

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

					// SIO-737: Inner TCP-level fetch with the original 2-attempt retry
					// on TimeoutError/aborted/ECONNRESET. Returns the upstream Response
					// plus its body (already consumed for classification) or a 502
					// envelope on terminal TCP failure.
					const doFetchWithTcpRetry = async (): Promise<{
						response: Response;
						clonedBody: string;
						terminalFailure: boolean;
					}> => {
						for (let attempt = 1; attempt <= tcpMaxAttempts; attempt++) {
							try {
								const creds = await getCredentials();
								const targetUrl = new URL(`${cfg.basePath}?${cfg.queryString}`, cfg.baseUrl);
								const headers = signRequest("POST", targetUrl, body, creds, cfg.region);
								if (mcpSessionId) headers["mcp-session-id"] = mcpSessionId;

								const response = await fetch(targetUrl.toString(), {
									method: "POST",
									headers,
									body,
									signal: AbortSignal.any([AbortSignal.timeout(30_000), sessionAbort.signal]),
								});

								const respSessionId = response.headers.get("mcp-session-id");
								if (respSessionId) mcpSessionId = respSessionId;

								const clonedBody = await response.clone().text();
								return { response, clonedBody, terminalFailure: false };
							} catch (error) {
								const isRetryable =
									error instanceof Error &&
									(error.name === "TimeoutError" ||
										error.message.includes("aborted") ||
										error.message.includes("ECONNRESET"));

								if (isRetryable && attempt < tcpMaxAttempts) {
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
								const envelope = Response.json(
									{
										jsonrpc: "2.0",
										error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
										id: null,
									},
									{ status: 502 },
								);
								return { response: envelope, clonedBody: await envelope.clone().text(), terminalFailure: true };
							}
						}
						// Unreachable, kept for exhaustiveness
						const envelope = Response.json(
							{ jsonrpc: "2.0", error: { code: -32000, message: "Max retries exceeded" }, id: null },
							{ status: 502 },
						);
						return { response: envelope, clonedBody: await envelope.clone().text(), terminalFailure: true };
					};

					// SIO-737: Outer JSON-RPC -320xx retry loop. Bails on success,
					// non-retryable code, attempt-budget exhaustion, or cumulative
					// deadline. The 5-attempt budget is independent of the inner TCP
					// retry counter; both share the cumulative 30s wallclock deadline.
					let response: Response | undefined;
					let clonedBody = "";
					let terminalFailure = false;
					for (let jsonRpcAttempt = 1; jsonRpcAttempt <= JSONRPC_RETRY_MAX_ATTEMPTS; jsonRpcAttempt++) {
						({ response, clonedBody, terminalFailure } = await doFetchWithTcpRetry());
						// SIO-737: when the inner TCP loop built a 502 envelope itself,
						// the -32000 inside it is ours -- not AgentCore's. Don't retry on
						// our own failure envelope; surface it to the caller untouched.
						// SIO-740: pull message alongside code so logs surface what the
						// upstream actually said.
						const jsonRpcInfo = terminalFailure ? undefined : extractJsonRpcError(clonedBody);
						const jsonRpcCode = jsonRpcInfo?.code;
						const jsonRpcMessage = jsonRpcInfo?.message;
						const retryable = isRetryableJsonRpcCode(jsonRpcCode);
						const isFinalAttempt = jsonRpcAttempt >= JSONRPC_RETRY_MAX_ATTEMPTS;

						if (!retryable || isFinalAttempt) {
							// Terminal path: log once and break out of the loop.
							if (toolName) {
								const toolStatus = classifyToolStatus(clonedBody);
								const severity = severityForToolStatus(toolStatus);
								const logFn = severity === "info" ? logger.info.bind(logger) : logger.warn.bind(logger);
								const httpAbnormal = response.status >= 300;
								const logFields: Record<string, unknown> = { tool: toolName, status: toolStatus };
								if (httpAbnormal) logFields.httpStatus = response.status;
								if (jsonRpcCode !== undefined) logFields.jsonRpcCode = jsonRpcCode;
								if (jsonRpcMessage !== undefined) logFields.jsonRpcMessage = jsonRpcMessage;
								if (jsonRpcAttempt > 1) {
									logFields.attempt = jsonRpcAttempt;
									logFields.maxAttempts = JSONRPC_RETRY_MAX_ATTEMPTS;
								}
								if (retryable && isFinalAttempt) {
									logFields.gaveUpAfterMs = Date.now() - requestStart;
								}
								if (toolStatus === "ok" && jsonRpcAttempt > 1) {
									logFields.recoveredAfterAttempts = jsonRpcAttempt;
								}
								const msgSuffix = httpAbnormal ? `${toolStatus} (http ${response.status})` : toolStatus;
								logFn(logFields, `Tool call proxied: ${toolName} -> ${msgSuffix}`);
							}
							break;
						}

						// Retryable -320xx with budget remaining. Compute jittered
						// backoff and bail if it would overshoot the cumulative deadline.
						const base = JSONRPC_RETRY_BACKOFFS_MS[jsonRpcAttempt - 1] ?? 0;
						const retryAfterMs = computeJitteredBackoff(base);
						if (Date.now() + retryAfterMs >= deadline) {
							if (toolName) {
								const deadlineFields: Record<string, unknown> = {
									tool: toolName,
									status: classifyToolStatus(clonedBody),
									jsonRpcCode,
									attempt: jsonRpcAttempt,
									maxAttempts: JSONRPC_RETRY_MAX_ATTEMPTS,
									gaveUpDueToDeadline: true,
									totalMs: Date.now() - requestStart,
								};
								if (jsonRpcMessage !== undefined) deadlineFields.jsonRpcMessage = jsonRpcMessage;
								logger.warn(deadlineFields, `Tool call proxied: ${toolName} -> jsonrpc-error (deadline)`);
							}
							break;
						}

						// SIO-745: see severityForJsonRpcRetry -- cold-start -32010 attempt 1 is
						// debug, everything else warn. Recovery still surfaces in the terminal
						// "ok" log via recoveredAfterAttempts.
						const retrySeverity = severityForJsonRpcRetry(jsonRpcCode, jsonRpcAttempt);
						const retryLogFn = retrySeverity === "debug" ? logger.debug.bind(logger) : logger.warn.bind(logger);
						if (toolName) {
							const retryFields: Record<string, unknown> = {
								tool: toolName,
								status: classifyToolStatus(clonedBody),
								jsonRpcCode,
								attempt: jsonRpcAttempt,
								maxAttempts: JSONRPC_RETRY_MAX_ATTEMPTS,
								retryAfterMs,
							};
							if (jsonRpcMessage !== undefined) retryFields.jsonRpcMessage = jsonRpcMessage;
							retryLogFn(retryFields, `Tool call proxied: ${toolName} -> jsonrpc-error (retrying)`);
						} else {
							const anonFields: Record<string, unknown> = { jsonRpcCode, attempt: jsonRpcAttempt, retryAfterMs };
							if (jsonRpcMessage !== undefined) anonFields.jsonRpcMessage = jsonRpcMessage;
							retryLogFn(anonFields, "AgentCore -320xx response, retrying");
						}

						try {
							await sleepWithAbort(retryAfterMs, sessionAbort.signal);
						} catch {
							if (toolName) {
								logger.warn(
									{ tool: toolName, attempt: jsonRpcAttempt, reason: "session-reset" },
									`Tool call proxied: ${toolName} -> aborted`,
								);
							}
							return Response.json(
								{ jsonrpc: "2.0", error: { code: -32000, message: "Session reset during retry" }, id: null },
								{ status: 502 },
							);
						}
					}

					if (!response) {
						// Defensive: loop never executed (impossible because budget >= 1).
						return Response.json(
							{ jsonrpc: "2.0", error: { code: -32000, message: "Internal proxy error" }, id: null },
							{ status: 502 },
						);
					}

					const respHeaders = new Headers();
					respHeaders.set("content-type", response.headers.get("content-type") || "application/json");
					if (mcpSessionId) respHeaders.set("mcp-session-id", mcpSessionId);
					return new Response(clonedBody, { status: response.status, headers: respHeaders });
				},

				GET: () => new Response("Method not allowed", { status: 405 }),

				DELETE: () => {
					// SIO-737: abort any retry sleep mid-flight for this session,
					// then mint a fresh controller for whatever comes next.
					currentSessionAbort?.abort(new Error("Session reset via DELETE"));
					currentSessionAbort = new AbortController();
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
