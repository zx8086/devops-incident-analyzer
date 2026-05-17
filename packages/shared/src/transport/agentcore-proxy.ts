// shared/src/transport/agentcore-proxy.ts
import { loadProxyConfigFromEnv, startAgentCoreProxy } from "../agentcore-proxy.ts";
import type { BootstrapLogger, BootstrapTransportResult } from "../bootstrap.ts";
import { traceSpan } from "../telemetry/telemetry.ts";

export async function createAgentCoreProxyTransport(
	prefix: "AWS" | "KAFKA",
	logger: BootstrapLogger,
): Promise<BootstrapTransportResult> {
	const config = loadProxyConfigFromEnv(prefix);
	const proxy = await traceSpan("agentcore-proxy", "proxy.connect", async (_span) => startAgentCoreProxy(config), {
		"proxy.prefix": prefix,
		"proxy.runtimeArn": config.runtimeArn,
	});
	logger.info("AgentCore proxy ready", { prefix, port: proxy.port, url: proxy.url });

	return {
		closeAll: async () => {
			await traceSpan("agentcore-proxy", "proxy.close", async (_span) => proxy.close(), { "proxy.prefix": prefix });
			logger.info("AgentCore proxy closed", { prefix });
		},
	};
}
