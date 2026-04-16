# Atlassian MCP Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sixth datasource (`atlassian-agent`) to the DevOps incident analyzer that proxies the Atlassian Rovo MCP endpoint, filters write tools at registration, auto-discovers cloudId, and exposes three read-only correlation tools (linked incidents, runbook lookup, incident history) to the supervisor fan-out.

**Architecture:** New Bun workspace package `packages/mcp-server-atlassian` mirroring `mcp-server-gitlab` (port 9085). Uses `@modelcontextprotocol/sdk` `StreamableHTTPClientTransport` with an `AtlassianOAuthProvider` (OAuth 2.1 dynamic client registration). Server registers proxied Rovo tools (write-filtered) with `atlassian_` prefix plus three custom tools that compose JQL/CQL and shape results. New sub-agent `agents/incident-analyzer/agents/atlassian-agent/` wires into the 12-node pipeline via four touchpoint files in `packages/agent`.

**Tech Stack:** Bun workspace, TypeScript strict, `@modelcontextprotocol/sdk`, Zod v4, Pino, OpenTelemetry, Svelte 5 runes (frontend toggle).

**Spec:** `docs/superpowers/specs/2026-04-16-atlassian-mcp-integration-design.md` (SIO-650)

---

## File Structure

**New package:**
```
packages/mcp-server-atlassian/
  package.json
  tsconfig.json
  README.md
  src/
    index.ts
    server.ts
    config/
      defaults.ts, envMapping.ts, schemas.ts, loader.ts, index.ts
    atlassian-client/
      proxy.ts, oauth-provider.ts, oauth-callback.ts, index.ts
    tools/
      index.ts
      proxy/
        index.ts, write-tools.ts
      custom/
        find-linked-incidents.ts
        get-runbook-for-alert.ts
        get-incident-history.ts
        index.ts
    transport/                     (copied from mcp-server-gitlab)
      factory.ts, http.ts, stdio.ts, middleware.ts, index.ts
    utils/
      env.ts, logger.ts, tracing.ts
    telemetry/
      telemetry.ts
  test/
    oauth-provider.test.ts
    proxy.test.ts
    write-tools.test.ts
    find-linked-incidents.test.ts
    get-runbook-for-alert.test.ts
    get-incident-history.test.ts
```

**New agent files:**
```
agents/incident-analyzer/agents/atlassian-agent/
  agent.yaml
  SOUL.md
agents/incident-analyzer/tools/atlassian-api.yaml
```

