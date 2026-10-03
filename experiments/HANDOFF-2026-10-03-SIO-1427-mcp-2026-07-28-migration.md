# Handover: MCP spec 2026-07-28 / SDK v2 migration program (SIO-1427)

| | |
|---|---|
| Date | 2026-10-03 |
| Umbrella ticket | [SIO-1427](https://linear.app/siobytes/issue/SIO-1427) (Backlog) |
| Child tickets | SIO-1951 to SIO-1968 (18, all Backlog, unassigned; table in section 3) |
| Related | [SIO-1426](https://linear.app/siobytes/issue/SIO-1426) (konnect MRTR), [SIO-1439](https://linear.app/siobytes/issue/SIO-1439) (konnect offline by design), [SIO-1438](https://linear.app/siobytes/issue/SIO-1438) (per-tool wrap decision, now contradicted), [SIO-1409](https://linear.app/siobytes/issue/SIO-1409) / [SIO-1435](https://linear.app/siobytes/issue/SIO-1435) (readiness program, Done) |
| Study | `docs/superpowers/specs/2026-10-03-mcp-spec-2026-07-28-migration-feasibility.md`. On `main` since PR [#945](https://github.com/zx8086/devops-incident-analyzer/pull/945) merged (squash commit `8c0452d8`). |
| Repo state | `main` at `8c0452d8` with CI green; no code has been changed for this program yet |
| Suggested branches | One per ticket, off `origin/main`: `sio-1951-mcp-v2-bump`, `sio-1952-delete-stateful-mode`, `sio-1953-elastic-notification-context`, `sio-1954-shared-seam-sdk-agnostic` |

## 1. TL;DR

**Done.** A feasibility study for moving the ten MCP servers to the MCP `2026-07-28` spec revision and TypeScript SDK v2. Verdict: feasible, not urgent. SIO-1427 was updated (both of its blockers have cleared) and 18 child tickets were created. No code was changed and nothing was run or probed live.

**Next.** Four tickets are unblocked and can start in any order: SIO-1951 (bump the v2 packages and re-verify), SIO-1952 (delete the unused stateful session mode), SIO-1953 (elastic notification concurrency bug), SIO-1954 (make the shared bootstrap seam SDK-agnostic). Then SIO-1957 (test harness), then SIO-1958 (landing-zone-iac, the first server port). Sections 5 and 6 give the code for each.

**Gotchas.**

- The approach is to migrate each server IN PLACE. Do not grow the couchbase pilot (`index-v2.ts`, `bootstrap-v2.ts`) to parity and do not cut over to it. It gets deleted in SIO-1959.
- Everything about SDK v2 was verified by reading version 2.0.0, the only v2 version installed. The target is 2.3.x. SIO-1951 exists to re-verify before anything else moves.
- A v1 server factory cannot be handed to the v2 `createMcpHandler` (it checks `instanceof McpServer` against the v2 class). Porting a server's factory and swapping its `/mcp` handler is one atomic change per server.
- Keep the dispatch-level logging and read-only wrap. The per-tool wrap that SIO-1438 adopted loses validation-failure logging on v2.
- Keep Linear ids out of the PR title, branch name and commit subject of any docs-only PR, or the Linear integration moves the issue to In Progress and closes it on merge.

## 2. Context: how this came to be

SIO-1427 was created on 2026-08-06 as a deferred umbrella for the fleet migration, blocked on two things: SDK v2 leaving beta, and `@langchain/mcp-adapters` supporting it. The SIO-1409 readiness program had already landed the prerequisites (sugar registration methods removed, lifecycle extracted into `packages/shared/src/bootstrap-lifecycle.ts`) and a couchbase pilot: SIO-1424 (#626) built `index-v2.ts` on port 9182, SIO-1436 (#629) fixed its `server/discover` routing, SIO-1443 (#634) ported the full tool surface.

On 2026-10-03 the user asked for a compatibility and feasibility study, prompted by a note that listed what a "v1 to v2 cutover" of couchbase would need (transport parity, readiness probe, connect backoff, port flip). The study found both blockers cleared (SDK v2 stable on 2026-07-27, current 2.3.0; adapter 2.0.0 published 2026-10-01) and that the cutover framing is unnecessary: SDK v2's `createMcpHandler` serves 2025-era and 2026-07-28 clients from one endpoint, and all ten servers already default to stateless HTTP. Every gap in that note exists only because the pilot built a second bootstrap.

Earlier handovers for the pilot: `experiments/HANDOFF-2026-08-07-SIO-1424.md`, `experiments/HANDOFF-2026-08-07-SIO-1435-followon-status.md`, `experiments/HANDOFF-2026-08-07-SIO-1409-followon.md`. Pilot design: `docs/superpowers/specs/2026-08-07-couchbase-v2-full-coverage-design.md`.

## 3. The tickets

| Ticket | What | Blocked by |
|---|---|---|
| [SIO-1951](https://linear.app/siobytes/issue/SIO-1951) | Bump couchbase's v2 packages to 2.3.x, re-verify the pilot's assumptions | none |
| [SIO-1952](https://linear.app/siobytes/issue/SIO-1952) | Delete the unused stateful session mode from six http transports | none |
| [SIO-1953](https://linear.app/siobytes/issue/SIO-1953) | Elastic: remove the process-global notification request context | none |
| [SIO-1954](https://linear.app/siobytes/issue/SIO-1954) | Shared bootstrap seam SDK-agnostic; keep the dispatch-level wrap | none |
| [SIO-1957](https://linear.app/siobytes/issue/SIO-1957) | SDK-neutral test harness replacing `InMemoryTransport` | 1954 |
| [SIO-1958](https://linear.app/siobytes/issue/SIO-1958) | landing-zone-iac in place (first port, sets the recipe) | 1951, 1954, 1957 |
| [SIO-1959](https://linear.app/siobytes/issue/SIO-1959) | couchbase in place; delete the pilot tree and `bootstrap-v2.ts` | 1958, 1952 |
| [SIO-1960](https://linear.app/siobytes/issue/SIO-1960) | elastic-iac | 1958 |
| [SIO-1961](https://linear.app/siobytes/issue/SIO-1961) | knowledge-graph | 1958 |
| [SIO-1962](https://linear.app/siobytes/issue/SIO-1962) | aws | 1958 |
| [SIO-1963](https://linear.app/siobytes/issue/SIO-1963) | kafka | 1958, 1952 |
| [SIO-1964](https://linear.app/siobytes/issue/SIO-1964) | atlassian, server half only | 1958, 1952 |
| [SIO-1965](https://linear.app/siobytes/issue/SIO-1965) | gitlab, server half only | 1958, 1952 |
| [SIO-1966](https://linear.app/siobytes/issue/SIO-1966) | konnect, mechanical port, tests only | 1958, 1952 |
| [SIO-1967](https://linear.app/siobytes/issue/SIO-1967) | elastic, last | 1958, 1952, 1953 |
| [SIO-1968](https://linear.app/siobytes/issue/SIO-1968) | Cleanup: remove the v1 server path from shared | all ten ports |
| [SIO-1955](https://linear.app/siobytes/issue/SIO-1955) | Agent: `@langchain/mcp-adapters` 1.1.3 to 2.0.0 | none (independent track) |
| [SIO-1956](https://linear.app/siobytes/issue/SIO-1956) | AgentCore SigV4 proxy: forward the new required headers; probe AgentCore Runtime | none recorded; its live probe needs SIO-1962 or SIO-1963 deployed |

Each ticket's Linear description is self-contained (steps, acceptance criteria, server-specific notes). This handover carries the code-level detail for the first six.

## 4. Where the bodies are buried

### 4.1 Dependency pins (root `package.json`)

```jsonc
"catalog": {
	"@langchain/langgraph": "^1.2.2",
	"@langchain/mcp-adapters": "^1.1.3",
	"@langchain/core": "^1.1.40",
	"@modelcontextprotocol/sdk": "^1.30.0",
	"zod": "^4.4.3",
},
"overrides": {
	"zod": "4.3.6",
	"@modelcontextprotocol/sdk": "1.30.0"
},
```

`packages/mcp-server-couchbase/package.json:15-18` is the only place v2 is declared, pinned to 2.0.0, and two of the three are imported nowhere:

```jsonc
"@modelcontextprotocol/core": "2.0.0",
"@modelcontextprotocol/node": "2.0.0",
"@modelcontextprotocol/sdk": "catalog:",
"@modelcontextprotocol/server": "2.0.0",
```

### 4.2 The stateless `/mcp` handler that gets swapped (eleven copies)

Seven `transport/http.ts` (elastic, kafka, couchbase, konnect, gitlab, atlassian, aws), three single-file `transport.ts` (elastic-iac `:48`, knowledge-graph `:49`, landing-zone-iac `:46`), and one shared. The landing-zone-iac copy, `packages/mcp-server-landing-zone-iac/src/transport.ts:45-62`:

```ts
const mcp = serverFactory();
const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
transport.onerror = (error: unknown) => {
	const detail = { error: error instanceof Error ? error.message : String(error) };
	if (isBenignStreamCancel(error)) log.warn(detail, "benign stream cancel");
	else log.error(detail, "transport stream error");
};
await mcp.connect(transport);
try {
	return await transport.handleRequest(request);
} catch (error) {
	log.error({ error: error instanceof Error ? error.message : String(error) }, "MCP request failed");
	return Response.json(
		{ jsonrpc: "2.0", error: { code: -32000, message: "Internal server error" }, id: null },
		{ status: 500 },
	);
}
```

### 4.3 The bootstrap seam is typed to the v1 server

`packages/shared/src/bootstrap.ts:55-60`:

```ts
createServerFactory?: (datasource: T) => () => McpServer;
createTransport: (
	serverFactory: (() => McpServer) | undefined,
	datasource: T,
	identityCard: IdentityCard,
) => Promise<BootstrapTransportResult>;
```

and the per-instance wrap at `:131-143` (this is the dispatch-level wrap to keep):

```ts
const serverFactory: (() => McpServer) | undefined = innerFactory
	? () => {
			const server = innerFactory();
			if (readOnlyConfig) installReadOnlyChokepoint(server, readOnlyConfig.manager);
			installToolCallLogging(
				server,
				logger,
				undefined,
				metricsSink ? (outcome) => metricsSink.record(outcome.tool, outcome.ok, outcome.failureClass) : undefined,
			);
			return server;
		}
	: innerFactory;
```

Both wrappers reach a private field and already fail loudly if it moves (`packages/shared/src/read-only-chokepoint.ts:43-48`, same shape in `tool-call-logging.ts:115-127`):

```ts
export function installReadOnlyChokepoint(server: McpServer, manager: ReadOnlyManagerLike): void {
	const internal = server.server as unknown as InternalServerHandlers;
	const handlers = internal._requestHandlers;
	if (!handlers || typeof handlers.get !== "function") {
		throw new Error("Cannot install read-only chokepoint: McpServer internals are not as expected.");
	}
```

### 4.4 The shared AgentCore transport owns a v1 runtime import

`packages/shared/src/transport/agentcore.ts:29-33,54-59`:

```ts
export async function startAgentCoreTransport(
	serverFactory: () => McpServer,
	logger: BootstrapLogger,
	config: AgentCoreTransportConfig = {},
): Promise<AgentCoreTransportResult> {
	// ...
		const server = serverFactory();
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
		});

		await server.connect(transport);
```

Callers (seven): `packages/mcp-server-{elastic,kafka,couchbase,konnect,gitlab,atlassian,aws}/src/transport/factory.ts`.

### 4.5 The record/replay server factory would throw at boot on v2

`packages/shared/src/cached-server-factory.ts:40,62-68`:

```ts
const RECORDED_METHODS = ["registerTool", "registerResource", "registerPrompt", "tool", "resource", "prompt"] as const;
// ...
for (const method of RECORDED_METHODS) {
	const bound = (template[method] as VariadicRegistrar).bind(template);
	(template as unknown as Record<RecordedMethod, VariadicRegistrar>)[method] = (...args: unknown[]) => {
		recorded.push({ method, args });
		return bound(...args);
	};
}
```

The v2 `McpServer` has no `tool` / `resource` / `prompt`, so `template[method]` is `undefined` and `.bind` throws.

### 4.6 The unused stateful session mode

`packages/mcp-server-elastic/src/transport/http.ts:91-168` (`createStatefulHandlers`) and the selection at `:174-182`:

```ts
const isStateful = config.sessionMode === "stateful";

let postHandler: (req: Request) => Promise<Response>;
let getHandler: (req: Request) => Promise<Response> | Response;
let deleteHandler: (req: Request) => Promise<Response> | Response;
let closeAllSessions: (() => Promise<void>) | undefined;

if (isStateful) {
	const handlers = createStatefulHandlers(serverFactory);
```

Same structure in kafka, couchbase, konnect, gitlab and atlassian. Defaults are `"stateless"` everywhere (`elastic defaults.ts:16`, `kafka:70`, `couchbase:18`, `konnect:48`, `gitlab:46`, `atlassian:36`) and nothing in the repo sets `MCP_SESSION_MODE`.

### 4.7 Elastic's process-global notification context

`packages/mcp-server-elastic/src/utils/notifications.ts:28-29,39-47,353-371`:

```ts
export class NotificationManager {
	private requestContext: RequestHandlerExtra<ServerRequest, ServerNotification> | null = null;
	// ...
	setRequestContext(context: RequestHandlerExtra<ServerRequest, ServerNotification>): void {
		this.requestContext = context;
	}
	clearRequestContext(): void {
		this.requestContext = null;
	}
// ...
export const notificationManager = new NotificationManager();

export function withNotificationContext<TArgs, TResult>(handler: ...) {
	return async (args, extra) => {
		notificationManager.setRequestContext(extra);
		try {
			return await handler(args, extra);
		} finally {
			notificationManager.clearRequestContext();
		}
	};
}
```

Two wrapped call sites: `tools/core/search.ts:795`, `tools/index_management/reindex_with_notifications.ts:314`. With two concurrent wrapped calls, the first to finish nulls the context and silences the other. Found by reading, not reproduced.

### 4.8 The pilot's version-list workaround

`packages/mcp-server-couchbase/src/server-v2.ts:60-63`:

```ts
const server = new McpServer(
	{ name: "mcp-server-couchbase-v2", version: "0.1.0-pilot" },
	{ supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS, "2026-07-28"] },
);
```

Needed on 2.0.0 because its default supported list stops at `2025-11-25`. Unknown on 2.3.x.

## 5. The work, step by step (unblocked tickets)

### 5.1 SIO-1951: bump v2 and re-verify

This edits root `package.json`. The global guardrail says ask before modifying it.

1. Root `package.json` catalog: add `"@modelcontextprotocol/server": "<target 2.3.x>"`.
2. `packages/mcp-server-couchbase/package.json`: set `"@modelcontextprotocol/server": "catalog:"`, delete the `core` and `node` lines.
3. `bun install`, then `cd packages/mcp-server-couchbase && bun run test`.
4. Expect the wire test to need a change: `tests/server-v2-wire.test.ts` was written against 2.0.0 and its modern-era request sends only `Mcp-Method` and `Mcp-Name`. The current SDK guide says `MCP-Protocol-Version` is also required on every modern request POST and that a request omitting it is refused. Add the header if the test fails that way. This is predicted from the docs, not observed.
5. Answer in the PR body: is the `supportedProtocolVersions` workaround (4.8) still needed; is `server.server._requestHandlers` still a Map keyed by method; is registration still an eager, unmemoized JSON Schema conversion; does the pilot factory build a server per call (2.3.0 rejects a reused server with `ALREADY_CONNECTED`).

### 5.2 SIO-1952: delete stateful mode

In each of the six `transport/http.ts` files, delete `createStatefulHandlers`, the `SessionEntry` type and the `isStateful` branch, leaving:

```ts
const postHandler = createStatelessHandler(serverFactory);
const getHandler = () => methodNotAllowed();
const deleteHandler = () => methodNotAllowed();
```

(use whatever the file already calls its 405 helper). Then remove `sessionMode` from each config schema, defaults and env mapping, remove the `MCP_SESSION_MODE` rows from `docs/configuration/mcp-server-configuration.md`, and delete the stateful tests at `packages/mcp-server-kafka/src/transport/__tests__/http.test.ts:75-140` plus the `sessionMode` default assertions (`kafka/src/config/__tests__/transport-config.test.ts:40-42`, `konnect/tests/config.test.ts:86`).

State in the PR: konnect's protocol elicitation could only work over HTTP in stateful mode, so it becomes stdio-only. Nobody runs stateful mode and konnect is offline by design.

### 5.3 SIO-1953: elastic notification context

In `notifications.ts`: delete `requestContext`, `setRequestContext`, `clearRequestContext` and `withNotificationContext`; make `sendProgress` log-only (keep the existing `logger.debug`, drop the `sendNotification` call at `:74-81`). Unwrap the two call sites. Drop `tools.listChanged: true` at `packages/mcp-server-elastic/src/server.ts:353-356`. Add a test that runs two concurrent calls of a previously wrapped tool.

Do not build request-scoped progress. The progress tokens are server-invented (`createProgressTracker`, `:407-413`), so no client can correlate them.

### 5.4 SIO-1954: shared seam

Behaviour-neutral. No server changes SDK. `packages/shared` must not import `@modelcontextprotocol/server`.

Bootstrap (`bootstrap.ts`), make the options generic with a v1 default so unmigrated callers need no edit:

```ts
export interface McpApplicationOptions<T, S = McpServer> {
	// ...
	createServerFactory?: (datasource: T) => () => S;
	createTransport: (
		serverFactory: (() => S) | undefined,
		datasource: T,
		identityCard: IdentityCard,
	) => Promise<BootstrapTransportResult>;
```

Wrappers (`read-only-chokepoint.ts:43`, `tool-call-logging.ts:116`), loosen only the parameter type; the body already casts through `unknown`:

```ts
export function installReadOnlyChokepoint(server: { readonly server: unknown }, manager: ReadOnlyManagerLike): void {
```

AgentCore transport, take a fetch handler and export today's body as a helper:

```ts
export function v1StatelessHandler(serverFactory: () => McpServer, logger: BootstrapLogger) {
	return async (req: Request): Promise<Response> => {
		const server = serverFactory();
		const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
		await server.connect(transport);
		try {
			return await transport.handleRequest(req);
		} catch (error) {
			logger.error("AgentCore MCP request error", { error: error instanceof Error ? error.message : String(error) });
			return Response.json(
				{ jsonrpc: "2.0", error: { code: -32000, message: "Internal server error" }, id: null },
				{ status: 500 },
			);
		}
	};
}

export async function startAgentCoreTransport(
	handleMcp: (req: Request) => Promise<Response>,
	logger: BootstrapLogger,
	config: AgentCoreTransportConfig = {},
): Promise<AgentCoreTransportResult> {
```

The `shuttingDown` 503 guard stays in `startAgentCoreTransport`, in front of `handleMcp`. Each of the seven callers becomes `startAgentCoreTransport(v1StatelessHandler(serverFactory, logger), logger, cfg)`.

Cached factory, skip methods the server does not have and make it generic:

```ts
for (const method of RECORDED_METHODS) {
	const original = (template as unknown as Record<string, unknown>)[method];
	if (typeof original !== "function") continue; // v2 McpServer has no tool/resource/prompt
	const bound = (original as VariadicRegistrar).bind(template);
	// ...unchanged
}
```

Record the decision in the PR: keep the dispatch-level wrap; SIO-1438's per-tool wrap is not adopted (reason in section 8).

### 5.5 SIO-1957: test harness (after SIO-1954)

One shared helper. It keeps the v1 `Client` and points `StreamableHTTPClientTransport`'s `fetch` option at a handler, so no socket is opened:

```ts
const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
	fetch: (url, init) => handleMcp(new Request(url, init)),
});
```

`handleMcp` is `v1StatelessHandler(factory, logger)` for unmigrated servers and `createMcpHandler(factory).fetch` for migrated ones. Convert the 30 test files and `packages/tools-verify/src/verify-action-tool-map.ts:24-52` (33 `createLinkedPair` sites). Not yet run: expect the client's optional GET to get a 405, which the v1 client tolerates. Do not regenerate any snapshot in this ticket.

### 5.6 SIO-1958: landing-zone-iac, the per-server recipe

1. `cd packages/mcp-server-landing-zone-iac && npx @modelcontextprotocol/codemod@latest v1-to-v2 .`, then hand-fix. Raw Zod shapes are still accepted by `registerTool`.
2. In `src/transport.ts`, build the handler once, outside `Bun.serve`'s `fetch`, and replace lines 45-62 (quoted in 4.2):

```ts
import { createMcpHandler } from "@modelcontextprotocol/server";

const mcpHandler = createMcpHandler(serverFactory, {
	onerror: (error: unknown) => {
		const detail = { error: error instanceof Error ? error.message : String(error) };
		if (isBenignStreamCancel(error)) log.warn(detail, "benign stream cancel");
		else log.error(detail, "transport stream error");
	},
});

// inside fetch, after the /health, /identity, /ready routes and the path check:
return mcpHandler.fetch(request);

// in the returned close(): await mcpHandler.close();
```

   The `{ onerror }` option and the `{ fetch, close }` return shape were read from 2.0.0; confirm on the target version.
3. stdio: replace `await server.connect(new StdioServerTransport())` with `serveStdio(serverFactory)` from `@modelcontextprotocol/server/stdio`.
4. Add a three-era wire test, modelled on `packages/mcp-server-couchbase/tests/server-v2-wire.test.ts:44-112`: a legacy `initialize` (`protocolVersion: "2025-11-25"`), a modern `tools/call` with the full `_meta` trio (`protocolVersion`, `clientCapabilities`, `clientInfo`) and the request headers, and `server/discover`. Bodies can come back as plain JSON or SSE-framed; reuse that file's `parseJsonRpcBody`. Also assert a validation failure (stamped envelope) and an unknown tool, in both eras.
5. Produce the three measurements the ticket asks for: request latency before and after, a diff of the `tools/list` JSON (draft-7 versus draft 2020-12), and the error-shape diff.

## 6. Verification

Per-package scripts, not bare `bun test` (see the Commands section of `CLAUDE.md`):

```bash
bun --version   # must match .bun-version (1.4.2 when this was written)
bun run typecheck && bun run lint && bun run test
```

`bun run test` at the repo root can crash the Bun runner mid-suite; if it does, run each touched package:

```bash
cd packages/shared && bun run test
cd packages/mcp-server-couchbase && bun run test
cd packages/mcp-server-landing-zone-iac && bun run test
```

Wire probe of a migrated server (start it yourself, kill it by PID afterwards, prove the port is free):

```bash
curl -s -X POST http://localhost:9088/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
# expect: result.protocolVersion "2025-11-25"

curl -s -X POST http://localhost:9088/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' -H 'Mcp-Method: server/discover' \
  -d '{"jsonrpc":"2.0","id":2,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"probe","version":"0"}}}}'
# expect: HTTP 200, a JSON-RPC result and no error (body may be SSE-framed: a "data:" line)

lsof -nP -iTCP:9088 -sTCP:LISTEN   # must print nothing after you stop the server
```

The exact modern envelope was established on 2.0.0 by the couchbase wire test; adjust if 2.3.x differs.

For any server port: a real agent turn through the web app on the unchanged agent client, and for the larger servers a `mcp-tool-eval` run compared against baseline (the model sees different schema text).

## 7. Files to modify (first six tickets)

| Package | File | Change | Ticket |
|---|---|---|---|
| root | `package.json` | catalog entry for `@modelcontextprotocol/server` | 1951 |
| mcp-server-couchbase | `package.json` | use the catalog entry; drop `core` and `node` | 1951 |
| mcp-server-couchbase | `tests/server-v2-wire.test.ts` | add `MCP-Protocol-Version` header if required | 1951 |
| mcp-server-{elastic,kafka,couchbase,konnect,gitlab,atlassian} | `src/transport/http.ts`, config schema and defaults | delete stateful mode | 1952 |
| mcp-server-kafka | `src/transport/__tests__/http.test.ts` | delete stateful tests | 1952 |
| docs | `docs/configuration/mcp-server-configuration.md` | remove `MCP_SESSION_MODE` | 1952 |
| mcp-server-elastic | `src/utils/notifications.ts`, `src/tools/core/search.ts`, `src/tools/index_management/reindex_with_notifications.ts`, `src/server.ts` | remove global context, unwrap, drop `listChanged` | 1953 |
| shared | `src/bootstrap.ts`, `src/read-only-chokepoint.ts`, `src/tool-call-logging.ts`, `src/cached-server-factory.ts`, `src/transport/agentcore.ts` | generic seam, type loosening, factory guard, handler parameter | 1954 |
| seven servers | `src/transport/factory.ts` | one-line `startAgentCoreTransport` call change | 1954 |
| shared (test helper), 30 test files, tools-verify | | replace `InMemoryTransport` | 1957 |
| mcp-server-landing-zone-iac | `src/transport.ts`, server factory, tests | in-place v2 port | 1958 |

## 8. Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| A per-tool wrap silently drops validation-failure stamping, the warn log and the metric: v2 validates input and rejects unknown tools before the tool executor runs | Certain if adopted | Keep the dispatch-level wrap (4.3). Add a wire test per server asserting a validation failure comes back stamped. |
| Tool schemas go from draft-7 to draft 2020-12; all eight snapshot hashes churn and the model sees different text | Certain | Diff one server's `tools/list` before regenerating; run mcp-tool-eval on the first port. |
| Per-request cost: v2 converts every schema eagerly at registration, unmemoized; elastic would pay 100+ conversions per request | Likely | Measure in SIO-1958. If material, convert once in `createCachedServerFactory` before the large servers. |
| Error-shape drift: unknown tool becomes a JSON-RPC error; `ProtocolError` drops the `MCP error N:` prefix that `packages/shared/src/agentcore-proxy.ts:360,367` regexes on | Likely | Leave the v1 `McpError` imports in place in the first pass (137 in elastic). |
| Findings were verified on 2.0.0, target is 2.3.x | Certain | SIO-1951 first. |
| AgentCore Runtime strips the required headers | Unknown | SIO-1956 live probe. kafka and aws stay legacy-era on the wire until proven. |
| Docs-only PR with a Linear id in title, branch or commit subject moves the issue and closes it on merge | Certain | Keep ids in the document body only. |
| Deleting pilot files in SIO-1959 | n/a | Deleting files needs explicit user confirmation first. |
| konnect has no live verification path | Certain, by design | Tests only; say so in the PR. Do not live-probe it. |

## 9. Workflow

1. `git fetch origin main` with the sandbox off (inside the sandbox it fails and leaves a stale `origin/main`; read the whole output).
2. `git switch --no-track -c <branch> origin/main`, then `git branch --show-current`.
3. Claim the ticket before the first edit: read it from Linear, assign it, move it to In Progress.
4. Implement; typecheck, lint and the touched packages' `bun run test` after each change.
5. Before pushing a code branch: a Codex review round (`/codex:review --base main`), triage, then push. Docs-only changes are exempt.
6. Open the PR as ready for review, never draft. Bind it with the `ccd_pr` tools; do not poll CI.
7. Greptile is the PR gate. If it logs `SKIPPED` on the head SHA, run the adversarial Codex pass as the substitute reviewer.
8. Linear: In Progress, then In Review, then Done only with explicit user approval.

Commit template:

```bash
git commit -F - <<'EOF'
SIO-1954: make the shared MCP bootstrap seam SDK-agnostic

<what changed and why, in prose>

Co-Authored-By: <model> <noreply@anthropic.com>
EOF
```

## 10. Out of scope

- Converting konnect elicitation to `inputRequired` (SIO-1426).
- Moving the GitLab and Atlassian upstream clients, `BaseOAuthClientProvider`, `oauth/seed.ts` and `oauth/doctor.ts` to the v2 client. They stay on v1 on purpose.
- Swapping `McpError` for `ProtocolError`.
- Real client-correlated progress notifications in elastic.
- Turning on the modern era on the agent client (needs SIO-1955, and SIO-1956 for kafka and aws).
- Registering an AgentCore Gateway.

## 11. Related code references

- `packages/mcp-server-couchbase/tests/server-v2-wire.test.ts:44-112`: working three-era wire test and the `parseJsonRpcBody` helper. Reference pattern for every server.
- `packages/mcp-server-couchbase/src/index-v2.ts:63-67`: `createMcpHandler(factory, { legacy: "stateless" })` in use.
- `packages/mcp-server-couchbase/src/v2/tool-call-wrappers.ts`: the per-tool wrap. Reference for what NOT to copy into shared.
- `packages/shared/src/bootstrap-lifecycle.ts`: the SDK-free lifecycle helpers (`installProcessErrorHandlers`, `installShutdownSignalHandlers`, `openMetricsRecorder`, `handleStartupFailure`, `isBenignStreamCancel`).
- `packages/shared/src/transport/readiness.ts:49-107`: `createReadinessProbe`, untouched by the migration.
- `packages/shared/src/agentcore-proxy.ts:266-299` (`signRequest` builds headers from scratch), `:636-657` (single process-wide `mcpSessionId`), `:859-866` (`DELETE /mcp`).
- `packages/shared/src/transport/proxy-readiness.ts:157-162`: bare `tools/list` probe with no handshake; must keep passing.
- `packages/agent/src/mcp-bridge.ts:284-437`: the one `MultiServerMCPClient` per server; `:587-656` probing uses plain `/health`, `/identity`, `/ready` GETs, never MCP `ping`.
- `packages/mcp-server-konnect/src/tools/configuration/operations.ts:105,426,725,993`: the four `elicitation/create` call sites.
- `docs/architecture/mcp-integration.md:283,410,414`: stale (says one SDK version in the tree; names a `registerMcpApplication` that does not exist). Fixed in SIO-1959.

## 12. Memory references

- `reference_git_remote_ops_fail_in_sandbox`
- `feedback_git_switch_no_track_and_never_tail_git`
- `reference_bun_test_isolate_kills_mock_module_pollution`
- `reference_local_bun_version_drift_fakes_failures`
- `feedback_run_the_whole_package_not_the_files_you_edited`
- `reference_linear_pr_link_auto_transitions_to_done`
- `reference_greptile_active_again_2026_09_14`
- `feedback_greptile_skipped_codex_review_then_merge`
- `reference_codex_review_run_via_companion_script`
- `feedback_never_use_em_dashes`
- `feedback_repo_is_public_sanitize_before_commit`
- `feedback_fake_clients_certify_assumptions`
- `feedback_test_the_mechanism_not_the_predicate`
- `reference_agentcore_proxy_sticky_session_tests_old_image`
- `feedback_mcp_server_topology_kafka_proxy_konnect_kg`
- `reference_lbug_close_segfaults_bun`
- `reference_bun_reload_leaks_native_sdk`
- `feedback_always_kill_own_background_processes_safely`
