// shared/src/cached-server-factory.ts
// SIO-1041: record-once / replay-many server factory. On stateless HTTP transport every request
// builds a FRESH McpServer + transport (safe: WebStandardStreamableHTTPServerTransport.handleRequest
// returns the SSE Response immediately while tool results arrive later via transport.send(), and
// protocol.js keeps a single _transport slot -- so a pooled/shared server risks cross-request
// response leakage). This factory keeps the per-request freshness but eliminates the real waste:
// re-running registerAll (which rebuilds ~93 wrapped Zod schemas + closures) on every request.
//
// At boot we instance-patch all SIX registration methods on ONE throwaway template server, run
// registerAll ONCE, and record the final (already deployment-augmented / traced / security-wrapped)
// argument tuples. Servers whose registerAll installs its OWN monkey-patch on top (elastic's
// tools/index.ts) bind our recorder as the delegate, so the recorded tuples are the FINAL wrapped
// versions -- zero changes to tool files. Each request then just replays the recorded tuples (cheap
// map inserts) onto a fresh bare server.
//
// SIO-1044/SIO-1050: the SDK's legacy sugar methods (tool/resource/prompt) do NOT delegate to
// registerTool/registerResource/registerPrompt -- in SDK 1.29.0 each pair (e.g. tool()/registerTool())
// independently calls a private _createRegistered* method. The 8 servers adopting this factory use
// the legacy API almost exclusively, so patching only the register* trio silently drops those
// registrations (they exist only on the discarded boot template). All six methods are recorded here.
// They are captured into ONE ordered log rather than per-method sinks so a package that mixes both
// APIs (tool() and registerTool() calls interleaved) replays in ORIGINAL registration order --
// per-method sinks would replay all tool() calls before/after all registerTool() calls, silently
// reordering tools/list for any mixed-API package.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface CachedServerFactoryOptions {
	createBareServer: () => McpServer;
	// Run ONCE at factory creation (boot). Must be synchronous to match the createServerFactory
	// contract in bootstrap.ts (createServerFactory returns a sync () => McpServer).
	registerAll: (server: McpServer) => void;
}

// registerTool/registerResource/registerPrompt (and their legacy tool/resource/prompt counterparts)
// are overloaded in the SDK, so Parameters<> collapses to `never`. Capture the args as an opaque
// tuple and replay them verbatim against the same method on a fresh server -- the recorded values
// are exactly what registerAll passed, so replay is sound.
type VariadicRegistrar = (...args: unknown[]) => unknown;

const RECORDED_METHODS = ["registerTool", "registerResource", "registerPrompt", "tool", "resource", "prompt"] as const;

type RecordedMethod = (typeof RECORDED_METHODS)[number];

type RecordedCall = {
	method: RecordedMethod;
	args: unknown[];
};

// Recording the shared config/handler references across instances is safe: Zod schemas are
// stateless validators, deployment routing is per-request AsyncLocalStorage, the ES client is a
// singleton proxy, and RegisteredTool.update() is never called here.
export function createCachedServerFactory(opts: CachedServerFactoryOptions): () => McpServer {
	const template = opts.createBareServer();

	const recorded: RecordedCall[] = [];

	// Capture `bound` BEFORE assigning the patch: this is load-bearing when registerAll installs its
	// own wrapper on top (e.g. couchbase's toolRegistry.ts patches server.tool after registerAll
	// starts) -- the consumer's wrapper binds our recorder as its delegate, so the recorded tuple is
	// the FINAL wrapped version, and the recorder itself always calls the ORIGINAL SDK method.
	for (const method of RECORDED_METHODS) {
		const bound = (template[method] as VariadicRegistrar).bind(template);
		(template as unknown as Record<RecordedMethod, VariadicRegistrar>)[method] = (...args: unknown[]) => {
			recorded.push({ method, args });
			return bound(...args);
		};
	}

	// Eager recording at boot: request 1 is already fast and any misconfiguration fails at boot,
	// not on the first live request. The template is discarded; only the recorded tuples survive.
	opts.registerAll(template);

	return () => {
		const server = opts.createBareServer();
		for (const { method, args } of recorded) {
			(server[method] as VariadicRegistrar).bind(server)(...args);
		}
		return server;
	};
}