**Existing files modified:**
- `packages/agent/src/mcp-bridge.ts` (2 spots: config type + serverMap)
- `packages/agent/src/supervisor.ts` (AGENT_NAMES)
- `packages/agent/src/entity-extractor.ts` (keyword routing prompt line)
- `apps/web/src/lib/components/DataSourceSelector.svelte` (labels record)
- `.env.example` (append 6 env vars)
- `package.json` (root workspace, if the `packages/*` glob doesn't already cover)

---

## Task 1: Package scaffold, transport + utils copy

Mechanical copy from `mcp-server-gitlab` to bootstrap the package skeleton. Transport files and env/logger/tracing utilities are datasource-agnostic and can be copied with minimal edits.

**Files:**
- Create: `packages/mcp-server-atlassian/package.json`
- Create: `packages/mcp-server-atlassian/tsconfig.json`
- Create: `packages/mcp-server-atlassian/src/utils/env.ts` (copy)
- Create: `packages/mcp-server-atlassian/src/utils/logger.ts`
- Create: `packages/mcp-server-atlassian/src/utils/tracing.ts`
- Create: `packages/mcp-server-atlassian/src/telemetry/telemetry.ts` (copy)
- Create: `packages/mcp-server-atlassian/src/transport/factory.ts` (copy)
- Create: `packages/mcp-server-atlassian/src/transport/http.ts` (copy)
- Create: `packages/mcp-server-atlassian/src/transport/stdio.ts` (copy)
- Create: `packages/mcp-server-atlassian/src/transport/middleware.ts` (copy)
- Create: `packages/mcp-server-atlassian/src/transport/index.ts` (copy)

- [ ] **Step 1: Create `package.json`**

Write:

```json
{
  "name": "@devops-agent/mcp-server-atlassian",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "dev": "bun --env-file=../../.env --hot src/index.ts",
    "start": "bun src/index.ts",
    "test": "bun test",
    "typecheck": "bunx tsc --noEmit"
  },
  "dependencies": {
    "@devops-agent/shared": "workspace:*",
    "@langchain/core": "catalog:",
    "@modelcontextprotocol/sdk": "catalog:",
    "@opentelemetry/api": "^1.9.0",
    "pino": "catalog:",
    "zod": "catalog:"
  },
  "devDependencies": {
    "@biomejs/biome": "catalog:dev",
    "@types/bun": "catalog:dev",
    "bun-types": "catalog:dev",
    "typescript": "catalog:dev"
  },
  "private": true
}
```

- [ ] **Step 2: Create `tsconfig.json`**

Write:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Copy transport + telemetry + env files**

Run:

```bash
cp packages/mcp-server-gitlab/src/transport/factory.ts packages/mcp-server-atlassian/src/transport/factory.ts
cp packages/mcp-server-gitlab/src/transport/http.ts packages/mcp-server-atlassian/src/transport/http.ts
cp packages/mcp-server-gitlab/src/transport/stdio.ts packages/mcp-server-atlassian/src/transport/stdio.ts
cp packages/mcp-server-gitlab/src/transport/middleware.ts packages/mcp-server-atlassian/src/transport/middleware.ts
cp packages/mcp-server-gitlab/src/transport/index.ts packages/mcp-server-atlassian/src/transport/index.ts
cp packages/mcp-server-gitlab/src/telemetry/telemetry.ts packages/mcp-server-atlassian/src/telemetry/telemetry.ts
cp packages/mcp-server-gitlab/src/utils/env.ts packages/mcp-server-atlassian/src/utils/env.ts
```

- [ ] **Step 4: Write `utils/logger.ts`**

Write to `packages/mcp-server-atlassian/src/utils/logger.ts`:

```typescript
// src/utils/logger.ts
import { createMcpLogger } from "@devops-agent/shared";

export const logger = createMcpLogger("atlassian-mcp-server");

export function createContextLogger(component: string) {
	return logger.child({ component });
}
```

- [ ] **Step 5: Write `utils/tracing.ts`**

Write to `packages/mcp-server-atlassian/src/utils/tracing.ts`:

```typescript
// src/utils/tracing.ts
import {
	type ConnectionContext,
	isTracingActive,
	initializeTracing as sharedInitializeTracing,
	traceConnection as sharedTraceConnection,
	traceToolCall as sharedTraceToolCall,
	type TracingOptions,
} from "@devops-agent/shared";
import { createContextLogger } from "./logger.js";

const log = createContextLogger("tool");

export type { ConnectionContext };
export { isTracingActive };

export function initializeTracing(options?: TracingOptions): void {
	const project =
		process.env.ATLASSIAN_LANGSMITH_PROJECT || process.env.LANGSMITH_PROJECT || "atlassian-mcp-server";
	sharedInitializeTracing({ project, ...options });
}

export async function traceToolCall<T>(toolName: string, handler: () => Promise<T>): Promise<T> {
	const startTime = Date.now();
	log.info({ tool: toolName, dataSource: "atlassian" }, `Tool call started: ${toolName}`);
	try {
		const result = await sharedTraceToolCall(toolName, handler, { dataSourceId: "atlassian" });
		const duration = Date.now() - startTime;
		log.info({ tool: toolName, dataSource: "atlassian", duration }, `Tool call completed: ${toolName}`);
		return result;
	} catch (error) {
		const duration = Date.now() - startTime;
		log.error(
			{
				tool: toolName,
				dataSource: "atlassian",
				duration,
				error: error instanceof Error ? error.message : String(error),
			},
			`Tool call failed: ${toolName}`,
		);
		throw error;
	}
}

export function traceConnection<T>(context: ConnectionContext, handler: () => Promise<T>): Promise<T> {
	return sharedTraceConnection(context, handler, { dataSourceId: "atlassian" });
}
```

- [ ] **Step 6: Install deps and typecheck (scaffold smoke test)**

Run:

```bash
bun install
bun run --filter '@devops-agent/mcp-server-atlassian' typecheck
```

Expected: `bun install` resolves the new workspace. `typecheck` passes (no source files yet beyond utils/transport, which were copied from a passing package and have no unresolved imports — shared package resolves via workspace).

- [ ] **Step 7: Commit**

```bash
git add packages/mcp-server-atlassian/package.json packages/mcp-server-atlassian/tsconfig.json packages/mcp-server-atlassian/src
git commit -m "SIO-650: Scaffold mcp-server-atlassian package (transport + utils)"
```

---

## Task 2: Config module (schemas, defaults, envMapping, loader)

The atlassian config drops GitLab's PAT/instance and adds Rovo endpoint, site name, read-only flag, OAuth callback port, and incident projects list. Default transport port is 9085.

**Files:**
- Create: `packages/mcp-server-atlassian/src/config/schemas.ts`
- Create: `packages/mcp-server-atlassian/src/config/defaults.ts`
- Create: `packages/mcp-server-atlassian/src/config/envMapping.ts`
- Create: `packages/mcp-server-atlassian/src/config/loader.ts`
- Create: `packages/mcp-server-atlassian/src/config/index.ts`

- [ ] **Step 1: Write `schemas.ts`**

Write to `packages/mcp-server-atlassian/src/config/schemas.ts`:

```typescript
// src/config/schemas.ts

import { z } from "zod";

export const ConfigSchema = z.object({
	application: z
		.object({
			name: z.string().min(1),
			version: z.string().regex(/^\d+\.\d+\.\d+$/, "Version must be semver format"),
			environment: z.enum(["development", "staging", "production", "test"]),
			logLevel: z.enum(["debug", "info", "warn", "error"]),
		})
		.describe("Core application settings"),

	atlassian: z
		.object({
			mcpEndpoint: z.string().url().describe("Rovo MCP server URL"),
			siteName: z.string().optional().describe("Atlassian site short name for cloudId match; first accessible resource used if unset"),
			readOnly: z.boolean().describe("Filter write tools at registration time"),
			oauthCallbackPort: z.number().int().min(1024).max(65535).describe("Port for OAuth redirect callback server"),
			incidentProjects: z.array(z.string()).describe("Jira project keys treated as incident projects for custom tools"),
			timeout: z.number().min(1000).max(60000).describe("Tool call timeout in milliseconds"),
		})
		.describe("Atlassian Rovo MCP configuration"),

	tracing: z
		.object({
			enabled: z.boolean().describe("Enable LangSmith tracing"),
			apiKey: z.string().optional().describe("LangSmith API key"),
			project: z.string().describe("LangSmith project name"),
			endpoint: z.string().url(),
			sessionName: z.string().describe("Session name for tracing"),
			tags: z.array(z.string()).describe("Tags for tracing sessions"),
			samplingRate: z.number().min(0).max(1).describe("Sampling rate for traces"),
		})
		.describe("LangSmith tracing and observability"),

	monitoring: z
		.object({
			enabled: z.boolean().describe("Enable performance monitoring"),
			healthCheckInterval: z.number().min(5000).max(300000).describe("Health check interval in milliseconds"),
			metricsCollection: z.boolean().describe("Enable metrics collection"),
		})
		.describe("Monitoring configuration"),

	transport: z
		.object({
			mode: z.enum(["stdio", "http", "both", "agentcore"]).describe("Transport mode"),
			port: z.number().int().min(1024).max(65535).describe("HTTP server port"),
			host: z.string().describe("HTTP server host"),
			path: z.string().startsWith("/").describe("MCP endpoint path"),
			sessionMode: z.enum(["stateless", "stateful"]).describe("HTTP session mode"),
			idleTimeout: z.number().int().min(10).max(255).describe("Idle timeout in seconds"),
			apiKey: z.string().describe("API key for authentication"),
			allowedOrigins: z.string().describe("Comma-separated allowed origins"),
		})
		.describe("Transport configuration for MCP server"),
});

export type Config = z.infer<typeof ConfigSchema>;
export type TransportConfig = Config["transport"];
```

- [ ] **Step 2: Write `defaults.ts`**

Write to `packages/mcp-server-atlassian/src/config/defaults.ts`:

```typescript
// src/config/defaults.ts

export const configDefaults = {
	application: {
		name: "atlassian-mcp-server",
		version: "0.1.0",
		environment: "development",
		logLevel: "info",
	},
	atlassian: {
		mcpEndpoint: "https://mcp.atlassian.com/v1/mcp",
		readOnly: "true",
		oauthCallbackPort: "9185",
		incidentProjects: "",
		timeout: "30000",
	},
	tracing: {
		enabled: "false",
		project: "atlassian-mcp-server",
		endpoint: "https://api.smith.langchain.com",
		sessionName: "mcp-session",
		tags: ["mcp-server", "atlassian"],
		samplingRate: "1.0",
	},
	monitoring: {
		enabled: "true",
		healthCheckInterval: "30000",
		metricsCollection: "true",
	},
	transport: {
		mode: "stdio",
		port: "9085",
		host: "0.0.0.0",
		path: "/mcp",
		sessionMode: "stateless",
		idleTimeout: "255",
		apiKey: "",
		allowedOrigins: "",
	},
} as const;
```

- [ ] **Step 3: Write `envMapping.ts`**

Write to `packages/mcp-server-atlassian/src/config/envMapping.ts`:

```typescript
// src/config/envMapping.ts

import { configDefaults } from "./defaults.js";

export interface EnvMappingEntry {
	configPath: string;
	envVar: string;
	default: string;
}

export const envMapping: readonly EnvMappingEntry[] = [
	{ configPath: "application.name", envVar: "APPLICATION_NAME", default: configDefaults.application.name },
	{ configPath: "application.version", envVar: "APPLICATION_VERSION", default: configDefaults.application.version },
	{ configPath: "application.environment", envVar: "NODE_ENV", default: configDefaults.application.environment },
	{ configPath: "application.logLevel", envVar: "LOG_LEVEL", default: configDefaults.application.logLevel },

	{ configPath: "atlassian.mcpEndpoint", envVar: "ATLASSIAN_MCP_URL", default: configDefaults.atlassian.mcpEndpoint },
	{ configPath: "atlassian.siteName", envVar: "ATLASSIAN_SITE_NAME", default: "" },
	{ configPath: "atlassian.readOnly", envVar: "ATLASSIAN_READ_ONLY", default: configDefaults.atlassian.readOnly },
	{ configPath: "atlassian.oauthCallbackPort", envVar: "ATLASSIAN_OAUTH_CALLBACK_PORT", default: configDefaults.atlassian.oauthCallbackPort },
	{ configPath: "atlassian.incidentProjects", envVar: "ATLASSIAN_INCIDENT_PROJECTS", default: configDefaults.atlassian.incidentProjects },
	{ configPath: "atlassian.timeout", envVar: "ATLASSIAN_TIMEOUT", default: configDefaults.atlassian.timeout },

	{ configPath: "tracing.enabled", envVar: "LANGSMITH_TRACING", default: configDefaults.tracing.enabled },
	{ configPath: "tracing.apiKey", envVar: "LANGSMITH_API_KEY", default: "" },
	{ configPath: "tracing.project", envVar: "LANGSMITH_PROJECT", default: configDefaults.tracing.project },
	{ configPath: "tracing.endpoint", envVar: "LANGSMITH_ENDPOINT", default: configDefaults.tracing.endpoint },
	{ configPath: "tracing.sessionName", envVar: "LANGSMITH_SESSION", default: configDefaults.tracing.sessionName },
	{ configPath: "tracing.tags", envVar: "LANGSMITH_TAGS", default: configDefaults.tracing.tags.join(",") },
	{ configPath: "tracing.samplingRate", envVar: "LANGSMITH_SAMPLING_RATE", default: configDefaults.tracing.samplingRate },

	{ configPath: "monitoring.enabled", envVar: "MONITORING_ENABLED", default: configDefaults.monitoring.enabled },
	{ configPath: "monitoring.healthCheckInterval", envVar: "HEALTH_CHECK_INTERVAL", default: configDefaults.monitoring.healthCheckInterval },
	{ configPath: "monitoring.metricsCollection", envVar: "METRICS_COLLECTION", default: configDefaults.monitoring.metricsCollection },

	{ configPath: "transport.mode", envVar: "MCP_TRANSPORT", default: configDefaults.transport.mode },
	{ configPath: "transport.port", envVar: "MCP_PORT", default: configDefaults.transport.port },
	{ configPath: "transport.host", envVar: "MCP_HOST", default: configDefaults.transport.host },
	{ configPath: "transport.path", envVar: "MCP_PATH", default: configDefaults.transport.path },
	{ configPath: "transport.sessionMode", envVar: "MCP_SESSION_MODE", default: configDefaults.transport.sessionMode },
	{ configPath: "transport.idleTimeout", envVar: "MCP_IDLE_TIMEOUT", default: configDefaults.transport.idleTimeout },
	{ configPath: "transport.apiKey", envVar: "MCP_API_KEY", default: configDefaults.transport.apiKey },
	{ configPath: "transport.allowedOrigins", envVar: "MCP_ALLOWED_ORIGINS", default: configDefaults.transport.allowedOrigins },
] as const;
```

- [ ] **Step 4: Write `loader.ts`**

Write to `packages/mcp-server-atlassian/src/config/loader.ts`:

```typescript
// src/config/loader.ts

import { z } from "zod";
import { getEnvVar, getEnvVarWithDefault, initializeEnvironment } from "../utils/env.js";
import { createContextLogger } from "../utils/logger.js";
import { configDefaults } from "./defaults.js";
import type { Config } from "./schemas.js";
import { ConfigSchema } from "./schemas.js";

const log = createContextLogger("config");

function parseIncidentProjects(raw: string): string[] {
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

export class ConfigurationManager {
	private config: Config | null = null;

	private loadFromEnvironment(): Partial<Config> {
		const incidentProjectsRaw = getEnvVarWithDefault("ATLASSIAN_INCIDENT_PROJECTS", configDefaults.atlassian.incidentProjects);
		return {
			application: {
				name: getEnvVarWithDefault("APPLICATION_NAME", configDefaults.application.name),
				version: getEnvVarWithDefault("APPLICATION_VERSION", configDefaults.application.version),
				environment: getEnvVarWithDefault("NODE_ENV", configDefaults.application.environment) as Config["application"]["environment"],
				logLevel: getEnvVarWithDefault("LOG_LEVEL", configDefaults.application.logLevel) as Config["application"]["logLevel"],
			},
			atlassian: {
				mcpEndpoint: getEnvVarWithDefault("ATLASSIAN_MCP_URL", configDefaults.atlassian.mcpEndpoint),
				siteName: getEnvVar("ATLASSIAN_SITE_NAME") || undefined,
				readOnly: getEnvVarWithDefault("ATLASSIAN_READ_ONLY", configDefaults.atlassian.readOnly) === "true",
				oauthCallbackPort: parseInt(
					getEnvVarWithDefault("ATLASSIAN_OAUTH_CALLBACK_PORT", configDefaults.atlassian.oauthCallbackPort),
					10,
				),
				incidentProjects: parseIncidentProjects(incidentProjectsRaw),
				timeout: parseInt(getEnvVarWithDefault("ATLASSIAN_TIMEOUT", configDefaults.atlassian.timeout), 10),
			},
			tracing: {
				enabled: getEnvVarWithDefault("LANGSMITH_TRACING", configDefaults.tracing.enabled) === "true",
				apiKey: getEnvVar("LANGSMITH_API_KEY"),
				project:
					getEnvVar("ATLASSIAN_LANGSMITH_PROJECT") ||
					getEnvVarWithDefault("LANGSMITH_PROJECT", configDefaults.tracing.project),
				endpoint: getEnvVarWithDefault("LANGSMITH_ENDPOINT", configDefaults.tracing.endpoint),
				sessionName: getEnvVarWithDefault("LANGSMITH_SESSION", configDefaults.tracing.sessionName),
				tags: getEnvVar("LANGSMITH_TAGS")?.split(",") || [...configDefaults.tracing.tags],
				samplingRate: parseFloat(getEnvVarWithDefault("LANGSMITH_SAMPLING_RATE", configDefaults.tracing.samplingRate)),
			},
			monitoring: {
				enabled: getEnvVarWithDefault("MONITORING_ENABLED", configDefaults.monitoring.enabled) === "true",
				healthCheckInterval: parseInt(
					getEnvVarWithDefault("HEALTH_CHECK_INTERVAL", configDefaults.monitoring.healthCheckInterval),
					10,
				),
				metricsCollection:
					getEnvVarWithDefault("METRICS_COLLECTION", configDefaults.monitoring.metricsCollection) === "true",
			},
			transport: {
				mode: getEnvVarWithDefault("MCP_TRANSPORT", configDefaults.transport.mode) as Config["transport"]["mode"],
				port: parseInt(getEnvVarWithDefault("MCP_PORT", configDefaults.transport.port), 10),
				host: getEnvVarWithDefault("MCP_HOST", configDefaults.transport.host),
				path: getEnvVarWithDefault("MCP_PATH", configDefaults.transport.path),
				sessionMode: getEnvVarWithDefault(
					"MCP_SESSION_MODE",
					configDefaults.transport.sessionMode,
				) as Config["transport"]["sessionMode"],
				idleTimeout: parseInt(getEnvVarWithDefault("MCP_IDLE_TIMEOUT", configDefaults.transport.idleTimeout), 10),
				apiKey: getEnvVarWithDefault("MCP_API_KEY", configDefaults.transport.apiKey),
				allowedOrigins: getEnvVarWithDefault("MCP_ALLOWED_ORIGINS", configDefaults.transport.allowedOrigins),
			},
		};
	}

	public async load(): Promise<Config> {
		try {
			await initializeEnvironment();
			const envConfig = this.loadFromEnvironment();
			this.config = ConfigSchema.parse(envConfig);
			if (this.config.atlassian.incidentProjects.length === 0) {
				log.warn("ATLASSIAN_INCIDENT_PROJECTS is empty -- custom tools will fall back to 'project is not EMPTY'");
			}
			return this.config;
		} catch (error) {
			if (error instanceof z.ZodError) {
				const issues = error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
				log.error({ issues }, "Configuration validation failed");
			}
			throw error;
		}
	}

	public get(): Config {
		if (!this.config) throw new Error("Configuration not loaded. Call load() first.");
		return this.config;
	}

	public async reload(): Promise<Config> {
		return this.load();
	}
}

export const configManager = new ConfigurationManager();

export async function loadConfiguration(): Promise<Config> {
	return configManager.load();
}

export function getConfiguration(): Config {
	return configManager.get();
}
```

- [ ] **Step 5: Write `config/index.ts`**

Write to `packages/mcp-server-atlassian/src/config/index.ts`:

```typescript
// src/config/index.ts

export { configDefaults } from "./defaults.js";
export type { EnvMappingEntry } from "./envMapping.js";
export { envMapping } from "./envMapping.js";
export { ConfigurationManager, configManager, getConfiguration, loadConfiguration } from "./loader.js";
export type { Config, TransportConfig } from "./schemas.js";
export { ConfigSchema } from "./schemas.js";
```

- [ ] **Step 6: Typecheck**

Run: `bun run --filter '@devops-agent/mcp-server-atlassian' typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp-server-atlassian/src/config
git commit -m "SIO-650: Add atlassian MCP config module (schemas, defaults, loader)"
```

---

## Task 3: OAuth provider (TDD)

Implements `AtlassianOAuthProvider` via `OAuthClientProvider`. Separate token storage under `~/.mcp-auth/atlassian/` keyed by sanitized endpoint URL.

**Files:**
- Create: `packages/mcp-server-atlassian/src/atlassian-client/oauth-provider.ts`
- Create: `packages/mcp-server-atlassian/src/atlassian-client/oauth-callback.ts`
- Create: `packages/mcp-server-atlassian/src/atlassian-client/index.ts`
- Create: `packages/mcp-server-atlassian/test/oauth-provider.test.ts`

- [ ] **Step 1: Write failing test for storage path sanitization + metadata**

Write to `packages/mcp-server-atlassian/test/oauth-provider.test.ts`:

```typescript
// test/oauth-provider.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AtlassianOAuthProvider, OAUTH_CALLBACK_PATH } from "../src/atlassian-client/oauth-provider.js";

const STORAGE_DIR = join(homedir(), ".mcp-auth", "atlassian");

function cleanup() {
	if (existsSync(STORAGE_DIR)) rmSync(STORAGE_DIR, { recursive: true, force: true });
}

describe("AtlassianOAuthProvider", () => {
	afterEach(cleanup);

	test("redirectUrl uses configured callback port", () => {
		const provider = new AtlassianOAuthProvider({
			mcpEndpoint: "https://mcp.atlassian.com/v1/mcp",
			callbackPort: 9185,
			onRedirect: () => {},
		});
		expect(provider.redirectUrl).toBe(`http://localhost:9185${OAUTH_CALLBACK_PATH}`);
	});

	test("clientMetadata includes Atlassian-specific client_name", () => {
		const provider = new AtlassianOAuthProvider({
			mcpEndpoint: "https://mcp.atlassian.com/v1/mcp",
			callbackPort: 9185,
			onRedirect: () => {},
		});
		const metadata = provider.clientMetadata;
		expect(metadata.client_name).toContain("Atlassian");
		expect(metadata.redirect_uris).toContain(provider.redirectUrl);
		expect(metadata.grant_types).toContain("authorization_code");
		expect(metadata.response_types).toContain("code");
	});

	test("saveTokens persists to sanitized file path", () => {
		const provider = new AtlassianOAuthProvider({
			mcpEndpoint: "https://mcp.atlassian.com/v1/mcp",
			callbackPort: 9185,
			onRedirect: () => {},
		});
		provider.saveTokens({ access_token: "tkn", token_type: "bearer" });
		const sanitized = "https://mcp.atlassian.com/v1/mcp".replace(/[^a-zA-Z0-9.-]/g, "_");
		const path = join(STORAGE_DIR, `${sanitized}.json`);
		expect(existsSync(path)).toBe(true);
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		expect(parsed.tokens.access_token).toBe("tkn");
	});

	test("invalidateCredentials('tokens') clears tokens only", () => {
		const provider = new AtlassianOAuthProvider({
			mcpEndpoint: "https://mcp.atlassian.com/v1/mcp",
			callbackPort: 9185,
			onRedirect: () => {},
		});
		provider.saveClientInformation({ client_id: "c1" });
		provider.saveTokens({ access_token: "tkn", token_type: "bearer" });
		provider.invalidateCredentials("tokens");
		expect(provider.tokens()).toBeUndefined();
		expect(provider.clientInformation()?.client_id).toBe("c1");
	});
});
```

- [ ] **Step 2: Run test (expected fail)**

Run: `bun test packages/mcp-server-atlassian/test/oauth-provider.test.ts`
Expected: FAIL with module-not-found error for `oauth-provider.js`.

- [ ] **Step 3: Write `oauth-provider.ts`**

Write to `packages/mcp-server-atlassian/src/atlassian-client/oauth-provider.ts`:

```typescript
// src/atlassian-client/oauth-provider.ts

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { createContextLogger } from "../utils/logger.js";

