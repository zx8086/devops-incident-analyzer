// shared/src/bootstrap-lifecycle.ts
//
// SIO-1423: SDK-agnostic pieces of createMcpApplication (bootstrap.ts), split out so the F2 v2
// pilot (createMcpApplicationV2) can reuse them without importing anything v1-McpServer-typed.
// NOT exported from index.ts -- internal to the shared package; F2 imports by path. Everything
// here is pure code motion from bootstrap.ts: zero behavior deltas, including handler
// registration order and the SIO-986 embedded-mode contract (see installProcessLifecycle).
import { OAuthRequiresInteractiveAuthError } from "./oauth/errors.ts";
import { seedCommandFor } from "./oauth/seed-command.ts";
import { initTelemetry, shutdownTelemetry, type TelemetryConfig } from "./telemetry/telemetry.ts";
import {
	createToolCallMetricsRecorder,
	resolveToolCallMetricsDbPath,
	type ToolCallMetricsRecorder,
} from "./tool-call-metrics.ts";
import { buildIdentityCard, type IdentityCard, type McpRole } from "./transport/identity.ts";

export type { TelemetryConfig };

export interface BootstrapLogger {
	info(message: string, meta?: Record<string, unknown>): void;
	error(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
	flush?(): void;
}

// SIO-869: an SSE client that disconnects mid-stream (e.g. the agent pausing at a
// plan-review gate) cancels the response stream reader, surfacing a benign AbortError.
// It must not escalate to process.exit() and take the whole MCP server down.
export function isBenignStreamCancel(reason: unknown): boolean {
	return (
		reason instanceof Error &&
		reason.name === "AbortError" &&
		/releaseLock|stream reader (?:was )?cancelled/i.test(reason.message)
	);
}

// SIO-986: embedded (in-process) mode. A standalone MCP process IS its server, so a fatal start
// error or a stray signal/exception should process.exit(). But the knowledge-graph server is
// mounted IN-PROCESS in the web app -- there, process.exit() / process-global SIGINT|SIGTERM|
// uncaughtException|unhandledRejection handlers would take the WHOLE app down. When embedded:
//   - a startup failure RETHROWS (the host's try/catch handles it) instead of process.exit(1);
//   - the process-global signal/exception handlers are NOT installed (the host app owns those).
// Default (false) preserves the standalone behaviour for every other server unchanged.
export interface ProcessLifecycleOptions {
	name: string;
	logger: BootstrapLogger;
	embedded?: boolean;
}

// Process-level error handlers install BEFORE any startup await -- a background rejection
// during initDatasource/createTransport would otherwise hit the runtime default (crash) in the
// window before registration. SIO-986: skip in embedded mode; these are process-GLOBAL and the
// host app owns them there. Call at function entry, before any await.
export function installProcessErrorHandlers(options: ProcessLifecycleOptions): void {
	if (options.embedded) return;
	const { name, logger } = options;

	process.on("uncaughtException", (error) => {
		// Runtime can pass non-Error values (throw "string", throw null); accessing
		// .message on those would throw inside the crash handler itself.
		const err = error instanceof Error ? error : new Error(String(error));
		logger.error(`Uncaught exception in ${name}`, {
			error: err.message,
			stack: err.stack,
			name: err.name,
		});
		if (logger.flush) logger.flush();
		process.exit(1);
	});

	// Log-and-continue: a stray background rejection (e.g. an SDK promise resolving
	// after its caller moved on) must not take down a long-running MCP server and
	// every tool it serves. uncaughtException above still exits -- a thrown
	// exception mid-stack means corrupted state; an orphaned rejection does not.
	process.on("unhandledRejection", (reason) => {
		if (isBenignStreamCancel(reason)) {
			logger.warn(`Ignoring benign stream-cancel in ${name}`, {
				reason: reason instanceof Error ? reason.message : String(reason),
			});
			return;
		}
		logger.error(`Unhandled rejection in ${name} (continuing)`, {
			reason: reason instanceof Error ? reason.message : String(reason),
			name: reason instanceof Error ? reason.name : undefined,
			stack: reason instanceof Error ? reason.stack : undefined,
		});
		if (logger.flush) logger.flush();
	});
}

// SIO-986: process-GLOBAL signal handlers -- an in-process (embedded) server would hijack the
// host app's SIGINT/SIGTERM, so the host owns those there. Registered separately from the error
// handlers above because `shutdown` does not exist until later in createMcpApplication's flow.
export function installShutdownSignalHandlers(options: { embedded?: boolean; shutdown: () => void }): void {
	if (options.embedded) return;
	process.on("SIGINT", () => options.shutdown());
	process.on("SIGTERM", () => options.shutdown());
}

// SIO-1400: opt-in SQLite usage counters (MCP_TOOL_METRICS_DB_PATH unset = off). Created ONCE
// per process and shared by every server instance -- the caller's server factory can run
// per-connection (cached-server-factory), so the recorder must not live inside it. Proxy mode
// counts in the agentcore proxy itself, so `mode: "proxy"` never opens a recorder here.
export async function openMetricsRecorder(options: {
	mode: "server" | "proxy";
	name: string;
	logger: BootstrapLogger;
}): Promise<ToolCallMetricsRecorder | undefined> {
	const dbPath = options.mode === "proxy" ? undefined : resolveToolCallMetricsDbPath();
	return dbPath
		? await createToolCallMetricsRecorder({ serverName: options.name, dbPath, logger: options.logger })
		: undefined;
}

// Re-hosts buildIdentityCard's call so bootstrap-v2 (F2) constructs its IdentityCard through the
// same lifecycle seam as v1, without importing bootstrap.ts (which pulls in the v1 McpServer type).
// Telemetry init/shutdown ordering: init before server start, shutdown after transport close --
// thin re-export so callers only need one import path for the lifecycle seam; no logic added.
// OAuthRequiresInteractiveAuthError: an un-authorized OAuth server (no valid seeded tokens under
// headless / non-interactive stdout) surfaces this typed error. The deep SDK auth stack (auth.js
// -> streamableHttp.js) is noise -- the fix is a one-time interactive seed -- so render one
// actionable line instead of a raw stack (see handleStartupFailure below).
export {
	buildIdentityCard,
	type IdentityCard,
	initTelemetry,
	type McpRole,
	OAuthRequiresInteractiveAuthError,
	shutdownTelemetry,
};

// SIO-986: embedded servers must NOT take the host app down on a fatal start error; standalone
// servers exit. SIO-987: embedded mode does NOT log a level:50 "Fatal" line -- a start failure
// there is expected/recoverable (the host logs its own actionable WARN), so a scary Fatal would
// be misleading noise. Centralizes the OAuth-vs-generic-vs-embedded branching from
// createMcpApplication's catch block so bootstrap-v2 gets identical failure semantics.
export function handleStartupFailure(options: {
	error: unknown;
	name: string;
	logger: BootstrapLogger;
	embedded?: boolean;
}): never {
	const { error, name, logger, embedded } = options;
	if (error instanceof OAuthRequiresInteractiveAuthError) {
		logger.error(
			`Cannot start ${name}: ${error.namespace} OAuth is not authorized (no valid seeded tokens under ` +
				`MCP_OAUTH_HEADLESS / non-interactive stdout). Run \`${seedCommandFor(error.namespace)}\` once ` +
				"interactively to seed tokens (add `-- --force` to re-seed expired tokens), then restart.",
			{ namespace: error.namespace },
		);
		if (logger.flush) logger.flush();
		process.exit(1);
	}
	// SIO-986: embedded servers must NOT take the host app down. Rethrow so the host's try/catch
	// (.catch) handles it gracefully; only a standalone process exits.
	// SIO-987: and do NOT log a level:50 "Fatal" line in embedded mode -- a start failure there is
	// expected/recoverable (the host logs its own actionable WARN), so a scary Fatal is misleading
	// noise. A standalone process logs Fatal + exits, unchanged.
	if (embedded) {
		if (logger.flush) logger.flush();
		throw error;
	}
	logger.error(`Fatal error starting ${name}`, {
		error: error instanceof Error ? error.message : String(error),
		stack: error instanceof Error ? error.stack : undefined,
	});
	if (logger.flush) logger.flush();
	process.exit(1);
}
