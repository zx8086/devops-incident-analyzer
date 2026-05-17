// shared/src/transport/agentcore-proxy.ts
import { loadProxyConfigFromEnv, startAgentCoreProxy } from "../agentcore-proxy.ts";
import type { BootstrapLogger, BootstrapTransportResult } from "../bootstrap.ts";
import { traceSpan } from "../telemetry/telemetry.ts";
import type { IdentityCard } from "./identity.ts";

export async function createAgentCoreProxyTransport(
	prefix: "AWS" | "KAFKA",
	logger: BootstrapLogger,
	identityCard: IdentityCard,
): Promise<BootstrapTransportResult> {
	const config = loadProxyConfigFromEnv(prefix);
	const role: "kafka-proxy" | "aws-proxy" = prefix === "KAFKA" ? "kafka-proxy" : "aws-proxy";
	const proxy = await traceSpan(
		"agentcore-proxy",
		"proxy.connect",
		async (_span) => startAgentCoreProxy(config, identityCard, role),
		{
			"proxy.prefix": prefix,
			"proxy.runtimeArn": config.runtimeArn,
		},
	);
	logger.info("AgentCore proxy ready", { prefix, port: proxy.port, url: proxy.url });

	return {
		closeAll: async () => {
			await traceSpan("agentcore-proxy", "proxy.close", async (_span) => proxy.close(), { "proxy.prefix": prefix });
			logger.info("AgentCore proxy closed", { prefix });
		},
	};
}
