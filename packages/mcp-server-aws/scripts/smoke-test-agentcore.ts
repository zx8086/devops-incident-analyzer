// packages/mcp-server-aws/scripts/smoke-test-agentcore.ts
// Standalone probe: boots the SigV4 proxy from AWS_AGENTCORE_* env, then
// (1) initializes MCP, (2) lists tools, (3) calls aws_sts_get_caller_identity
// to verify the runtime assumes arn:aws:iam::762715229080:role/DevOpsAgentReadOnly.
//
// Run: bun run packages/mcp-server-aws/scripts/smoke-test-agentcore.ts
// Or:  bun --env-file=.env packages/mcp-server-aws/scripts/smoke-test-agentcore.ts

import {
	buildIdentityCard,
	loadProxyConfigFromEnv,
	startAgentCoreProxy,
} from "@devops-agent/shared";

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
		console.log("[smoke] step 1/3: initialize");
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

		console.log("\n[smoke] step 2/3: tools/list");
		const tools = await postMcp(config.port, {
			jsonrpc: "2.0",
			id: 2,
			method: "tools/list",
		});
		const toolCount = Array.isArray((tools as { result?: { tools?: unknown[] } }).result?.tools)
			? (tools as { result: { tools: unknown[] } }).result.tools.length
			: "unknown";
		console.log(`[smoke]   tool count: ${toolCount}`);
		const stsTool = (tools as { result?: { tools?: { name: string }[] } }).result?.tools?.find(
			(t) => t.name === "aws_sts_get_caller_identity",
		);
		console.log(`[smoke]   aws_sts_get_caller_identity present: ${Boolean(stsTool)}`);

		console.log("\n[smoke] step 3/3: tools/call aws_sts_get_caller_identity");
		const callerId = await postMcp(config.port, {
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: { name: "aws_sts_get_caller_identity", arguments: {} },
		});
		console.log("[smoke]   raw response:");
		console.log(JSON.stringify(callerId, null, 2));

		const content = (callerId as { result?: { content?: { type: string; text?: string }[] } })
			.result?.content;
		if (Array.isArray(content)) {
			const textBlock = content.find((c) => c.type === "text");
			if (textBlock?.text) {
				console.log("\n[smoke] caller identity text:");
				console.log(textBlock.text);
				if (textBlock.text.includes("DevOpsAgentReadOnly")) {
					console.log("\n[smoke] PASS: assumed-role chain reached DevOpsAgentReadOnly");
				} else {
					console.log("\n[smoke] WARN: response does not mention DevOpsAgentReadOnly");
				}
			}
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
