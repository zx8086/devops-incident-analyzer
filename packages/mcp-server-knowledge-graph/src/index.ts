// src/index.ts
import {
	buildTelemetryConfig,
	createBootstrapAdapter,
	createMcpApplication,
	createReadinessProbe,
	type McpApplication,
} from "@devops-agent/shared";
import pkg from "../package.json" with { type: "json" };
import { type Config, loadConfig } from "./config.ts";
import { logger } from "./logger.ts";
import { createMcpServerFactory } from "./server.ts";
import { createTransport } from "./transport.ts";

// SIO-967: build the MCP application. Exported (not just import.meta.main) so the
// web process can mount it IN-PROCESS: embedded lbug takes an exclusive file lock,
// so a separate server process cannot open .data/knowledge-graph while the agent
// pipeline's record* nodes hold it (memory: reference_lbug_exclusive_file_lock).
// Running here, in the agent process, the server's tools reuse the SAME
// getGraphStore() singleton -- one lock holder. The HTTP transport still listens on
// localhost so MultiServerMCPClient + boot-strict identity + health polling are
// unchanged from every other datasource.
export async function startKnowledgeGraphServer(): Promise<McpApplication<Config>> {
	return createMcpApplication<Config>({
		name: "knowledge-graph-mcp-server",
		logger: createBootstrapAdapter(logger),
		// SIO-986: this server is mounted IN-PROCESS in the web app (the lbug exclusive lock forces it,
		// see the note above). Embedded mode means a start failure rethrows (the web app's .catch
		// degrades to kg_* unavailable) instead of process.exit(1), and the process-global signal/
		// exception handlers are not installed -- both would otherwise take the whole app down.
		embedded: true,

		initTracing: () => {},
		telemetry: buildTelemetryConfig("knowledge-graph-mcp-server"),

		role: "knowledge-graph-mcp",
		version: pkg.version,
		// The graph DB path is the only "upstream" this server has; fingerprint on it.
		identityFingerprint: (config) => config.graphPath,

		initDatasource: async () => {
			const config = loadConfig();
			logger.info(
				{ port: config.transport.port, graphPath: config.graphPath, allowCypher: config.allowCypher },
				"Starting Knowledge Graph MCP Server",
			);
			return config;
		},

		// SIO-1044: record-once / replay-many. registerAll runs ONCE at boot instead of
		// rebuilding every tool's wrapped Zod schema per request.
		createServerFactory: (config) => createMcpServerFactory(config),

		createTransport: (serverFactory, config, identityCard) => {
			const readinessProbe = createReadinessProbe({
				components: {
					// Stateless; readiness just confirms the process is serving. The graph
					// store is opened lazily on first tool call, not at startup.
					server: async () => {},
				},
			});
			// biome-ignore lint/style/noNonNullAssertion: server mode always provides createServerFactory
			return createTransport(serverFactory!, config, { readinessProbe, identityCard });
		},

		onStarted: (config) => {
			logger.info(
				{ transport: config.transport.mode, port: config.transport.port },
				"Knowledge Graph MCP Server ready",
			);
		},
	});
}

if (import.meta.main) {
	// SIO-967: standalone process entrypoint. NOTE: only safe when the agent process
	// is NOT also opening the graph (lbug exclusive lock). In the default deployment
	// the server is mounted in-process via startKnowledgeGraphServer() from the web
	// app -- do not run this standalone alongside a live agent against the same DB.
	await startKnowledgeGraphServer();
}