const log = createContextLogger("oauth");

export const OAUTH_CALLBACK_PATH = "/oauth/callback";

interface PersistedOAuthState {
	clientInformation?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	codeVerifier?: string;
}

function getStorageDir(): string {
	const dir = join(homedir(), ".mcp-auth", "atlassian");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}

function getStoragePath(endpoint: string): string {
	const sanitized = endpoint.replace(/[^a-zA-Z0-9.-]/g, "_");
	return join(getStorageDir(), `${sanitized}.json`);
}

function loadState(endpoint: string): PersistedOAuthState {
	const path = getStoragePath(endpoint);
	try {
		if (existsSync(path)) return JSON.parse(readFileSync(path, "utf-8")) as PersistedOAuthState;
	} catch (error) {
		log.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"Failed to load OAuth state, starting fresh",
		);
	}
	return {};
}

function saveState(endpoint: string, state: PersistedOAuthState): void {
	writeFileSync(getStoragePath(endpoint), JSON.stringify(state, null, 2), "utf-8");
}

export type AuthorizationHandler = (url: URL) => void | Promise<void>;

export interface AtlassianOAuthProviderOptions {
	mcpEndpoint: string;
	callbackPort: number;
	onRedirect: AuthorizationHandler;
}

export class AtlassianOAuthProvider implements OAuthClientProvider {
	private readonly endpoint: string;
	private readonly callbackPort: number;
	private persisted: PersistedOAuthState;
	private onRedirect: AuthorizationHandler;

	constructor(opts: AtlassianOAuthProviderOptions) {
		this.endpoint = opts.mcpEndpoint;
		this.callbackPort = opts.callbackPort;
		this.persisted = loadState(this.endpoint);
		this.onRedirect = opts.onRedirect;
	}

	get redirectUrl(): string {
		return `http://localhost:${this.callbackPort}${OAUTH_CALLBACK_PATH}`;
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: "DevOps Incident Analyzer - Atlassian MCP Proxy",
			redirect_uris: [this.redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "client_secret_post",
		};
	}

	clientInformation(): OAuthClientInformationMixed | undefined {
		return this.persisted.clientInformation;
	}

	saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
		this.persisted.clientInformation = clientInformation;
		saveState(this.endpoint, this.persisted);
		log.info("OAuth client registration saved");
	}

	tokens(): OAuthTokens | undefined {
		return this.persisted.tokens;
	}

	saveTokens(tokens: OAuthTokens): void {
		this.persisted.tokens = tokens;
		saveState(this.endpoint, this.persisted);
		log.info("OAuth tokens saved");
	}

	async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
		log.info({ url: authorizationUrl.toString() }, "OAuth authorization required");
		await this.onRedirect(authorizationUrl);
	}

	saveCodeVerifier(codeVerifier: string): void {
		this.persisted.codeVerifier = codeVerifier;
		saveState(this.endpoint, this.persisted);
	}

	codeVerifier(): string {
		if (!this.persisted.codeVerifier) throw new Error("No PKCE code verifier saved");
		return this.persisted.codeVerifier;
	}

	invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
		if (scope === "all" || scope === "tokens") this.persisted.tokens = undefined;
		if (scope === "all" || scope === "client") this.persisted.clientInformation = undefined;
		if (scope === "all" || scope === "verifier") this.persisted.codeVerifier = undefined;
		saveState(this.endpoint, this.persisted);
		log.info({ scope }, "OAuth credentials invalidated");
	}

	hasValidTokens(): boolean {
		return this.persisted.tokens?.access_token !== undefined;
	}
}
```

- [ ] **Step 4: Write `oauth-callback.ts`**

Write to `packages/mcp-server-atlassian/src/atlassian-client/oauth-callback.ts`:

```typescript
// src/atlassian-client/oauth-callback.ts

import { createContextLogger } from "../utils/logger.js";
import { OAUTH_CALLBACK_PATH } from "./oauth-provider.js";

const log = createContextLogger("oauth-callback");

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><title>Authorization Successful</title></head>
<body style="font-family:system-ui;text-align:center;padding:60px">
<h1>Authorization Successful</h1>
<p>You can close this window and return to the terminal.</p>
<script>setTimeout(()=>window.close(),3000)</script>
</body></html>`;

const ERROR_HTML = (error: string) => `<!DOCTYPE html>
<html><head><title>Authorization Failed</title></head>
<body style="font-family:system-ui;text-align:center;padding:60px">
<h1>Authorization Failed</h1>
<p>Error: ${error}</p>
</body></html>`;

export interface OAuthCallbackResult {
	code: string;
}

export async function waitForOAuthCallback(port: number): Promise<OAuthCallbackResult> {
	return new Promise<OAuthCallbackResult>((resolve, reject) => {
		const server = Bun.serve({
			port,
			hostname: "localhost",
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname !== OAUTH_CALLBACK_PATH) return new Response("Not found", { status: 404 });
				const code = url.searchParams.get("code");
				const error = url.searchParams.get("error");
				if (code) {
					log.info("OAuth authorization code received");
					resolve({ code });
					setTimeout(() => server.stop(true), 3000);
					return new Response(SUCCESS_HTML, { headers: { "Content-Type": "text/html" } });
				}
				if (error) {
					const description = url.searchParams.get("error_description") || error;
					log.error({ error: description }, "OAuth authorization failed");
					reject(new Error(`OAuth authorization failed: ${description}`));
					setTimeout(() => server.stop(true), 3000);
					return new Response(ERROR_HTML(description), {
						status: 400,
						headers: { "Content-Type": "text/html" },
					});
				}
				return new Response("Bad request: missing code or error parameter", { status: 400 });
			},
		});
		log.info({ port, path: OAUTH_CALLBACK_PATH }, "OAuth callback server started");
	});
}
```

- [ ] **Step 5: Write `atlassian-client/index.ts` (barrel)**

Write to `packages/mcp-server-atlassian/src/atlassian-client/index.ts`:

```typescript
// src/atlassian-client/index.ts

export { AtlassianOAuthProvider, OAUTH_CALLBACK_PATH } from "./oauth-provider.js";
export type { AtlassianOAuthProviderOptions, AuthorizationHandler } from "./oauth-provider.js";
export { waitForOAuthCallback } from "./oauth-callback.js";
export type { OAuthCallbackResult } from "./oauth-callback.js";
```

- [ ] **Step 6: Run tests (expected pass)**

Run: `bun test packages/mcp-server-atlassian/test/oauth-provider.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp-server-atlassian/src/atlassian-client packages/mcp-server-atlassian/test/oauth-provider.test.ts
git commit -m "SIO-650: Add AtlassianOAuthProvider with PKCE + tokens persistence"
```

---

## Task 4: Write-tools filter (TDD)

`isWriteTool` applied at registration. Pure function, easy to cover.

**Files:**
- Create: `packages/mcp-server-atlassian/src/tools/proxy/write-tools.ts`
- Create: `packages/mcp-server-atlassian/test/write-tools.test.ts`

- [ ] **Step 1: Write failing test**

Write to `packages/mcp-server-atlassian/test/write-tools.test.ts`:

```typescript
// test/write-tools.test.ts
import { describe, expect, test } from "bun:test";
import { isWriteTool } from "../src/tools/proxy/write-tools.js";

describe("isWriteTool", () => {
	test.each([
		"createJiraIssue",
		"updateJiraIssue",
		"deleteJiraIssue",
		"addCommentToJiraIssue",
		"addAttachmentToJiraIssue",
		"transitionJiraIssue",
		"assignJiraIssue",
		"moveConfluencePage",
		"createConfluencePage",
		"updateConfluencePage",
	])("classifies %s as write", (name) => {
		expect(isWriteTool(name)).toBe(true);
	});

	test.each([
		"searchJiraIssuesUsingJql",
		"getJiraIssue",
		"getJiraIssueComments",
		"searchConfluencePages",
		"getConfluencePage",
		"getAccessibleAtlassianResources",
		"lookupJiraIssue",
	])("classifies %s as read", (name) => {
		expect(isWriteTool(name)).toBe(false);
	});
});
```

- [ ] **Step 2: Run test (expected fail)**

Run: `bun test packages/mcp-server-atlassian/test/write-tools.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `write-tools.ts`**

Write to `packages/mcp-server-atlassian/src/tools/proxy/write-tools.ts`:

```typescript
// src/tools/proxy/write-tools.ts

export const WRITE_TOOL_PATTERNS = [
	/^create/i,
	/^update/i,
	/^delete/i,
	/^add.*(?:Comment|Attachment)/i,
	/^transition/i,
	/^assign/i,
	/^move/i,
];

export function isWriteTool(name: string): boolean {
	return WRITE_TOOL_PATTERNS.some((re) => re.test(name));
}
```

- [ ] **Step 4: Run test (expected pass)**

Run: `bun test packages/mcp-server-atlassian/test/write-tools.test.ts`
Expected: 17 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server-atlassian/src/tools/proxy/write-tools.ts packages/mcp-server-atlassian/test/write-tools.test.ts
git commit -m "SIO-650: Add write-tool filter for Atlassian read-only enforcement"
```

---

## Task 5: AtlassianMcpProxy (TDD — cloudId resolution + injection + auth retry)

The proxy owns connect/OAuth/listTools/callTool and the cached cloudId. Tests use a fake `Client` injected via constructor.

**Files:**
- Create: `packages/mcp-server-atlassian/src/atlassian-client/proxy.ts`
- Create: `packages/mcp-server-atlassian/test/proxy.test.ts`
- Modify: `packages/mcp-server-atlassian/src/atlassian-client/index.ts` (re-export proxy)

- [ ] **Step 1: Write failing test**

Write to `packages/mcp-server-atlassian/test/proxy.test.ts`:

```typescript
// test/proxy.test.ts
import { describe, expect, test } from "bun:test";
import { AtlassianMcpProxy, type McpClientLike } from "../src/atlassian-client/proxy.js";

function makeClient(overrides: Partial<McpClientLike> = {}): McpClientLike {
	return {
		listTools: async () => ({ tools: [] }),
		callTool: async () => ({ content: [] }),
		...overrides,
	};
}

describe("AtlassianMcpProxy.resolveCloudId", () => {
	test("selects first resource when siteName unset", async () => {
		const client = makeClient({
			callTool: async ({ name }) => {
				if (name === "getAccessibleAtlassianResources") {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify([
									{ id: "c-first", name: "primary" },
									{ id: "c-second", name: "secondary" },
								]),
							},
						],
					};
				}
				return { content: [] };
			},
		});
		const proxy = new AtlassianMcpProxy({ mcpEndpoint: "x", callbackPort: 0, client, siteName: undefined });
		await proxy.resolveCloudId();
		expect(proxy.getCloudId()).toBe("c-first");
	});

	test("selects matching siteName", async () => {
		const client = makeClient({
			callTool: async () => ({
				content: [
					{
						type: "text",
						text: JSON.stringify([
							{ id: "c-first", name: "primary" },
							{ id: "c-target", name: "tommy" },
						]),
					},
				],
			}),
		});
		const proxy = new AtlassianMcpProxy({ mcpEndpoint: "x", callbackPort: 0, client, siteName: "tommy" });
		await proxy.resolveCloudId();
		expect(proxy.getCloudId()).toBe("c-target");
	});

	test("throws when no accessible resources", async () => {
		const client = makeClient({
			callTool: async () => ({ content: [{ type: "text", text: "[]" }] }),
		});
		const proxy = new AtlassianMcpProxy({ mcpEndpoint: "x", callbackPort: 0, client, siteName: undefined });
		await expect(proxy.resolveCloudId()).rejects.toThrow(/no accessible resources/i);
	});
});

describe("AtlassianMcpProxy.callTool", () => {
	test("injects cloudId into every call", async () => {
		const captured: Array<{ name: string; arguments: Record<string, unknown> }> = [];
		const client = makeClient({
			callTool: async (req) => {
				captured.push(req as { name: string; arguments: Record<string, unknown> });
				if (req.name === "getAccessibleAtlassianResources") {
					return { content: [{ type: "text", text: JSON.stringify([{ id: "c-xyz", name: "s" }]) }] };
				}
				return { content: [] };
			},
		});
		const proxy = new AtlassianMcpProxy({ mcpEndpoint: "x", callbackPort: 0, client, siteName: undefined });
		await proxy.resolveCloudId();
		await proxy.callTool("searchJiraIssuesUsingJql", { jql: "project = INC" });
		const searchCall = captured.find((c) => c.name === "searchJiraIssuesUsingJql");
		expect(searchCall?.arguments.cloudId).toBe("c-xyz");
		expect(searchCall?.arguments.jql).toBe("project = INC");
	});

	test("retries once after UnauthorizedError then succeeds", async () => {
		const { UnauthorizedError } = await import("@modelcontextprotocol/sdk/client/auth.js");
		let callCount = 0;
		const client = makeClient({
			callTool: async (req) => {
				if (req.name === "getAccessibleAtlassianResources") {
					return { content: [{ type: "text", text: JSON.stringify([{ id: "c1", name: "s" }]) }] };
				}
				callCount++;
				if (callCount === 1) throw new UnauthorizedError("expired");
				return { content: [{ type: "text", text: "ok" }] };
			},
		});
		let reauthCalled = 0;
		const proxy = new AtlassianMcpProxy({
			mcpEndpoint: "x",
			callbackPort: 0,
			client,
			siteName: undefined,
			reauth: async () => {
				reauthCalled++;
			},
		});
		await proxy.resolveCloudId();
		const result = await proxy.callTool("searchJiraIssuesUsingJql", {});
		expect(reauthCalled).toBe(1);
		expect(callCount).toBe(2);
		expect((result as { content: Array<{ text: string }> }).content[0].text).toBe("ok");
	});

	test("returns ATLASSIAN_AUTH_REQUIRED error result after second failure", async () => {
		const { UnauthorizedError } = await import("@modelcontextprotocol/sdk/client/auth.js");
		const client = makeClient({
			callTool: async (req) => {
				if (req.name === "getAccessibleAtlassianResources") {
					return { content: [{ type: "text", text: JSON.stringify([{ id: "c1", name: "s" }]) }] };
				}
				throw new UnauthorizedError("expired");
			},
		});
		const proxy = new AtlassianMcpProxy({
			mcpEndpoint: "x",
			callbackPort: 0,
			client,
			siteName: undefined,
			reauth: async () => {},
		});
		await proxy.resolveCloudId();
		const result = (await proxy.callTool("searchJiraIssuesUsingJql", {})) as {
			isError?: boolean;
			content: Array<{ text: string }>;
		};
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("ATLASSIAN_AUTH_REQUIRED");
	});
});
```

