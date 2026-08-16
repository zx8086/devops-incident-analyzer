// packages/shared/src/transport/proxy-readiness.ts
// SIO-780: readiness probe for the AgentCore SigV4 proxy. /ready combines:
//   1. getCredentials() — AWS creds available
//   2. SigV4-signed JSON-RPC tools/list to the upstream AgentCore endpoint
//   3. Role sentinel check — upstream's tool list must include the expected
//      sentinel tool for the configured role
// All three must succeed for ready: true.

import { createReadinessProbe, type ReadinessSnapshot } from "./readiness.ts";

// Sentinel tools must exist in the upstream MCP server's tools/list response.
// aws_cloudwatch_describe_alarms is the AWS agent's primary triage entry per
// agents/incident-analyzer/agents/aws-agent/RULES.md and is always registered.
const ROLE_SENTINEL_TOOLS: Record<"aws-proxy" | "kafka-proxy", string> = {
	"aws-proxy": "aws_cloudwatch_describe_alarms",
	"kafka-proxy": "kafka_list_topics",
};

// AgentCore's streamable-HTTP MCP transport returns SSE-framed JSON-RPC
// ("event: message\ndata: <json>\n\n") once the runtime is warm, and bare
// JSON ({"jsonrpc","error":{"code":-32010,...}}) during cold-start. Mirrors
// the parse pattern in agentcore-proxy.ts:230 (classifyToolStatus). Returns
// the last data: frame, or the raw body trimmed when no SSE framing exists.
function parseAgentCoreBody(rawBody: string): unknown {
	const dataLines = rawBody.split("\n").filter((l) => l.startsWith("data: "));
	const jsonText = dataLines.length > 0 ? (dataLines[dataLines.length - 1]?.slice(6) ?? "") : rawBody.trim();
	if (!jsonText) throw new Error("empty response body");
	return JSON.parse(jsonText);
}

// SIO-1477: an expired/revoked/wrong-account credential still RESOLVES -- the
// AWS CLI returns three well-formed values for a dead token, and a
// shared-credentials-file profile carries no local Expiration to inspect. So a
// presence check cannot distinguish a working credential from a broken one, and
// the failure surfaced one component later as "agentcoreUpstream: unreachable",
// pointing the operator at the network instead of at auth. The only reliable
// check is a remote one: a signed sts:GetCallerIdentity, which is cheap, has no
// AgentCore dependency, and fails with the real reason (ExpiredToken,
// InvalidClientTokenId, SignatureDoesNotMatch).
const STS_ERROR_CODE_RE = /<Code>([^<]+)<\/Code>/;
const STS_ERROR_MESSAGE_RE = /<Message>([^<]+)<\/Message>/;

// STS answers in EITHER format depending on the Accept header and error class:
// XML (<ErrorResponse><Error><Code>) or JSON ({"Error":{"Code","Message"}}).
// Live-verified: an invalid key over Accept: application/json returns the JSON
// shape, so parsing only XML would leak a raw body into the log line.
function describeStsFailure(status: number, body: string): string {
	let code = STS_ERROR_CODE_RE.exec(body)?.[1];
	let message = STS_ERROR_MESSAGE_RE.exec(body)?.[1];
	if (!code) {
		try {
			const parsed: unknown = JSON.parse(body);
			const err = (parsed as { Error?: { Code?: unknown; Message?: unknown } })?.Error;
			if (typeof err?.Code === "string") code = err.Code;
			if (typeof err?.Message === "string") message = err.Message;
		} catch {
			// not JSON either -- fall through to the raw-body branch below
		}
	}
	if (code && message) return `${code}: ${message}`;
	if (code) return code;
	const trimmed = body.trim();
	return trimmed
		? `sts:GetCallerIdentity returned ${status}: ${trimmed.slice(0, 200)}`
		: `sts:GetCallerIdentity returned ${status}`;
}

// GetCallerIdentity success bodies, like its errors, come back as XML or JSON
// depending on the Accept header. Returns undefined when the account cannot be
// read, so an unparseable success body degrades to "key is live" rather than
// failing the probe on a parsing detail.
const STS_ACCOUNT_XML_RE = /<Account>(\d+)<\/Account>/;

function parseStsAccountId(body: string): string | undefined {
	const xml = STS_ACCOUNT_XML_RE.exec(body)?.[1];
	if (xml) return xml;
	try {
		const parsed: unknown = JSON.parse(body);
		const account = (parsed as { GetCallerIdentityResponse?: { GetCallerIdentityResult?: { Account?: unknown } } })
			?.GetCallerIdentityResponse?.GetCallerIdentityResult?.Account;
		if (typeof account === "string") return account;
		const flat = (parsed as { Account?: unknown })?.Account;
		if (typeof flat === "string") return flat;
	} catch {
		// not JSON -- fall through
	}
	return undefined;
}

