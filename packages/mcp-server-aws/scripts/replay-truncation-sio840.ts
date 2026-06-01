// packages/mcp-server-aws/scripts/replay-truncation-sio840.ts
// SIO-840: live replay validation of the SIO-833 truncation/pagination behavior
// against the deployed AgentCore runtime. Starts the SigV4 proxy, calls the two
// list tools the PR fixed, and asserts the Step-3 envelope invariants on the LIVE
// response. Offline CI coverage lives in src/__tests__/wrap.test.ts (the
// "SIO-840 replay validation" describe); this script is the production re-run.
//
// Usage (env from repo-root .env carries AWS_AGENTCORE_* + AWS_ESTATES):
//   bun --env-file=../../.env packages/mcp-server-aws/scripts/replay-truncation-sio840.ts [estate]
// If no estate arg is given, the first estate from aws_list_estates is used for
// alarms; for the large-response (Case B) EC2 case, pass a known large estate
// (e.g. eu-mendix-platform-prd) as the arg for a meaningful test.

import {
	buildIdentityCard,
	DEFAULT_TOOL_RESULT_CAP_BYTES,
	loadProxyConfigFromEnv,
	startAgentCoreProxy,
	TRUNCATION_OVERHEAD_BYTES,
} from "@devops-agent/shared";

const PREFIX = "AWS";

async function postMcp(port: number, body: object): Promise<unknown> {
	const res = await fetch(`http://localhost:${port}/mcp`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
		body: JSON.stringify(body),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
	if (text.startsWith("event:") || text.includes("\ndata: ")) {
		const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
		if (!dataLine) throw new Error(`No data line in SSE: ${text.slice(0, 300)}`);
		return JSON.parse(dataLine.slice(6));
	}
	return JSON.parse(text);
}

function extractToolJson(rpcResponse: unknown): unknown {
	const content = (rpcResponse as { result?: { content?: { type: string; text?: string }[] } }).result?.content;
	const text = Array.isArray(content) ? content.find((c) => c.type === "text")?.text : undefined;
	if (!text) throw new Error(`No text content: ${JSON.stringify(rpcResponse).slice(0, 300)}`);
	return JSON.parse(text);
}

interface TruncatedMarker {
	shown: number;
	total: number;
	cursor?: string;
	advice: string;
}

const failures: string[] = [];
function check(label: string, cond: boolean, detail: string): void {
	if (cond) {
		console.log(`[replay]   PASS  ${label} -- ${detail}`);
	} else {
		console.log(`[replay]   FAIL  ${label} -- ${detail}`);
		failures.push(label);
	}
}

// SIO-840 Step-3 assertions on one live tool result.
function assertEnvelope(label: string, payload: Record<string, unknown>, listField: string): void {
	const bytes = JSON.stringify(payload).length;
	const trunc = payload._truncated as TruncatedMarker | undefined;
	const summary = payload._summary as unknown[] | undefined;
	const list = payload[listField] as unknown[] | undefined;

	if (!trunc) {
		console.log(`[replay]   note: ${label} was NOT truncated (${bytes}B <= cap); nothing to assert.`);
		return;
	}
	check(`${label} payload <= 128KB`, bytes <= DEFAULT_TOOL_RESULT_CAP_BYTES + TRUNCATION_OVERHEAD_BYTES, `${bytes}B`);
	check(`${label} not re-truncated to 64KB`, bytes > 65_536, `${bytes}B > 64KB`);
	check(
		`${label} shown < total and consistent`,
		Array.isArray(list) && trunc.shown === list.length && trunc.shown < trunc.total,
		`shown=${trunc.shown} listLen=${list?.length} total=${trunc.total}`,
	);
	if (trunc.cursor !== undefined) {
		check(`${label} Case A advice when cursor present`, trunc.advice.includes("Case A"), trunc.advice.slice(0, 60));
	} else {
		check(`${label} Case B advice when no cursor`, trunc.advice.includes("Case B"), trunc.advice.slice(0, 60));
	}
	if (summary) {
		check(`${label} _summary complete (== total)`, summary.length === trunc.total, `summary=${summary.length}`);
	}
}

async function callTool(port: number, id: number, name: string, args: Record<string, unknown>): Promise<unknown> {
	const rpc = await postMcp(port, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
	return extractToolJson(rpc);
}

async function main() {
	const estateArg = process.argv[2];
	const config = loadProxyConfigFromEnv(PREFIX);
	const card = buildIdentityCard({
		role: "aws-proxy",
		version: "sio840-replay",
		mode: "agentcore-proxy",
		upstreamFingerprint: "sio840-replay",
	});

	console.log(`[replay] starting proxy on :${config.port} (runtime ${config.runtimeArn})...`);
	const handle = await startAgentCoreProxy(config, card, "aws-proxy");
	try {
		await postMcp(config.port, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "sio840-replay", version: "1" } },
		});

		const estates = extractToolJson(
			await postMcp(config.port, {
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "aws_list_estates", arguments: {} },
			}),
		) as { estates?: Array<{ id: string }> };
		const estate = estateArg ?? estates.estates?.[0]?.id;
		if (!estate) throw new Error("no estate available; pass one as argv[2]");
		console.log(`[replay] estate under test: ${estate}\n`);

		console.log("[replay] Case B: aws_ec2_describe_instances (large-response)");
		const ec2 = (await callTool(config.port, 3, "aws_ec2_describe_instances", { estate })) as Record<string, unknown>;
		assertEnvelope("ec2_describe_instances", ec2, "Reservations");

		console.log("\n[replay] Completeness: aws_cloudwatch_describe_alarms");
		const alarms = (await callTool(config.port, 4, "aws_cloudwatch_describe_alarms", { estate })) as Record<
			string,
			unknown
		>;
		assertEnvelope("cloudwatch_describe_alarms", alarms, "MetricAlarms");

		console.log("\n[replay] Case A: aws_lambda_list_functions (NextMarker cursor)");
		const lambda = (await callTool(config.port, 5, "aws_lambda_list_functions", { estate })) as Record<string, unknown>;
		assertEnvelope("lambda_list_functions", lambda, "Functions");
	} finally {
		await handle.close();
	}

	console.log(`\n[replay] ${failures.length === 0 ? "ALL PASS" : `FAILURES: ${failures.join(", ")}`}`);
	if (failures.length > 0) process.exit(1);
}

main().catch((err) => {
	console.error("[replay] ERROR:", err);
	process.exit(1);
});
