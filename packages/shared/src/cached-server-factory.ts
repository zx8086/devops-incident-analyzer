// shared/src/cached-server-factory.ts
// SIO-1041: record-once / replay-many server factory. On stateless HTTP transport every request
// builds a FRESH McpServer + transport (safe: WebStandardStreamableHTTPServerTransport.handleRequest
// returns the SSE Response immediately while tool results arrive later via transport.send(), and
// protocol.js keeps a single _transport slot -- so a pooled/shared server risks cross-request
// response leakage). This factory keeps the per-request freshness but eliminates the real waste:
// re-running registerAll (which rebuilds ~93 wrapped Zod schemas + closures) on every request.
//
// At boot we instance-patch registerTool/registerResource/registerPrompt on ONE throwaway template
// server, run registerAll ONCE, and record the final (already deployment-augmented / traced /
// security-wrapped) argument tuples. Servers whose registerAll installs its OWN monkey-patch on top
// (elastic's tools/index.ts) bind our recorder as the delegate, so the recorded tuples are the FINAL
// wrapped versions -- zero changes to tool files. Each request then just replays the recorded tuples
// (cheap map inserts) onto a fresh bare server.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface CachedServerFactoryOptions {
	createBareServer: () => McpServer;
	// Run ONCE at factory creation (boot). Must be synchronous to match the createServerFactory
	// contract in bootstrap.ts (createServerFactory returns a sync () => McpServer).
	registerAll: (server: McpServer) => void;
}

// registerTool/registerResource/registerPrompt are overloaded in the SDK, so Parameters<> collapses
// to `never`. Capture the args as an opaque tuple and replay them verbatim against the same method
// on a fresh server -- the recorded values are exactly what registerAll passed, so replay is sound.
type VariadicRegistrar = (...args: unknown[]) => unknown;

// Recording the shared config/handler references across instances is safe: Zod schemas are
// stateless validators, deployment routing is per-request AsyncLocalStorage, the ES client is a
// singleton proxy, and RegisteredTool.update() is never called here.
export function createCachedServerFactory(opts: CachedServerFactoryOptions): () => McpServer {
	const template = opts.createBareServer();

	const recordedTools: unknown[][] = [];
	const recordedResources: unknown[][] = [];
	const recordedPrompts: unknown[][] = [];

	const installRecorder = (
		bound: VariadicRegistrar,
		assign: (patched: VariadicRegistrar) => void,
		sink: unknown[][],
	) => {
		assign((...args: unknown[]) => {
			sink.push(args);
			return bound(...args);
		});
	};

	installRecorder(
		(template.registerTool as VariadicRegistrar).bind(template),
		(patched) => {
			(template as unknown as { registerTool: VariadicRegistrar }).registerTool = patched;
		},
		recordedTools,
	);
	installRecorder(
		(template.registerResource as VariadicRegistrar).bind(template),
		(patched) => {
			(template as unknown as { registerResource: VariadicRegistrar }).registerResource = patched;
		},
		recordedResources,
	);
	installRecorder(
		(template.registerPrompt as VariadicRegistrar).bind(template),
		(patched) => {
			(template as unknown as { registerPrompt: VariadicRegistrar }).registerPrompt = patched;
		},
		recordedPrompts,
	);

	// Eager recording at boot: request 1 is already fast and any misconfiguration fails at boot,
	// not on the first live request. The template is discarded; only the recorded tuples survive.
	opts.registerAll(template);

	return () => {
		const server = opts.createBareServer();
		const registerTool = (server.registerTool as VariadicRegistrar).bind(server);
		const registerResource = (server.registerResource as VariadicRegistrar).bind(server);
		const registerPrompt = (server.registerPrompt as VariadicRegistrar).bind(server);
		for (const args of recordedTools) registerTool(...args);
		for (const args of recordedResources) registerResource(...args);
		for (const args of recordedPrompts) registerPrompt(...args);
		return server;
	};
}
