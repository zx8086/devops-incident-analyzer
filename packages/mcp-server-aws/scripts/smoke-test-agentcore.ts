// packages/mcp-server-aws/scripts/smoke-test-agentcore.ts

import { buildIdentityCard, loadProxyConfigFromEnv, startAgentCoreProxy } from "@devops-agent/shared";

const PREFIX = "AWS";

async function postMcp(port: number, body: object): Promise<unknown> {
	const res = await fetch(`http://localhost:${port}/mcp`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify(body),
	});
	const text = await res.text();
	if (!res.ok) {
		throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
	}
	// AgentCore returns either JSON or SSE (event: message\ndata: <json>).
	if (text.startsWith("event:") || text.includes("\ndata: ")) {
		const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
		if (!dataLine) throw new Error(`No data line in SSE: ${text.slice(0, 300)}`);
		return JSON.parse(dataLine.slice(6));
	}
	return JSON.parse(text);
}

function extractTextContent(rpcResponse: unknown): string | undefined {
	const content = (rpcResponse as { result?: { content?: { type: string; text?: string }[] } }).result?.content;
	if (!Array.isArray(content)) return undefined;
	return content.find((c) => c.type === "text")?.text;
}

async function main() {
	console.log(`[smoke] loading ${PREFIX}_AGENTCORE_* env...`);
	const config = loadProxyConfigFromEnv(PREFIX);
	console.log(`[smoke]   runtime: ${config.runtimeArn}`);
	console.log(`[smoke]   region:  ${config.region}`);
	console.log(`[smoke]   port:    ${config.port}`);

	const card = buildIdentityCard({
		role: "aws-proxy",
		version: "smoke-test",
		mode: "agentcore-proxy",
		upstreamFingerprint: "smoke-test",
	});

	console.log(`[smoke] starting proxy on :${config.port}...`);
	const handle = await startAgentCoreProxy(config, card, "aws-proxy");
	console.log("[smoke] proxy up.\n");

	try {
		console.log("[smoke] step 1/4: initialize");
		const init = await postMcp(config.port, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "aws-smoke-test", version: "1.0.0" },
			},
		});
		console.log("[smoke]   ->", JSON.stringify(init).slice(0, 300));

		console.log("\n[smoke] step 2/4: tools/list");
		const tools = await postMcp(config.port, {
			jsonrpc: "2.0",
			id: 2,
			method: "tools/list",
		});
		const toolList = (tools as { result?: { tools?: { name: string }[] } }).result?.tools ?? [];
		console.log(`[smoke]   tool count: ${toolList.length}`);
		console.log(`[smoke]   aws_list_estates present: ${toolList.some((t) => t.name === "aws_list_estates")}`);
		console.log(
			`[smoke]   aws_cloudwatch_describe_alarms present: ${toolList.some((t) => t.name === "aws_cloudwatch_describe_alarms")}`,
		);

		console.log("\n[smoke] step 3/4: tools/call aws_list_estates");
		const estatesRpc = await postMcp(config.port, {
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: { name: "aws_list_estates", arguments: {} },
		});
		const estatesText = extractTextContent(estatesRpc);
		console.log("[smoke]   ->", estatesText ?? JSON.stringify(estatesRpc).slice(0, 200));

		// Try to parse the returned JSON to pick an estate ID for step 4.
		let firstEstate: string | undefined;
		if (estatesText) {
			try {
				const parsed = JSON.parse(estatesText) as { estates?: string[] };
				firstEstate = parsed.estates?.[0];
			} catch {
				/* tool may have wrapped in markdown; skip step 4 */
			}
		}

		if (!firstEstate) {
			console.log("\n[smoke] step 4/4: SKIPPED (couldn't parse first estate from aws_list_estates)");
			return;
		}

		console.log(`\n[smoke] step 4/4: tools/call aws_cloudwatch_describe_alarms (estate=${firstEstate})`);
		const alarmsRpc = await postMcp(config.port, {
			jsonrpc: "2.0",
			id: 4,
			method: "tools/call",
			params: {
				name: "aws_cloudwatch_describe_alarms",
				arguments: { estate: firstEstate, MaxRecords: 1 },
			},
		});
		const alarmsText = extractTextContent(alarmsRpc);
		console.log("[smoke]   ->", alarmsText?.slice(0, 400) ?? JSON.stringify(alarmsRpc).slice(0, 400));
		if (alarmsText?.includes("_error")) {
			console.log("\n[smoke] FAIL: tool returned a structured error -- check AssumeRole/IAM");
		} else {
			console.log(
				`\n[smoke] PASS: end-to-end SigV4 -> proxy -> runtime -> AssumeRole(${firstEstate}) -> CloudWatch worked`,
			);
		}
	} finally {
		console.log("\n[smoke] stopping proxy...");
		await handle.close();
		console.log("[smoke] done.");
	}
}

main().catch((err) => {
	console.error("[smoke] FAIL:", err);
	process.exit(1);
});
