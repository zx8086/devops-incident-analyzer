// src/index-v2.ts
//
// SIO-1424: v2 pilot entrypoint. Side-by-side with index.ts (v1, port 9082, untouched) -- this
// boots a SEPARATE process/port serving the MCP SDK 2.0.0 dual-era protocol
// (createMcpHandler(..., { legacy: 'stateless' })). Not wired into index.ts's `if
// (import.meta.main)` block; run directly (`bun src/index-v2.ts`) or via a dedicated script, kept
// out of the default `start`/`dev` scripts so it never boots unless explicitly invoked.
import "./set-global.ts";

import {
	buildTelemetryConfig,
	canonicalizeUpstream,
	createBootstrapAdapter,
	readPositiveIntEnv,
} from "@devops-agent/shared";
// SIO-1424: bootstrap-v2.ts is deliberately NOT exported from @devops-agent/shared's default
// barrel ("."/index.ts) -- reached via the package's existing `./src/*` deep-import convention
// instead (see e.g. `@devops-agent/shared/src/confidence.ts` elsewhere in the repo), so it stays
// out of `import { X } from "@devops-agent/shared"` and every other v1 consumer's resolution, per
// the F1/F2 handover convention ("F2 imports by path"). A relative import
// (../../shared/src/bootstrap-v2.ts) does NOT work in this monorepo -- each package's tsconfig
// scopes `rootDir` to its own src/, so reaching across breaks TypeScript's project-boundary check
// for every transitively-imported shared file.
import { createMcpApplicationV2 } from "@devops-agent/shared/src/bootstrap-v2.ts";
import { createMcpHandler } from "@modelcontextprotocol/server";
import pkg from "../package.json" with { type: "json" };
import { config } from "./config/index.ts";
import { connectionManager } from "./lib/connectionManager.ts";
import { buildServerFactory } from "./server-v2.ts";
import { logger } from "./utils/logger.ts";
import { initializeTracing } from "./utils/tracing.ts";

const V2_PORT = readPositiveIntEnv("COUCHBASE_MCP_V2_PORT", 9182);

if (import.meta.main) {
	createMcpApplicationV2({
		name: "couchbase-mcp-server",
		logger: createBootstrapAdapter(logger),

		initTracing: () => initializeTracing(),
		telemetry: buildTelemetryConfig("couchbase-mcp-server-v2"),

		role: "couchbase-mcp",
		version: pkg.version,
		identityFingerprint: () =>
			canonicalizeUpstream({
				connectionString: config.database.connectionString,
				bucket: config.database.bucketName,
			}),

		// SIO-1424: reuses the SAME connectionManager singleton v1's index.ts uses. Safe: this is
		// a genuinely separate process from v1 (different port, different `bun` invocation), so
		// there is no cross-process singleton collision -- each process gets its own instance.
		initDatasource: async () => {
			logger.info(
				{ connectionString: config.database.connectionString, bucket: config.database.bucketName, port: V2_PORT },
				"Starting Couchbase MCP Server (v2 pilot)",
			);
			await connectionManager.initialize();
			return { port: V2_PORT };
		},

		createHandler: () => {
			const handlerLogger = createBootstrapAdapter(logger);
			const factory = buildServerFactory(handlerLogger);
			return createMcpHandler(factory, { legacy: "stateless" });
		},

		listen: (fetch) => {
			const server = Bun.serve({ port: V2_PORT, fetch: (req) => fetch(req) });
			const port = server.port ?? V2_PORT;
			return {
				port,
				url: `http://localhost:${port}/`,
				stop: async () => {
					await server.stop();
				},
			};
		},

		cleanupDatasource: async () => {
			await connectionManager.close();
			logger.info("Couchbase connection closed (v2 pilot)");
		},

		onStarted: () => {
			logger.info({ port: V2_PORT }, "Couchbase MCP Server (v2 pilot) ready");
		},
	});
}
