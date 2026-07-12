// src/index.ts
import {
	buildTelemetryConfig,
	canonicalizeUpstream,
	createBootstrapAdapter,
	createMcpApplication,
	createReadinessProbe,
	warnIfOAuthNotSeeded,
} from "@devops-agent/shared";
import pkg from "../package.json" with { type: "json" };
import { loadConfiguration } from "./config/index.js";
import { GitLabRestClient } from "./gitlab-client/index.js";
import { isOrbitIndexed, OrbitRestClient } from "./gitlab-client/orbit.js";
import { GitLabMcpProxy } from "./gitlab-client/proxy.js";
import { createMcpServerFactory, discoverRemoteTools, type GitLabDatasource } from "./server.ts";
import { createTransport } from "./transport/index.ts";
import { getRuntimeInfo } from "./utils/env.js";
import { createContextLogger, logger } from "./utils/logger.js";
import { initializeTracing } from "./utils/tracing.js";

const serverLog = createContextLogger("server");

if (import.meta.main) {
	createMcpApplication<GitLabDatasource>({
		name: "gitlab-mcp-server",
		logger: createBootstrapAdapter(logger),

		initTracing: () => initializeTracing(),
		telemetry: buildTelemetryConfig("gitlab-mcp-server"),

		role: "gitlab-mcp",
		version: pkg.version,
		identityFingerprint: (ds) => canonicalizeUpstream({ instanceUrl: ds.config.gitlab.instanceUrl }),

		initDatasource: async () => {
			const config = await loadConfiguration();

			logger.level = config.application.logLevel;

			const runtimeInfo = getRuntimeInfo();
			serverLog.info(
				{
					runtime: runtimeInfo.runtime,
					version: runtimeInfo.version,
					envSource: runtimeInfo.envSource,
				},
				"Starting GitLab MCP Server",
			);

			warnIfOAuthNotSeeded({
				namespace: "gitlab",
				key: config.gitlab.instanceUrl,
				endpointLabel: "instanceUrl",
				seedCommand: "bun run oauth:seed:gitlab",
				logger: serverLog,
			});

			const proxy = new GitLabMcpProxy({
				instanceUrl: config.gitlab.instanceUrl,
				personalAccessToken: config.gitlab.personalAccessToken,
				timeout: config.gitlab.timeout,
				oauthCallbackPort: config.gitlab.oauthCallbackPort,
			});

			try {
				await proxy.connect();
			} catch (error) {
				serverLog.warn(
					{ error: error instanceof Error ? error.message : String(error) },
					"Failed to connect to GitLab MCP endpoint -- proxy tools will be unavailable",
				);
			}

			// Discover remote tools once at startup
			const discoveredTools = proxy.isConnected() ? await discoverRemoteTools(proxy) : [];

			const restClient = new GitLabRestClient({
				instanceUrl: config.gitlab.instanceUrl,
				personalAccessToken: config.gitlab.personalAccessToken,
				timeout: config.gitlab.timeout,
			});

			// SIO-1076: Orbit REST client + free /status boot probe. Reuses the
			// GitLab PAT (read_api) unless a dedicated ORBIT_PERSONAL_ACCESS_TOKEN
			// is set. The probe never calls the billed /query endpoint.
			let orbitClient: OrbitRestClient | undefined;
			let orbitAvailable = false;
			let orbitIndexing = false;
			if (config.orbit.enabled) {
				orbitClient = new OrbitRestClient({
					instanceUrl: config.gitlab.instanceUrl,
					personalAccessToken: config.orbit.personalAccessToken || config.gitlab.personalAccessToken,
					queryPath: config.orbit.queryPath,
					schemaPath: config.orbit.schemaPath,
					statusPath: config.orbit.statusPath,
					timeout: config.orbit.timeout,
				});
				try {
					const status = await orbitClient.getStatus();
					orbitAvailable = isOrbitIndexed(status);
					// Only "indexing" warrants a later free /status re-check; other
					// defined statuses ("disabled", "error") go straight to fallback.
					orbitIndexing = !orbitAvailable && status.status === "indexing";
					serverLog.info({ orbitStatus: status.status, orbitAvailable }, "Orbit status probed");
				} catch (error) {
					serverLog.warn(
						{ error: error instanceof Error ? error.message : String(error) },
						"Orbit unavailable at boot -- graph tools will soft-fail to the REST/semantic path",
					);
				}
			}

			return { proxy, restClient, config, discoveredTools, orbitClient, orbitAvailable, orbitIndexing };
		},

		// SIO-1044: record-once / replay-many factory (createMcpServerFactory already returns
		// the sync () => McpServer required by createServerFactory).
		createServerFactory: (ds) => createMcpServerFactory(ds),

		// SIO-779: proxy mode is not used for this server; non-null assertion is safe
		createTransport: (serverFactory, ds, identityCard) => {
			const gitlabProbe = createReadinessProbe({
				components: {
					gitlab: async () => {
						await ds.restClient.getCurrentUser();
					},
				},
			});
			// biome-ignore lint/style/noNonNullAssertion: SIO-779 - server mode always provides createServerFactory
			return createTransport(ds.config.transport, serverFactory!, gitlabProbe, identityCard);
		},

		cleanupDatasource: async (ds) => {
			await ds.proxy.disconnect();
		},

		onStarted: (ds) => {
			serverLog.info(
				{
					gitlabInstance: ds.config.gitlab.instanceUrl,
					proxyConnected: ds.proxy.isConnected(),
					proxyTools: ds.discoveredTools?.length ?? 0,
					orbitEnabled: ds.config.orbit.enabled,
					orbitAvailable: ds.orbitAvailable ?? false,
					environment: ds.config.application.environment,
					transport: ds.config.transport.mode,
					port: ds.config.transport.mode !== "stdio" ? ds.config.transport.port : undefined,
					tracing: ds.config.tracing.enabled,
				},
				"GitLab MCP Server ready",
			);
		},
	});
}