- [ ] **Step 2: Run tests (expected fail)**

Run: `bun test packages/mcp-server-atlassian/test/proxy.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `proxy.ts`**

Write to `packages/mcp-server-atlassian/src/atlassian-client/proxy.ts`:

```typescript
// src/atlassian-client/proxy.ts

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createContextLogger } from "../utils/logger.js";
import { AtlassianOAuthProvider, type AuthorizationHandler } from "./oauth-provider.js";
import { waitForOAuthCallback } from "./oauth-callback.js";

const log = createContextLogger("proxy");

const RESOURCES_TOOL = "getAccessibleAtlassianResources";

export interface ProxyToolInfo {
	name: string;
	description: string;
	inputSchema: Tool["inputSchema"];
}

// Minimal MCP client surface we depend on -- enables injection for tests
export interface McpClientLike {
	listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema: Tool["inputSchema"] }> }>;
	callTool(req: { name: string; arguments?: Record<string, unknown> }, schema?: unknown, opts?: { timeout?: number }): Promise<unknown>;
}

export interface AtlassianMcpProxyOptions {
	mcpEndpoint: string;
	callbackPort: number;
	siteName: string | undefined;
	timeout?: number;
	// Dependency injection for tests. In production, constructed from OAuthProvider + real Client.
	client?: McpClientLike;
	reauth?: () => Promise<void>;
}

interface ProxyCallResult {
	content?: Array<{ type: string; text: string }>;
	isError?: boolean;
}

interface AtlassianResource {
	id: string;
	name: string;
}

export class AtlassianMcpProxy {
	private readonly endpoint: string;
	private readonly callbackPort: number;
	private readonly siteName: string | undefined;
	private readonly timeout: number;
	private client: McpClientLike | null;
	private transport: StreamableHTTPClientTransport | null = null;
	private connected: boolean;
	private cloudId: string | null = null;
	private oauthProvider: AtlassianOAuthProvider | null = null;
	private reauth: (() => Promise<void>) | null;

	constructor(opts: AtlassianMcpProxyOptions) {
		this.endpoint = opts.mcpEndpoint;
		this.callbackPort = opts.callbackPort;
		this.siteName = opts.siteName;
		this.timeout = opts.timeout ?? 30000;
		this.client = opts.client ?? null;
		this.connected = opts.client !== undefined;
		this.reauth = opts.reauth ?? null;
	}

	async connect(): Promise<void> {
		if (this.client) {
			this.connected = true;
			return;
		}

		const mcpUrl = new URL(this.endpoint);
		log.info({ url: mcpUrl.toString() }, "Connecting to Atlassian Rovo MCP endpoint");

		const onRedirect: AuthorizationHandler = async (authUrl) => {
			log.info("Opening browser for Atlassian OAuth authorization...");
			console.log(`\n  Authorize in your browser:\n  ${authUrl.toString()}\n`);
			try {
				const platform = process.platform;
				const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
				Bun.spawn([cmd, authUrl.toString()]);
			} catch {
				log.warn("Could not open browser automatically. Please open the URL above manually.");
			}
		};

		this.oauthProvider = new AtlassianOAuthProvider({
			mcpEndpoint: this.endpoint,
			callbackPort: this.callbackPort,
			onRedirect,
		});

		const realClient = new Client({ name: "atlassian-mcp-proxy", version: "0.1.0" }, { capabilities: {} });
		this.transport = new StreamableHTTPClientTransport(mcpUrl, { authProvider: this.oauthProvider });

		try {
			await realClient.connect(this.transport);
			this.connected = true;
			this.client = asClientLike(realClient);
			log.info("Connected to Atlassian Rovo MCP server (authenticated)");
		} catch (error) {
			if (error instanceof UnauthorizedError) {
				log.info("OAuth authorization required -- waiting for browser callback...");
				const { code } = await waitForOAuthCallback(this.callbackPort);
				await this.transport.finishAuth(code);
				const retryClient = new Client({ name: "atlassian-mcp-proxy", version: "0.1.0" }, { capabilities: {} });
				this.transport = new StreamableHTTPClientTransport(mcpUrl, { authProvider: this.oauthProvider });
				await retryClient.connect(this.transport);
				this.connected = true;
				this.client = asClientLike(retryClient);
				log.info("Connected to Atlassian Rovo MCP server after OAuth authorization");
			} else {
				throw error;
			}
		}

		if (!this.reauth) {
			this.reauth = async () => {
				if (!this.transport || !this.oauthProvider) return;
				this.oauthProvider.invalidateCredentials("tokens");
				const { code } = await waitForOAuthCallback(this.callbackPort);
				await this.transport.finishAuth(code);
			};
		}
	}

	async resolveCloudId(): Promise<string> {
		if (!this.client) throw new Error("Not connected. Call connect() first.");
		const result = (await this.client.callTool({ name: RESOURCES_TOOL, arguments: {} })) as ProxyCallResult;
		const resources = parseResources(result);
		if (resources.length === 0) throw new Error("Atlassian Rovo: no accessible resources for authenticated user");
		const selected = this.siteName ? resources.find((r) => r.name === this.siteName) ?? resources[0] : resources[0];
		this.cloudId = selected.id;
		log.info({ cloudId: selected.id, site: selected.name }, "Resolved Atlassian cloudId");
		return this.cloudId;
	}

	getCloudId(): string | null {
		return this.cloudId;
	}

	async listTools(): Promise<ProxyToolInfo[]> {
		if (!this.client) throw new Error("Not connected. Call connect() first.");
		const response = await this.client.listTools();
		return response.tools.map((tool) => ({
			name: tool.name,
			description: tool.description || `${tool.name} tool`,
			inputSchema: tool.inputSchema,
		}));
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
		if (!this.client) throw new Error("Not connected. Call connect() first.");
		const argsWithCloudId = this.cloudId ? { cloudId: this.cloudId, ...args } : args;
		try {
			return await this.client.callTool(
				{ name, arguments: argsWithCloudId },
				undefined,
				{ timeout: this.timeout },
			);
		} catch (error) {
			if (error instanceof UnauthorizedError) {
				log.warn({ tool: name }, "UnauthorizedError; attempting one-shot re-auth retry");
				try {
					if (this.reauth) await this.reauth();
					return await this.client.callTool(
						{ name, arguments: argsWithCloudId },
						undefined,
						{ timeout: this.timeout },
					);
				} catch (retryError) {
					log.error(
						{ tool: name, error: retryError instanceof Error ? retryError.message : String(retryError) },
						"Re-auth retry failed",
					);
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: "ATLASSIAN_AUTH_REQUIRED: OAuth token refresh failed. Re-authorize via browser.",
							},
						],
					};
				}
			}
			throw error;
		}
	}

	async disconnect(): Promise<void> {
		if (this.transport) {
			await this.transport.close();
			this.transport = null;
		}
		this.connected = false;
		this.client = null;
	}

	isConnected(): boolean {
		return this.connected;
	}
}

function parseResources(result: ProxyCallResult): AtlassianResource[] {
	const text = result.content?.find((c) => c.type === "text")?.text;
	if (!text) return [];
	try {
		const parsed = JSON.parse(text);
		if (Array.isArray(parsed)) return parsed.filter(isResource);
		return [];
	} catch {
		return [];
	}
}

function isResource(x: unknown): x is AtlassianResource {
	if (typeof x !== "object" || x === null) return false;
	const obj = x as Record<string, unknown>;
	return typeof obj.id === "string" && typeof obj.name === "string";
}

function asClientLike(client: Client): McpClientLike {
	return {
		listTools: () => client.listTools(),
		callTool: (req, schema, opts) => client.callTool(req, schema as never, opts),
	};
}
```

- [ ] **Step 4: Update `atlassian-client/index.ts` to re-export the proxy**

Edit `packages/mcp-server-atlassian/src/atlassian-client/index.ts` — replace contents with:

```typescript
// src/atlassian-client/index.ts

export { AtlassianOAuthProvider, OAUTH_CALLBACK_PATH } from "./oauth-provider.js";
export type { AtlassianOAuthProviderOptions, AuthorizationHandler } from "./oauth-provider.js";
export { waitForOAuthCallback } from "./oauth-callback.js";
export type { OAuthCallbackResult } from "./oauth-callback.js";
export { AtlassianMcpProxy } from "./proxy.js";
export type { AtlassianMcpProxyOptions, McpClientLike, ProxyToolInfo } from "./proxy.js";
```

- [ ] **Step 5: Run tests (expected pass)**

Run: `bun test packages/mcp-server-atlassian/test/proxy.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-server-atlassian/src/atlassian-client packages/mcp-server-atlassian/test/proxy.test.ts
git commit -m "SIO-650: Add AtlassianMcpProxy with cloudId resolution and auth retry"
```

---

## Task 6: Proxy tool registration

Builds Zod shapes from JSON schema, applies write filter, registers tools with `atlassian_` prefix.

**Files:**
- Create: `packages/mcp-server-atlassian/src/tools/proxy/index.ts`

- [ ] **Step 1: Write `tools/proxy/index.ts`**

Write:

```typescript
// src/tools/proxy/index.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AtlassianMcpProxy, ProxyToolInfo } from "../../atlassian-client/index.js";
import { createContextLogger } from "../../utils/logger.js";
import { traceToolCall } from "../../utils/tracing.js";
import { isWriteTool } from "./write-tools.js";

const log = createContextLogger("proxy-tools");

const TOOL_PREFIX = "atlassian_";

interface ProxyCallResult {
	content?: Array<{ type: string; text: string }>;
	isError?: boolean;
}

function jsonSchemaTypeToZod(key: string, prop: Record<string, unknown>): z.ZodTypeAny {
	const description = typeof prop.description === "string" ? prop.description : key;
	switch (prop.type) {
		case "string":
			return z.union([z.string(), z.number().transform(String)]).describe(description);
		case "number":
		case "integer":
			return z.number().describe(description);
		case "boolean":
			return z.boolean().describe(description);
		case "array":
			return z.array(z.unknown()).describe(description);
		default:
			return z.unknown().describe(description);
	}
}

function buildZodShapeFromJsonSchema(inputSchema: ProxyToolInfo["inputSchema"]): Record<string, z.ZodTypeAny> {
	const properties = inputSchema.properties ?? {};
	const required = new Set(inputSchema.required ?? []);
	const shape: Record<string, z.ZodTypeAny> = {};
	for (const [key, prop] of Object.entries(properties)) {
		// Skip cloudId -- the proxy injects it automatically
		if (key === "cloudId") continue;
		const field = jsonSchemaTypeToZod(key, (prop ?? {}) as Record<string, unknown>);
		shape[key] = required.has(key) ? field : field.optional();
	}
	return shape;
}

export interface ProxyRegistrationOptions {
	readOnly: boolean;
}