export interface CreateProxyReadinessProbeOptions {
	role: "aws-proxy" | "kafka-proxy";
	getCredentials: () => Promise<unknown>;
	upstreamUrl: string;
	sigv4Fetch: (req: Request) => Promise<Response>;
	// SIO-1477: signs against sts.<region>.amazonaws.com rather than the
	// AgentCore host. Optional so existing callers/tests keep working; when
	// absent the credentials component falls back to the presence check.
	stsFetch?: (req: Request) => Promise<Response>;
	stsUrl?: string;
	// SIO-1477 (Greptile): the AWS account the configured runtime ARN lives in.
	// A VALID key from a DIFFERENT account returns HTTP 200 from
	// GetCallerIdentity, so status alone cannot catch the wrong-account case --
	// live-verified: the previously-configured key returns 200 for account
	// 356994971776 while the runtime is in 399987695868. That mismatch is this
	// repo's documented historical failure mode, so compare identities.
	expectedAccountId?: string;
	ttlMs?: number;
	timeoutMs?: number;
	now?: () => number;
}

export function createProxyReadinessProbe(opts: CreateProxyReadinessProbeOptions): () => Promise<ReadinessSnapshot> {
	const sentinelTool = ROLE_SENTINEL_TOOLS[opts.role];

	return createReadinessProbe({
		components: {
			credentials: async () => {
				const creds = await opts.getCredentials();
				if (!creds) throw new Error("no AWS credentials resolved");
				const { stsFetch, stsUrl } = opts;
				// No STS seam wired -> presence check only (pre-SIO-1477 behaviour).
				if (!stsFetch || !stsUrl) return;
				const req = new Request(stsUrl, {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
					body: "Action=GetCallerIdentity&Version=2011-06-15",
				});
				const res = await stsFetch(req);
				if (!res.ok) {
					throw new Error(describeStsFailure(res.status, await res.text().catch(() => "")));
				}
				// A 200 only proves the key is live -- not that it belongs to the
				// account owning the runtime. Without this the wrong-account case
				// still reports credentials:"ok" and the blame lands on
				// agentcoreUpstream, which is the exact misattribution this ticket
				// exists to remove.
				if (opts.expectedAccountId) {
					const actual = parseStsAccountId(await res.text().catch(() => ""));
					if (!actual) {
						// Fail CLOSED. Configuring expectedAccountId is a request for
						// account verification; if the account cannot be read, the check
						// did not run, and reporting "ok" would claim a verification that
						// never happened -- the same false-reassurance this ticket exists
						// to remove. Both real STS shapes (JSON and XML) parse, so this
						// path means something genuinely unexpected.
						throw new Error(
							`sts:GetCallerIdentity succeeded but no account could be read from the response, so the credential could not be verified against runtime account ${opts.expectedAccountId}`,
						);
					}
					if (actual !== opts.expectedAccountId) {
						throw new Error(
							`credentials belong to AWS account ${actual} but the configured runtime is in ${opts.expectedAccountId} -- the proxy cannot invoke it`,
						);
					}
				}
			},
			agentcoreUpstream: async () => {
				const req = new Request(opts.upstreamUrl, {
					method: "POST",
					headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
					body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
				});
				const res = await opts.sigv4Fetch(req);
				if (!res.ok) {
					// SIO-1477: a 401/403 is an auth REJECTION -- the endpoint answered,
					// so reporting it as "unreachable" sends the operator hunting for a
					// network fault. Name it for what it is and keep the upstream's own
					// explanation, which carries the actionable detail (e.g. "The
					// security token included in the request is expired").
					const detail = (await res.text().catch(() => "")).trim();
					if (res.status === 401 || res.status === 403) {
						throw new Error(
							`authorization rejected (HTTP ${res.status}) -- check the proxy's AWS credentials${detail ? `: ${detail.slice(0, 200)}` : ""}`,
						);
					}
					throw new Error(`tools/list returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
				}
				const rawBody = await res.text();
				const body = parseAgentCoreBody(rawBody) as {
					result?: { tools?: Array<{ name: string }> };
					error?: { code: number; message?: string };
				};
				// Cold-start: AgentCore returns -32010 while the runtime boots. The probe
				// should surface this explicitly so the operator doesn't chase a missing
				// sentinel tool that won't appear until the runtime is up.
				if (body.error?.code === -32010) {
					throw new Error(`AgentCore cold-start in progress (-32010): ${body.error.message ?? ""}`.trim());
				}
				if (body.error) {
					throw new Error(`tools/list returned JSON-RPC error ${body.error.code}: ${body.error.message ?? ""}`.trim());
				}
				const tools = body.result?.tools ?? [];
				const found = tools.some((t) => t.name === sentinelTool);
				if (!found) {
					throw new Error(
						`expected sentinel tool "${sentinelTool}" for role "${opts.role}", upstream returned ${tools.length} tools without it`,
					);
				}
			},
		},
		ttlMs: opts.ttlMs,
		timeoutMs: opts.timeoutMs,
		now: opts.now,
	});
}