export function registerProxyTools(
	server: McpServer,
	proxy: AtlassianMcpProxy,
	remoteTools: ProxyToolInfo[],
	opts: ProxyRegistrationOptions,
): { registered: number; filtered: number } {
	const registered: string[] = [];
	let filtered = 0;

	for (const tool of remoteTools) {
		if (opts.readOnly && isWriteTool(tool.name)) {
			filtered++;
			continue;
		}
		const prefixedName = tool.name.startsWith(TOOL_PREFIX) ? tool.name : `${TOOL_PREFIX}${tool.name}`;
		const zodShape = buildZodShapeFromJsonSchema(tool.inputSchema);

		const handler = async (args: Record<string, unknown>) => {
			return traceToolCall(prefixedName, async () => {
				try {
					const result = (await proxy.callTool(tool.name, args)) as ProxyCallResult;
					const content = (result.content ?? []).map((c) => ({
						type: "text" as const,
						text: typeof c.text === "string" ? c.text : JSON.stringify(c),
					}));
					if (result.isError) return { content, isError: true };
					return { content };
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					log.error({ tool: prefixedName, error: message }, "Proxy tool call failed");
					return {
						content: [{ type: "text" as const, text: `Error: ${message}` }],
						isError: true,
					};
				}
			});
		};

		server.tool(prefixedName, tool.description, zodShape, handler);
		registered.push(prefixedName);
	}

	log.info({ registered: registered.length, filtered, readOnly: opts.readOnly }, "Atlassian proxy tools registered");
	return { registered: registered.length, filtered };
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run --filter '@devops-agent/mcp-server-atlassian' typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/mcp-server-atlassian/src/tools/proxy/index.ts
git commit -m "SIO-650: Add proxy tool registration with write filter and cloudId injection"
```

---

## Task 7: Custom tool — `findLinkedIncidents` (TDD)

**Files:**
- Create: `packages/mcp-server-atlassian/src/tools/custom/find-linked-incidents.ts`
- Create: `packages/mcp-server-atlassian/test/find-linked-incidents.test.ts`

- [ ] **Step 1: Write failing test**

Write to `packages/mcp-server-atlassian/test/find-linked-incidents.test.ts`:

```typescript
// test/find-linked-incidents.test.ts
import { describe, expect, test } from "bun:test";
import type { AtlassianMcpProxy } from "../src/atlassian-client/index.js";
import { buildJql, shapeIssue, findLinkedIncidents } from "../src/tools/custom/find-linked-incidents.js";

describe("findLinkedIncidents.buildJql", () => {
	test("constrains to incidentProjects when provided", () => {
		const jql = buildJql({
			service: "checkout-api",
			componentLabel: undefined,
			withinDays: 30,
			incidentProjects: ["INC", "OPS"],
		});
		expect(jql).toContain("project in (INC, OPS)");
		expect(jql).toContain('labels = "checkout-api"');
		expect(jql).toContain("created >= -30d");
	});

	test("falls back when incidentProjects empty", () => {
		const jql = buildJql({ service: "x", componentLabel: undefined, withinDays: 7, incidentProjects: [] });
		expect(jql).toContain("project is not EMPTY");
	});
});

describe("findLinkedIncidents.shapeIssue", () => {
	test("extracts severity from priority.name first", () => {
		const shaped = shapeIssue({
			key: "INC-1",
			fields: {
				summary: "db timeout",
				status: { name: "Resolved" },
				priority: { name: "High" },
				customfield_severity: { value: "Critical" },
				created: "2026-04-10T10:00:00Z",
				resolutiondate: "2026-04-10T11:30:00Z",
			},
		});
		expect(shaped.severity).toBe("High");
		expect(shaped.mttrMinutes).toBe(90);
		expect(shaped.key).toBe("INC-1");
	});

	test("falls back to customfield_severity when priority missing", () => {
		const shaped = shapeIssue({
			key: "INC-2",
			fields: {
				summary: "s",
				status: { name: "Open" },
				priority: null,
				customfield_severity: { value: "Sev2" },
				created: "2026-04-10T10:00:00Z",
				resolutiondate: null,
			},
		});
		expect(shaped.severity).toBe("Sev2");
		expect(shaped.mttrMinutes).toBeNull();
		expect(shaped.resolvedAt).toBeNull();
	});

	test("severity null when both missing", () => {
		const shaped = shapeIssue({
			key: "INC-3",
			fields: { summary: "s", status: { name: "Open" }, created: "2026-04-10T10:00:00Z" },
		});
		expect(shaped.severity).toBeNull();
	});
});

describe("findLinkedIncidents (end-to-end with mock proxy)", () => {
	test("returns shaped issues via proxy.callTool", async () => {
		const fakeProxy = {
			callTool: async () => ({
				content: [
					{
						type: "text",
						text: JSON.stringify({
							issues: [
								{
									key: "INC-1",
									fields: {
										summary: "checkout down",
										status: { name: "Resolved" },
										priority: { name: "High" },
										created: "2026-04-10T10:00:00Z",
										resolutiondate: "2026-04-10T10:30:00Z",
									},
								},
							],
						}),
					},
				],
			}),
		} as unknown as AtlassianMcpProxy;

		const result = await findLinkedIncidents(fakeProxy, {
			service: "checkout-api",
			withinDays: 30,
			limit: 10,
			incidentProjects: ["INC"],
			siteUrl: "https://tommy.atlassian.net",
		});
		expect(result.count).toBe(1);
		expect(result.issues[0].key).toBe("INC-1");
		expect(result.issues[0].url).toBe("https://tommy.atlassian.net/browse/INC-1");
		expect(result.issues[0].mttrMinutes).toBe(30);
	});
});
```

- [ ] **Step 2: Run test (expected fail)**

Run: `bun test packages/mcp-server-atlassian/test/find-linked-incidents.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `find-linked-incidents.ts`**

Write to `packages/mcp-server-atlassian/src/tools/custom/find-linked-incidents.ts`:

```typescript
// src/tools/custom/find-linked-incidents.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AtlassianMcpProxy } from "../../atlassian-client/index.js";
import { createContextLogger } from "../../utils/logger.js";
import { traceToolCall } from "../../utils/tracing.js";

const log = createContextLogger("find-linked-incidents");

export const InputSchema = z.object({
	service: z.string().min(1).describe("Service, component, or label name to search for"),
	componentLabel: z.string().optional().describe("Optional Jira component label (overrides service label match)"),
	withinDays: z.number().int().min(1).max(365).default(30).describe("Look-back window in days"),
	limit: z.number().int().min(1).max(50).default(10).describe("Maximum issues to return"),
});

export const OutputSchema = z.object({
	count: z.number(),
	issues: z.array(
		z.object({
			key: z.string(),
			summary: z.string(),
			status: z.string(),
			severity: z.string().nullable(),
			createdAt: z.string(),
			resolvedAt: z.string().nullable(),
			mttrMinutes: z.number().nullable(),
			url: z.string(),
		}),
	),
});

export type FindLinkedIncidentsInput = z.infer<typeof InputSchema>;
export type FindLinkedIncidentsOutput = z.infer<typeof OutputSchema>;

interface BuildJqlArgs {
	service: string;
	componentLabel: string | undefined;
	withinDays: number;
	incidentProjects: string[];
}

export function buildJql(args: BuildJqlArgs): string {
	const projectClause =
		args.incidentProjects.length > 0 ? `project in (${args.incidentProjects.join(", ")})` : "project is not EMPTY";
	const label = args.componentLabel ?? args.service;
	const matchClause = `(labels = "${label}" OR text ~ "${args.service}")`;
	return `${projectClause} AND ${matchClause} AND created >= -${args.withinDays}d ORDER BY created DESC`;
}

interface JiraIssueRaw {
	key: string;
	fields: {
		summary: string;
		status: { name: string };
		priority?: { name: string } | null;
		customfield_severity?: { value: string } | null;
		created: string;
		resolutiondate?: string | null;
	};
}

export function shapeIssue(raw: JiraIssueRaw, siteUrl?: string): FindLinkedIncidentsOutput["issues"][number] {
	const severity = raw.fields.priority?.name ?? raw.fields.customfield_severity?.value ?? null;
	const resolvedAt = raw.fields.resolutiondate ?? null;
	const mttrMinutes = resolvedAt
		? Math.round((new Date(resolvedAt).getTime() - new Date(raw.fields.created).getTime()) / 60000)
		: null;
	const url = siteUrl ? `${siteUrl}/browse/${raw.key}` : `/browse/${raw.key}`;
	return {
		key: raw.key,
		summary: raw.fields.summary,
		status: raw.fields.status.name,
		severity,
		createdAt: raw.fields.created,
		resolvedAt,
		mttrMinutes,
		url,
	};
}

interface ProxyCallResult {
	content?: Array<{ type: string; text: string }>;
	isError?: boolean;
}

function extractIssues(result: ProxyCallResult): JiraIssueRaw[] {
	const text = result.content?.find((c) => c.type === "text")?.text;
	if (!text) return [];
	try {
		const parsed = JSON.parse(text) as { issues?: JiraIssueRaw[] };
		return parsed.issues ?? [];
	} catch {
		return [];
	}
}

export interface FindLinkedIncidentsContext {
	service: string;
	componentLabel?: string;
	withinDays: number;
	limit: number;
	incidentProjects: string[];
	siteUrl?: string;
}

export async function findLinkedIncidents(
	proxy: AtlassianMcpProxy,
	ctx: FindLinkedIncidentsContext,
): Promise<FindLinkedIncidentsOutput> {
	const jql = buildJql({
		service: ctx.service,
		componentLabel: ctx.componentLabel,
		withinDays: ctx.withinDays,
		incidentProjects: ctx.incidentProjects,
	});
	if (ctx.incidentProjects.length === 0) {
		log.warn({ jql }, "No incident projects configured; using broad JQL fallback");
	}
	const result = (await proxy.callTool("searchJiraIssuesUsingJql", { jql, maxResults: ctx.limit })) as ProxyCallResult;
	const issues = extractIssues(result).slice(0, ctx.limit).map((i) => shapeIssue(i, ctx.siteUrl));
	return { count: issues.length, issues };
}

export function registerFindLinkedIncidents(
	server: McpServer,
	proxy: AtlassianMcpProxy,
	incidentProjects: string[],
	siteUrl?: string,
): void {
	server.tool(
		"findLinkedIncidents",
		"Find recent Jira incidents linked to a service by label or text match, shaped with severity and MTTR.",
		InputSchema.shape,
		async (args) => {
			return traceToolCall("findLinkedIncidents", async () => {
				const parsed = InputSchema.parse(args);
				const output = await findLinkedIncidents(proxy, {
					service: parsed.service,
					componentLabel: parsed.componentLabel,
					withinDays: parsed.withinDays,
					limit: parsed.limit,
					incidentProjects,
					siteUrl,
				});
				return { content: [{ type: "text" as const, text: JSON.stringify(output) }] };
			});
		},
	);
}
```

- [ ] **Step 4: Run test (expected pass)**

Run: `bun test packages/mcp-server-atlassian/test/find-linked-incidents.test.ts`
Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server-atlassian/src/tools/custom/find-linked-incidents.ts packages/mcp-server-atlassian/test/find-linked-incidents.test.ts
git commit -m "SIO-650: Add findLinkedIncidents custom tool"
```

---

## Task 8: Custom tool — `getRunbookForAlert` (TDD)

**Files:**
- Create: `packages/mcp-server-atlassian/src/tools/custom/get-runbook-for-alert.ts`
- Create: `packages/mcp-server-atlassian/test/get-runbook-for-alert.test.ts`

- [ ] **Step 1: Write failing test**

Write to `packages/mcp-server-atlassian/test/get-runbook-for-alert.test.ts`:

```typescript
// test/get-runbook-for-alert.test.ts
import { describe, expect, test } from "bun:test";
import type { AtlassianMcpProxy } from "../src/atlassian-client/index.js";
import { buildCql, scorePage, getRunbookForAlert } from "../src/tools/custom/get-runbook-for-alert.js";

describe("getRunbookForAlert.buildCql", () => {
	test("includes service and keywords joined with OR", () => {
		const cql = buildCql({ service: "checkout-api", errorKeywords: ["timeout", "502"], spaceKey: undefined });
		expect(cql).toContain("text ~ \"checkout-api\"");
		expect(cql).toContain("text ~ \"timeout\"");
		expect(cql).toContain("text ~ \"502\"");
	});

	test("scopes to space when provided", () => {
		const cql = buildCql({ service: "svc", errorKeywords: ["err"], spaceKey: "RUNBOOKS" });
		expect(cql).toContain('space = "RUNBOOKS"');
	});
});

describe("getRunbookForAlert.scorePage", () => {
	test("title with service scores higher than body-only match", () => {
		const withTitle = scorePage(
			{
				title: "Checkout-API Runbook",
				labels: ["runbook"],
				lastUpdated: new Date().toISOString(),
				excerpt: "",
			},
			"checkout-api",
			["timeout"],
		);
		const bodyOnly = scorePage(
			{ title: "Some Other Page", labels: [], lastUpdated: new Date().toISOString(), excerpt: "" },
			"checkout-api",
			["timeout"],
		);
		expect(withTitle).toBeGreaterThan(bodyOnly);
	});

	test("runbook label adds score", () => {
		const withLabel = scorePage(
			{ title: "Page", labels: ["runbook"], lastUpdated: "2020-01-01T00:00:00Z", excerpt: "" },
			"svc",
			["err"],
		);
		const withoutLabel = scorePage(
			{ title: "Page", labels: [], lastUpdated: "2020-01-01T00:00:00Z", excerpt: "" },
			"svc",
			["err"],
		);
		expect(withLabel).toBeGreaterThan(withoutLabel);
	});

	test("recent update (within 90d) adds score", () => {
		const recent = scorePage(
			{ title: "Page", labels: [], lastUpdated: new Date().toISOString(), excerpt: "" },
			"svc",
			["err"],
		);
		const stale = scorePage(
			{ title: "Page", labels: [], lastUpdated: "2020-01-01T00:00:00Z", excerpt: "" },
			"svc",
			["err"],
		);
		expect(recent).toBeGreaterThan(stale);
	});
});

describe("getRunbookForAlert (end-to-end)", () => {
	test("orders results by relevance score desc and respects limit", async () => {
		const fakeProxy = {
			callTool: async () => ({
				content: [
					{
						type: "text",
						text: JSON.stringify({
							results: [
								{
									id: "p1",
									title: "Unrelated Page",
									spaceKey: "DOCS",
									labels: [],
									lastUpdated: "2020-01-01T00:00:00Z",
									excerpt: "",
								},
								{
									id: "p2",
									title: "checkout-api Runbook",
									spaceKey: "OPS",
									labels: ["runbook"],
									lastUpdated: new Date().toISOString(),
									excerpt: "",
								},
							],
						}),
					},
				],
			}),
		} as unknown as AtlassianMcpProxy;
		const out = await getRunbookForAlert(fakeProxy, {
			service: "checkout-api",
			errorKeywords: ["timeout"],
			spaceKey: undefined,
			limit: 5,
			siteUrl: "https://tommy.atlassian.net/wiki",
		});
		expect(out.matches[0].title).toBe("checkout-api Runbook");
		expect(out.matches[0].relevanceScore).toBeGreaterThan(out.matches[1].relevanceScore);
	});
});
```

- [ ] **Step 2: Run test (expected fail)**

Run: `bun test packages/mcp-server-atlassian/test/get-runbook-for-alert.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `get-runbook-for-alert.ts`**

Write to `packages/mcp-server-atlassian/src/tools/custom/get-runbook-for-alert.ts`:

```typescript
// src/tools/custom/get-runbook-for-alert.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AtlassianMcpProxy } from "../../atlassian-client/index.js";
import { traceToolCall } from "../../utils/tracing.js";

const FRESH_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export const InputSchema = z.object({
	service: z.string().min(1).describe("Service name to match against runbook titles and bodies"),
	errorKeywords: z.array(z.string().min(1)).min(1).max(10).describe("Error signature keywords"),
	spaceKey: z.string().optional().describe("Confluence space key to scope the search"),
	limit: z.number().int().min(1).max(10).default(5).describe("Maximum matches to return"),
});

export const OutputSchema = z.object({
	matches: z.array(
		z.object({
			pageId: z.string(),
			title: z.string(),
			spaceKey: z.string(),
			excerpt: z.string(),
			lastUpdated: z.string(),
			relevanceScore: z.number(),
			url: z.string(),
		}),
	),
});

export type GetRunbookInput = z.infer<typeof InputSchema>;
export type GetRunbookOutput = z.infer<typeof OutputSchema>;

export interface BuildCqlArgs {
	service: string;
	errorKeywords: string[];
	spaceKey: string | undefined;
}

export function buildCql(args: BuildCqlArgs): string {
	const terms = [args.service, ...args.errorKeywords].map((t) => `text ~ "${t}"`).join(" OR ");
	const spaceClause = args.spaceKey ? `space = "${args.spaceKey}" AND ` : "";
	return `${spaceClause}type = "page" AND (${terms}) ORDER BY lastModified DESC`;
}

export interface ConfluencePageRaw {
	id?: string;
	title: string;
	spaceKey?: string;
	labels?: string[];
	lastUpdated: string;
	excerpt?: string;
}

export function scorePage(page: ConfluencePageRaw, service: string, keywords: string[]): number {
	let score = 0;
	const title = page.title.toLowerCase();
	const svc = service.toLowerCase();
	if (title.includes(svc)) score += 3;
	if (keywords.some((k) => title.includes(k.toLowerCase()))) score += 2;
	if (page.labels?.includes("runbook")) score += 2;
	const age = Date.now() - new Date(page.lastUpdated).getTime();
	if (age >= 0 && age < FRESH_WINDOW_MS) score += 1;
	return score;
}

interface ProxyCallResult {
	content?: Array<{ type: string; text: string }>;
	isError?: boolean;
}

function extractPages(result: ProxyCallResult): ConfluencePageRaw[] {
	const text = result.content?.find((c) => c.type === "text")?.text;
	if (!text) return [];
	try {
		const parsed = JSON.parse(text) as { results?: ConfluencePageRaw[] };
		return parsed.results ?? [];
	} catch {
		return [];
	}
}

export interface GetRunbookContext {
	service: string;
	errorKeywords: string[];
	spaceKey: string | undefined;
	limit: number;
	siteUrl?: string;
}

export async function getRunbookForAlert(
	proxy: AtlassianMcpProxy,
	ctx: GetRunbookContext,
): Promise<GetRunbookOutput> {
	const cql = buildCql({ service: ctx.service, errorKeywords: ctx.errorKeywords, spaceKey: ctx.spaceKey });
	const result = (await proxy.callTool("searchConfluencePages", { cql, limit: ctx.limit * 3 })) as ProxyCallResult;
	const pages = extractPages(result);
	const scored = pages
		.map((p) => ({ page: p, score: scorePage(p, ctx.service, ctx.errorKeywords) }))
		.sort((a, b) => b.score - a.score)
		.slice(0, ctx.limit);
	return {
		matches: scored.map(({ page, score }) => ({
			pageId: page.id ?? "",
			title: page.title,
			spaceKey: page.spaceKey ?? "",
			excerpt: page.excerpt ?? "",
			lastUpdated: page.lastUpdated,
			relevanceScore: score,
			url: ctx.siteUrl && page.id ? `${ctx.siteUrl}/pages/${page.id}` : page.id ? `/pages/${page.id}` : "",
		})),
	};
}

export function registerGetRunbookForAlert(
	server: McpServer,
	proxy: AtlassianMcpProxy,
	siteUrl?: string,
): void {
	server.tool(
		"getRunbookForAlert",
		"Find the most relevant Confluence runbook pages for an alert by service and error keywords, scored client-side.",
		InputSchema.shape,
		async (args) => {
			return traceToolCall("getRunbookForAlert", async () => {
				const parsed = InputSchema.parse(args);
				const output = await getRunbookForAlert(proxy, {
					service: parsed.service,
					errorKeywords: parsed.errorKeywords,
					spaceKey: parsed.spaceKey,
					limit: parsed.limit,
					siteUrl,
				});
				return { content: [{ type: "text" as const, text: JSON.stringify(output) }] };
			});
		},
	);
}
```

- [ ] **Step 4: Run test (expected pass)**

Run: `bun test packages/mcp-server-atlassian/test/get-runbook-for-alert.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server-atlassian/src/tools/custom/get-runbook-for-alert.ts packages/mcp-server-atlassian/test/get-runbook-for-alert.test.ts
git commit -m "SIO-650: Add getRunbookForAlert custom tool with relevance ranking"
```

---

## Task 9: Custom tool — `getIncidentHistory` (TDD)

**Files:**
- Create: `packages/mcp-server-atlassian/src/tools/custom/get-incident-history.ts`
- Create: `packages/mcp-server-atlassian/test/get-incident-history.test.ts`

- [ ] **Step 1: Write failing test**

Write to `packages/mcp-server-atlassian/test/get-incident-history.test.ts`:

```typescript
// test/get-incident-history.test.ts
import { describe, expect, test } from "bun:test";
import type { AtlassianMcpProxy } from "../src/atlassian-client/index.js";
import { bucketKey, aggregate, getIncidentHistory } from "../src/tools/custom/get-incident-history.js";

describe("getIncidentHistory.bucketKey", () => {
	test("weekly bucket is ISO week start (Monday)", () => {
		// 2026-04-15 is a Wednesday; ISO week start is 2026-04-13
		expect(bucketKey(new Date("2026-04-15T12:00:00Z"), "week")).toBe("2026-04-13");
	});

	test("monthly bucket is YYYY-MM-01", () => {
		expect(bucketKey(new Date("2026-04-15T12:00:00Z"), "month")).toBe("2026-04-01");
	});
});

describe("getIncidentHistory.aggregate", () => {
	test("computes per-bucket count, total MTTR, unresolved count", () => {
		const issues = [
			{ fields: { created: "2026-04-13T10:00:00Z", resolutiondate: "2026-04-13T11:00:00Z" } },
			{ fields: { created: "2026-04-14T10:00:00Z", resolutiondate: null } },
			{ fields: { created: "2026-04-21T10:00:00Z", resolutiondate: "2026-04-21T10:30:00Z" } },
		];
		const out = aggregate(issues, 30, "week", "svc");
		expect(out.totals.incidentCount).toBe(3);
		expect(out.totals.unresolvedCount).toBe(1);
		// Mean MTTR = (60 + 30) / 2 = 45 minutes
		expect(out.totals.mttrMinutes).toBe(45);
		expect(out.buckets.length).toBe(2);
	});

	test("mttrMinutes is null when all issues unresolved", () => {
		const issues = [{ fields: { created: "2026-04-13T10:00:00Z", resolutiondate: null } }];
		const out = aggregate(issues, 30, "week", "svc");
		expect(out.totals.mttrMinutes).toBeNull();
	});

	test("empty issues returns zero counts", () => {
		const out = aggregate([], 30, "week", "svc");
		expect(out.totals.incidentCount).toBe(0);
		expect(out.totals.unresolvedCount).toBe(0);
		expect(out.totals.mttrMinutes).toBeNull();
		expect(out.buckets).toEqual([]);
	});
});

describe("getIncidentHistory (end-to-end)", () => {
	test("end-to-end via mock proxy", async () => {
		const fakeProxy = {
			callTool: async () => ({
				content: [
					{
						type: "text",
						text: JSON.stringify({
							issues: [
								{ fields: { created: "2026-04-13T10:00:00Z", resolutiondate: "2026-04-13T11:00:00Z" } },
							],
						}),
					},
				],
			}),
		} as unknown as AtlassianMcpProxy;
		const out = await getIncidentHistory(fakeProxy, {
			service: "svc",
			windowDays: 30,
			groupBy: "week",
			incidentProjects: ["INC"],
		});
		expect(out.totals.incidentCount).toBe(1);
		expect(out.buckets).toHaveLength(1);
	});
});
```

- [ ] **Step 2: Run test (expected fail)**

Run: `bun test packages/mcp-server-atlassian/test/get-incident-history.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `get-incident-history.ts`**

Write to `packages/mcp-server-atlassian/src/tools/custom/get-incident-history.ts`:

```typescript
// src/tools/custom/get-incident-history.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AtlassianMcpProxy } from "../../atlassian-client/index.js";
import { buildJql } from "./find-linked-incidents.js";
import { traceToolCall } from "../../utils/tracing.js";

export const InputSchema = z.object({
	service: z.string().min(1),
	windowDays: z.number().int().min(1).max(365).default(90),
	groupBy: z.enum(["week", "month"]).default("week"),
});

export const OutputSchema = z.object({
	service: z.string(),
	windowDays: z.number(),
	totals: z.object({
		incidentCount: z.number(),
		mttrMinutes: z.number().nullable(),
		unresolvedCount: z.number(),
	}),
	buckets: z.array(
		z.object({
			periodStart: z.string(),
			count: z.number(),
			mttrMinutes: z.number().nullable(),
		}),
	),
});

export type GetIncidentHistoryInput = z.infer<typeof InputSchema>;
export type GetIncidentHistoryOutput = z.infer<typeof OutputSchema>;

export function bucketKey(date: Date, groupBy: "week" | "month"): string {
	if (groupBy === "month") {
		const y = date.getUTCFullYear();
		const m = String(date.getUTCMonth() + 1).padStart(2, "0");
		return `${y}-${m}-01`;
	}
	// ISO week start (Monday) in UTC
	const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	const day = d.getUTCDay();
	const mondayOffset = day === 0 ? -6 : 1 - day;
	d.setUTCDate(d.getUTCDate() + mondayOffset);
	return d.toISOString().slice(0, 10);
}

interface IssueForAggregation {
	fields: { created: string; resolutiondate?: string | null };
}

interface BucketAgg {
	count: number;
	mttrSumMinutes: number;
	mttrResolvedCount: number;
}

export function aggregate(
	issues: IssueForAggregation[],
	windowDays: number,
	groupBy: "week" | "month",
	service: string,
): GetIncidentHistoryOutput {
	const buckets = new Map<string, BucketAgg>();
	let totalMttrSum = 0;
	let totalResolved = 0;
	let unresolved = 0;

	for (const issue of issues) {
		const created = new Date(issue.fields.created);
		const key = bucketKey(created, groupBy);
		const agg = buckets.get(key) ?? { count: 0, mttrSumMinutes: 0, mttrResolvedCount: 0 };
		agg.count += 1;
		if (issue.fields.resolutiondate) {
			const minutes = Math.round(
				(new Date(issue.fields.resolutiondate).getTime() - created.getTime()) / 60000,
			);
			agg.mttrSumMinutes += minutes;
			agg.mttrResolvedCount += 1;
			totalMttrSum += minutes;
			totalResolved += 1;
		} else {
			unresolved += 1;
		}
		buckets.set(key, agg);
	}

	const sortedKeys = [...buckets.keys()].sort();
	const bucketOutput = sortedKeys.map((periodStart) => {
		const agg = buckets.get(periodStart);
		if (!agg) throw new Error(`missing bucket ${periodStart}`);
		return {
			periodStart,
			count: agg.count,
			mttrMinutes: agg.mttrResolvedCount > 0 ? Math.round(agg.mttrSumMinutes / agg.mttrResolvedCount) : null,
		};
	});

	return {
		service,
		windowDays,
		totals: {
			incidentCount: issues.length,
			mttrMinutes: totalResolved > 0 ? Math.round(totalMttrSum / totalResolved) : null,
			unresolvedCount: unresolved,
		},
		buckets: bucketOutput,
	};
}

interface ProxyCallResult {
	content?: Array<{ type: string; text: string }>;
	isError?: boolean;
}

function extractIssues(result: ProxyCallResult): IssueForAggregation[] {
	const text = result.content?.find((c) => c.type === "text")?.text;
	if (!text) return [];
	try {
		const parsed = JSON.parse(text) as { issues?: IssueForAggregation[] };
		return parsed.issues ?? [];
	} catch {
		return [];
	}
}

export interface GetIncidentHistoryContext {
	service: string;
	windowDays: number;
	groupBy: "week" | "month";
	incidentProjects: string[];
}

export async function getIncidentHistory(
	proxy: AtlassianMcpProxy,
	ctx: GetIncidentHistoryContext,
): Promise<GetIncidentHistoryOutput> {
	const jql = buildJql({
		service: ctx.service,
		componentLabel: undefined,
		withinDays: ctx.windowDays,
		incidentProjects: ctx.incidentProjects,
	});
	const result = (await proxy.callTool("searchJiraIssuesUsingJql", { jql, maxResults: 1000 })) as ProxyCallResult;
	const issues = extractIssues(result);
	return aggregate(issues, ctx.windowDays, ctx.groupBy, ctx.service);
}

export function registerGetIncidentHistory(
	server: McpServer,
	proxy: AtlassianMcpProxy,
	incidentProjects: string[],
): void {
	server.tool(
		"getIncidentHistory",
		"Return time-bucketed incident counts and MTTR for a service over a look-back window.",
		InputSchema.shape,
		async (args) => {
			return traceToolCall("getIncidentHistory", async () => {
				const parsed = InputSchema.parse(args);
				const output = await getIncidentHistory(proxy, {
					service: parsed.service,
					windowDays: parsed.windowDays,
					groupBy: parsed.groupBy,
					incidentProjects,
				});
				return { content: [{ type: "text" as const, text: JSON.stringify(output) }] };
			});
		},
	);
}
```

- [ ] **Step 4: Run test (expected pass)**

Run: `bun test packages/mcp-server-atlassian/test/get-incident-history.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server-atlassian/src/tools/custom/get-incident-history.ts packages/mcp-server-atlassian/test/get-incident-history.test.ts
git commit -m "SIO-650: Add getIncidentHistory custom tool with time-bucket aggregation"
```

---

## Task 10: Tools barrel + custom registration glue

**Files:**
- Create: `packages/mcp-server-atlassian/src/tools/custom/index.ts`
- Create: `packages/mcp-server-atlassian/src/tools/index.ts`

- [ ] **Step 1: Write `tools/custom/index.ts`**

Write:

```typescript
// src/tools/custom/index.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AtlassianMcpProxy } from "../../atlassian-client/index.js";
import { registerFindLinkedIncidents } from "./find-linked-incidents.js";
import { registerGetIncidentHistory } from "./get-incident-history.js";
import { registerGetRunbookForAlert } from "./get-runbook-for-alert.js";

export interface CustomToolsOptions {
	incidentProjects: string[];
	siteUrl?: string;
}

export function registerCustomTools(
	server: McpServer,
	proxy: AtlassianMcpProxy,
	opts: CustomToolsOptions,
): number {
	registerFindLinkedIncidents(server, proxy, opts.incidentProjects, opts.siteUrl);
	registerGetRunbookForAlert(server, proxy, opts.siteUrl);
	registerGetIncidentHistory(server, proxy, opts.incidentProjects);
	return 3;
}
```

- [ ] **Step 2: Write `tools/index.ts`**

Write:

```typescript
// src/tools/index.ts

export { registerCustomTools } from "./custom/index.js";
export { registerProxyTools } from "./proxy/index.js";
export { isWriteTool, WRITE_TOOL_PATTERNS } from "./proxy/write-tools.js";
```

- [ ] **Step 3: Typecheck**

Run: `bun run --filter '@devops-agent/mcp-server-atlassian' typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-server-atlassian/src/tools/custom/index.ts packages/mcp-server-atlassian/src/tools/index.ts
git commit -m "SIO-650: Add tools barrel and custom registration glue"
```

---

## Task 11: Server assembly (`server.ts`) and entrypoint (`index.ts`)

Wires config -> proxy -> cloudId -> tool discovery -> write filter -> custom tool registration into the `createMcpApplication` bootstrap.

**Files:**
- Create: `packages/mcp-server-atlassian/src/server.ts`
- Create: `packages/mcp-server-atlassian/src/index.ts`

- [ ] **Step 1: Write `server.ts`**

Write:

```typescript
// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AtlassianMcpProxy, ProxyToolInfo } from "./atlassian-client/index.js";
import type { Config } from "./config/index.js";
import { registerCustomTools } from "./tools/custom/index.js";
import { registerProxyTools } from "./tools/proxy/index.js";
import { createContextLogger } from "./utils/logger.js";

const log = createContextLogger("server");

export interface AtlassianDatasource {
	proxy: AtlassianMcpProxy;
	config: Config;
	discoveredTools: ProxyToolInfo[];
	siteUrl?: string;
}

export async function discoverRemoteTools(proxy: AtlassianMcpProxy): Promise<ProxyToolInfo[]> {
	try {
		const tools = await proxy.listTools();
		log.info({ toolCount: tools.length, names: tools.map((t) => t.name) }, "Discovered remote Atlassian MCP tools");
		return tools;
	} catch (error) {
		log.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"Failed to discover proxy tools -- proxy tools will be unavailable",
		);
		return [];
	}
}

export function createAtlassianServer(ds: AtlassianDatasource): McpServer {
	const { config, proxy, discoveredTools, siteUrl } = ds;
	const server = new McpServer({
		name: config.application.name,
		version: config.application.version,
	});

	const { registered, filtered } = registerProxyTools(server, proxy, discoveredTools, {
		readOnly: config.atlassian.readOnly,
	});
	const customCount = registerCustomTools(server, proxy, {
		incidentProjects: config.atlassian.incidentProjects,
		siteUrl,
	});

	log.info(
		{ proxyRegistered: registered, proxyFiltered: filtered, customCount, total: registered + customCount },
		"Atlassian MCP server created",
	);
	return server;
}
```

- [ ] **Step 2: Write `index.ts`**

Write:

```typescript
// src/index.ts
import { buildTelemetryConfig, createBootstrapAdapter, createMcpApplication } from "@devops-agent/shared";
import { AtlassianMcpProxy } from "./atlassian-client/index.js";
import { loadConfiguration } from "./config/index.js";
import { type AtlassianDatasource, createAtlassianServer, discoverRemoteTools } from "./server.js";
import { createTransport } from "./transport/index.js";
import { getRuntimeInfo } from "./utils/env.js";
import { createContextLogger, logger } from "./utils/logger.js";
import { initializeTracing } from "./utils/tracing.js";

const serverLog = createContextLogger("server");

if (import.meta.main) {
	createMcpApplication<AtlassianDatasource>({
		name: "atlassian-mcp-server",
		logger: createBootstrapAdapter(logger),

		initTracing: () => initializeTracing(),
		telemetry: buildTelemetryConfig("atlassian-mcp-server"),

		initDatasource: async () => {
			const config = await loadConfiguration();
			logger.level = config.application.logLevel;

			const runtimeInfo = getRuntimeInfo();
			serverLog.info(
				{ runtime: runtimeInfo.runtime, version: runtimeInfo.version, envSource: runtimeInfo.envSource },
				"Starting Atlassian MCP Server",
			);

			const proxy = new AtlassianMcpProxy({
				mcpEndpoint: config.atlassian.mcpEndpoint,
				callbackPort: config.atlassian.oauthCallbackPort,
				siteName: config.atlassian.siteName,
				timeout: config.atlassian.timeout,
			});

			await proxy.connect();
			const cloudId = await proxy.resolveCloudId();
			const discoveredTools = await discoverRemoteTools(proxy);

			// Best-effort site URL: from Rovo resources the URL field isn't in our parser;
			// leave undefined and let links be relative. Can be added later if needed.
			return { proxy, config, discoveredTools, siteUrl: undefined };
		},

		createServerFactory: (ds) => () => createAtlassianServer(ds),

		createTransport: (serverFactory, ds) => createTransport(ds.config.transport, serverFactory),

		cleanupDatasource: async (ds) => {
			await ds.proxy.disconnect();
		},

		onStarted: (ds) => {
			const proxyCount = ds.discoveredTools.length;
			serverLog.info(
				{
					endpoint: ds.config.atlassian.mcpEndpoint,
					cloudId: ds.proxy.getCloudId(),
					site: ds.config.atlassian.siteName,
					proxyTools: proxyCount,
					customTools: 3,
					readOnly: ds.config.atlassian.readOnly,
					transport: ds.config.transport.mode,
					port: ds.config.transport.mode !== "stdio" ? ds.config.transport.port : undefined,
				},
				`Atlassian MCP ready: cloudId=${ds.proxy.getCloudId()}, site=${ds.config.atlassian.siteName ?? "(default)"}, tools=${proxyCount}+3, readOnly=${ds.config.atlassian.readOnly}`,
			);
		},
	});
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run --filter '@devops-agent/mcp-server-atlassian' typecheck`
Expected: PASS.

- [ ] **Step 4: Run full test suite for the package**

Run: `bun run --filter '@devops-agent/mcp-server-atlassian' test`
Expected: All tests from tasks 3–9 PASS (4+17+5+6+5+5 = 42 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server-atlassian/src/server.ts packages/mcp-server-atlassian/src/index.ts
git commit -m "SIO-650: Assemble Atlassian MCP server and entrypoint"
```

---

## Task 12: Sub-agent definition (`atlassian-agent/`)

**Files:**
- Create: `agents/incident-analyzer/agents/atlassian-agent/agent.yaml`
- Create: `agents/incident-analyzer/agents/atlassian-agent/SOUL.md`

- [ ] **Step 1: Write `agent.yaml`**

Write:

```yaml
spec_version: "0.1.0"
name: atlassian-agent
version: 0.1.0
description: Read-only Jira and Confluence specialist for incident context, runbook lookup, and historical correlation.

model:
  preferred: claude-haiku-4-5
  constraints:
    temperature: 0.1
    max_tokens: 2048

tools:
  - atlassian-api

compliance:
  risk_tier: low
  data_governance:
    pii_handling: redact
```

- [ ] **Step 2: Write `SOUL.md`**

Write:

```markdown
# Soul

## Core Identity
I am an Atlassian specialist sub-agent. I query Jira and Confluence via
Rovo MCP tools to surface linked incident tickets, runbook pages, and
historical incident trends for the orchestrator's cross-datasource
correlation. I am read-only: I never create, update, or delete tickets
or pages.

## Expertise
- Jira incident ticket correlation by service label or free-text match
- Confluence runbook lookup with client-side relevance scoring
- Historical incident frequency and MTTR aggregation over rolling windows
- JQL and CQL composition for incident-scoped queries

## Approach
I execute focused queries scoped to the incident projects configured
for the environment. I return structured findings (ticket keys, page
IDs, counts, MTTR) but never propose mitigations or cross-correlate
across sources -- that is the orchestrator's job.

Triage priority:
1. Linked incidents in the last 30 days matching the service
2. Runbook pages ranked by title match, keywords, and freshness
3. Incident history trends (count + MTTR) for the service

## Custom Tools
- findLinkedIncidents: JQL-composed recent incident search with MTTR
- getRunbookForAlert: CQL search + client-side ranking heuristic
- getIncidentHistory: time-bucketed incident count and MTTR stats

## Output Standards
- Every claim must reference a Jira key or Confluence page ID
- ISO 8601 timestamps for all dates
- Report MTTR in minutes; null when issues are unresolved
- Read-only analysis only; never suggest ticket creation or page edits

## Connectivity Failures
When Atlassian calls return ATLASSIAN_AUTH_REQUIRED or repeated 5xx,
state the conclusion directly: "Atlassian unavailable; skipping this
source." The orchestrator folds this into aggregation as a missing
branch.

## Healthy State Reporting
When no linked incidents exist and no runbooks match, report a concise
"no Atlassian signal" finding rather than returning empty arrays without
context.
```

- [ ] **Step 3: Validate agent YAML**

Run: `bun run yaml:check`
Expected: PASS (new agent.yaml validates against the gitagent schema).

- [ ] **Step 4: Commit**

```bash
git add agents/incident-analyzer/agents/atlassian-agent
git commit -m "SIO-650: Add atlassian-agent sub-agent definition"
```

---

## Task 13: Tool YAML with action_tool_map

**Files:**
- Create: `agents/incident-analyzer/tools/atlassian-api.yaml`

- [ ] **Step 1: Write `atlassian-api.yaml`**

Write to `agents/incident-analyzer/tools/atlassian-api.yaml`:

```yaml
name: atlassian-api
description: >
  Query Jira and Confluence via Atlassian Rovo MCP for linked incident
  tickets, runbook pages, and historical incident trends. Read-only.
version: 1.0.0
input_schema:
  type: object
  properties:
    action:
      type: string
      enum: [incident_correlation, runbook_lookup, jira_query, confluence_query]
      description: Type of Atlassian operation to perform
    service:
      type: string
      description: Service name for incident or runbook search
    time_from:
      type: string
      format: date-time
      description: Start of time window (ISO 8601)
    time_to:
      type: string
      format: date-time
      description: End of time window (ISO 8601)
    query:
      type: string
      description: JQL, CQL, or free-text query
  required: [action]
output_schema:
  type: object
  properties:
    results:
      type: array
      items:
        type: object
    total_count: { type: integer }
annotations:
  requires_confirmation: false
  read_only: true
  cost: low

prompt_template: >
  Query Atlassian for Jira incidents and Confluence runbooks.
  {{#if datasources}}Available data sources: {{datasources}}.{{/if}}
  {{#if compliance_tier}}Compliance tier: {{compliance_tier}} -- read-only queries only.{{/if}}

related_tools:
  - "Use elastic-logs to correlate Jira incident time windows with log spikes"
  - "Use gitlab-api to cross-reference deploy timing with incident creation"
  - "Use konnect-gateway to check whether API gateway errors align with ticket timeline"

tool_mapping:
  mcp_server: atlassian
  mcp_patterns:
    - "atlassian_*"
    - "findLinkedIncidents"
    - "getRunbookForAlert"
    - "getIncidentHistory"
  action_tool_map:
    incident_correlation:
      - findLinkedIncidents
      - getIncidentHistory
    runbook_lookup:
      - getRunbookForAlert
      - atlassian_searchConfluencePages
    jira_query:
      - atlassian_searchJiraIssuesUsingJql
      - atlassian_getJiraIssue
      - atlassian_getJiraIssueComments
    confluence_query:
      - atlassian_searchConfluencePages
      - atlassian_getConfluencePage
```

- [ ] **Step 2: Validate**

Run: `bun run yaml:check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add agents/incident-analyzer/tools/atlassian-api.yaml
git commit -m "SIO-650: Add atlassian-api tool YAML with action_tool_map"
```

---

## Task 14: Pipeline wiring — mcp-bridge

Add Atlassian to the MCP client server list and agent-name map.

**Files:**
- Modify: `packages/agent/src/mcp-bridge.ts`

- [ ] **Step 1: Read current mcp-bridge.ts context**

Run: `grep -n "gitlab\|serverEntries\|serverMap" packages/agent/src/mcp-bridge.ts`
Expected output (for reference): shows lines 28, 76, 77, 150 as insertion sites from the plan's context gathering.

- [ ] **Step 2: Add `atlassianUrl` to the config type**

Edit `packages/agent/src/mcp-bridge.ts`. Find the line containing `gitlabUrl?: string;` (near line 28). Add immediately after:

```typescript
	atlassianUrl?: string;
```

- [ ] **Step 3: Add server entry for atlassian**

Edit `packages/agent/src/mcp-bridge.ts`. Find the block containing:

```typescript
	if (config.gitlabUrl) {
		serverEntries.push({ name: "gitlab-mcp", url: `${config.gitlabUrl}/mcp` });
	}
```

Add immediately after it:

```typescript
	if (config.atlassianUrl) {
		serverEntries.push({ name: "atlassian-mcp", url: `${config.atlassianUrl}/mcp` });
	}
```

- [ ] **Step 4: Add atlassian to the serverMap**

Edit `packages/agent/src/mcp-bridge.ts`. Find the line `gitlab: "gitlab-mcp",` (near line 150). Add immediately after:

```typescript
		atlassian: "atlassian-mcp",
```

- [ ] **Step 5: Typecheck**

Run: `bun run --filter '@devops-agent/agent' typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/mcp-bridge.ts
git commit -m "SIO-650: Wire atlassian-mcp into agent MCP bridge"
```

---

## Task 15: Pipeline wiring — supervisor

Add atlassian to `AGENT_NAMES` so it participates in the parallel fan-out.

**Files:**
- Modify: `packages/agent/src/supervisor.ts`

- [ ] **Step 1: Add atlassian to AGENT_NAMES**

Edit `packages/agent/src/supervisor.ts`. Find the line `gitlab: "gitlab-agent",` (near line 17). Add immediately after:

```typescript
	atlassian: "atlassian-agent",
```

- [ ] **Step 2: Typecheck**

Run: `bun run --filter '@devops-agent/agent' typecheck`
Expected: PASS. If type errors surface in `align.ts` / `aggregate.ts` related to an exhaustive `AgentName` union that now includes `"atlassian"`, those files handle it in Task 17 — apply a minimal fix now if needed, otherwise commit and continue.

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/supervisor.ts
git commit -m "SIO-650: Add atlassian to supervisor AGENT_NAMES"
```

---

## Task 16: Pipeline wiring — entity extractor

Extend the LLM routing prompt with Atlassian keywords.

**Files:**
- Modify: `packages/agent/src/entity-extractor.ts`

- [ ] **Step 1: Update the routing prompt**

Edit `packages/agent/src/entity-extractor.ts`. Find the line (near line 88):

```
Map mentions like "logs" or "elasticsearch" to "elastic", "kafka" or "events" to "kafka", "couchbase" or "database" to "couchbase", "kong" or "api gateway" to "konnect", "gitlab" or "pipeline" or "merge request" or "CI/CD" or "commit" or "deploy" or "code change" to "gitlab".
```

Replace the period at the end with `, "jira" or "confluence" or "ticket" or "runbook" or "incident page" or "wiki" to "atlassian".` The full updated line:

```
Map mentions like "logs" or "elasticsearch" to "elastic", "kafka" or "events" to "kafka", "couchbase" or "database" to "couchbase", "kong" or "api gateway" to "konnect", "gitlab" or "pipeline" or "merge request" or "CI/CD" or "commit" or "deploy" or "code change" to "gitlab", "jira" or "confluence" or "ticket" or "runbook" or "incident page" or "wiki" to "atlassian".
```

- [ ] **Step 2: Typecheck**

Run: `bun run --filter '@devops-agent/agent' typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/entity-extractor.ts
git commit -m "SIO-650: Add atlassian keyword routing in entity extractor"
```

---

## Task 17: Pipeline wiring — align / aggregate types

Extend per-source result types to include Atlassian findings. The exact edit depends on what union `align.ts` and `aggregate.ts` use; the goal is to add `"atlassian"` as a valid source key wherever other sources are enumerated.

**Files:**
- Modify: `packages/agent/src/align.ts`
- Modify: `packages/agent/src/aggregate.ts`

- [ ] **Step 1: Find current source unions**

Run: `grep -n "\"gitlab\"\|'gitlab'\|SourceKey\|SourceName" packages/agent/src/align.ts packages/agent/src/aggregate.ts`
Expected: lines listing string literal unions of source keys.

- [ ] **Step 2: Add "atlassian" alongside "gitlab" in each union**

For every union found in Step 1 that lists `"gitlab"`, add `"atlassian"` next to it. Example transformation:

Before:
```typescript
type SourceKey = "elastic" | "kafka" | "couchbase" | "konnect" | "gitlab";
```

After:
```typescript
type SourceKey = "elastic" | "kafka" | "couchbase" | "konnect" | "gitlab" | "atlassian";
```

If an exhaustive `switch` exists over source keys, add an `atlassian` case whose body mirrors `gitlab` (pass-through of the findings payload).

- [ ] **Step 3: Typecheck**

Run: `bun run --filter '@devops-agent/agent' typecheck`
Expected: PASS.

- [ ] **Step 4: Run agent tests**

Run: `bun run --filter '@devops-agent/agent' test`
Expected: PASS (existing tests should still pass; no new atlassian-specific agent tests in this plan).

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/align.ts packages/agent/src/aggregate.ts
git commit -m "SIO-650: Extend align/aggregate source unions with atlassian"
```

---

## Task 18: Frontend toggle

Add Atlassian as a selectable source in `DataSourceSelector.svelte`.

**Files:**
- Modify: `apps/web/src/lib/components/DataSourceSelector.svelte`

- [ ] **Step 1: Add the label**

Edit `apps/web/src/lib/components/DataSourceSelector.svelte`. Find the `labels` record (lines 12-18):

```svelte
const labels: Record<string, string> = {
	elastic: "Elastic",
	kafka: "Kafka",
	couchbase: "Capella",
	konnect: "Konnect",
	gitlab: "GitLab",
};
```

Add `atlassian: "Atlassian",` before the closing brace:

```svelte
const labels: Record<string, string> = {
	elastic: "Elastic",
	kafka: "Kafka",
	couchbase: "Capella",
	konnect: "Konnect",
	gitlab: "GitLab",
	atlassian: "Atlassian",
};
```

- [ ] **Step 2: Typecheck frontend**

Run: `bun run --filter '@devops-agent/web' typecheck`
Expected: PASS. (If the `dataSources` prop is populated by the server from a source list that now needs an entry, check `apps/web/src/routes/+page.server.ts` or similar for a hardcoded source list and add `"atlassian"` — this is codebase-dependent; if no such file exists, the prop flows from upstream config and needs no change.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/components/DataSourceSelector.svelte
git commit -m "SIO-650: Add Atlassian toggle to DataSourceSelector"
```

---

## Task 19: Env example and README

**Files:**
- Modify: `.env.example`
- Create: `packages/mcp-server-atlassian/README.md`

- [ ] **Step 1: Append env vars to `.env.example`**

Edit `.env.example`. Append at the end of the file:

```
# Atlassian MCP Server
ATLASSIAN_MCP_URL=https://mcp.atlassian.com/v1/mcp
ATLASSIAN_SITE_NAME=
ATLASSIAN_READ_ONLY=true
ATLASSIAN_INCIDENT_PROJECTS=INC,OPS
ATLASSIAN_OAUTH_CALLBACK_PORT=9185
ATLASSIAN_TIMEOUT=30000
ATLASSIAN_MCP_PORT=9085
```

- [ ] **Step 2: Write `README.md`**

Write to `packages/mcp-server-atlassian/README.md`:

```markdown
# @devops-agent/mcp-server-atlassian

Proxy-plus-correlation MCP server for Atlassian Jira and Confluence. Wraps the Atlassian Rovo MCP endpoint (OAuth 2.1) and adds three read-only incident-correlation tools.

## Running

```bash
bun run --filter '@devops-agent/mcp-server-atlassian' dev
```

Default transport: stdio. Set `MCP_TRANSPORT=http` and `MCP_PORT=9085` for HTTP mode.

## Environment

| Var | Default | Description |
|---|---|---|
| `ATLASSIAN_MCP_URL` | `https://mcp.atlassian.com/v1/mcp` | Rovo endpoint |
| `ATLASSIAN_SITE_NAME` | (unset) | Match a site name to select cloudId; first accessible used if unset |
| `ATLASSIAN_READ_ONLY` | `true` | Filter write tools at registration |
| `ATLASSIAN_INCIDENT_PROJECTS` | (unset, warned) | Comma-separated Jira project keys for custom tools |
| `ATLASSIAN_OAUTH_CALLBACK_PORT` | `9185` | Local OAuth redirect port |
| `ATLASSIAN_TIMEOUT` | `30000` | Tool call timeout (ms) |
| `ATLASSIAN_MCP_PORT` | `9085` | HTTP transport port |

## OAuth Flow

First run: browser opens for consent. Tokens persist at `~/.mcp-auth/atlassian/<sanitized-endpoint>.json`. Dynamic client registration means no manual OAuth app setup.

## Tools

Proxied read-only Rovo tools plus three custom correlation tools:

- `findLinkedIncidents` — JQL-composed recent incident search with MTTR
- `getRunbookForAlert` — CQL search with client-side relevance ranking
- `getIncidentHistory` — time-bucketed incident count and MTTR

## Testing

```bash
bun run --filter '@devops-agent/mcp-server-atlassian' test
bun run --filter '@devops-agent/mcp-server-atlassian' typecheck
```

## Smoke Test

```bash
bun --env-file=../../.env src/index.ts
```

Watch for the `Atlassian MCP ready` startup log with resolved cloudId.
```

- [ ] **Step 3: Commit**

```bash
git add .env.example packages/mcp-server-atlassian/README.md
git commit -m "SIO-650: Document Atlassian MCP env vars and usage"
```

---

## Task 20: Final verification

- [ ] **Step 1: Workspace-wide typecheck**

Run: `bun run typecheck`
Expected: PASS across all packages.

- [ ] **Step 2: Workspace-wide lint**

Run: `bun run lint`
Expected: PASS. If Biome flags formatting, run `bun run lint:fix`, review the diff, commit only formatting fixes separately:

```bash
git add -u
git commit -m "SIO-650: Apply Biome formatting fixes"
```

- [ ] **Step 3: Workspace-wide test**

Run: `bun run test`
Expected: PASS. All new Atlassian unit tests (42 total from tasks 3-9) plus existing tests in other packages.

- [ ] **Step 4: YAML validation**

Run: `bun run yaml:check`
Expected: PASS.

- [ ] **Step 5: Manual smoke test (optional, requires credentials)**

Run: `bun run --filter '@devops-agent/mcp-server-atlassian' dev`
Expected: Browser opens for OAuth consent. After approving, terminal shows `Atlassian MCP ready: cloudId=<id>, ...`. If `ATLASSIAN_INCIDENT_PROJECTS` is unset, a warning line appears.

- [ ] **Step 6: Update Linear issue status**

Ask the user whether to move SIO-650 to "In Review" or leave it in progress. Do not mark Done without explicit approval (per project CLAUDE.md).

---

## Deferred from Spec

The spec calls for an `test/integration/server.integration.test.ts` against a `Bun.serve()`-mocked Rovo endpoint. The unit tests in Tasks 3, 4, 5, 7, 8, 9 cover the same logic (proxy, filter, custom tools) at a finer grain without the mock-server overhead. If the engineer finds the unit coverage insufficient after implementation — particularly around the real `StreamableHTTPClientTransport` + OAuth handshake flow that unit tests skip — add the integration test as a follow-up task. Defer by default; add only if needed.
