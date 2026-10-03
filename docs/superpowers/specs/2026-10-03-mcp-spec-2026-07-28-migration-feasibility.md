# MCP spec 2026-07-28 migration: compatibility and feasibility study

Date: 2026-10-03
Related: [SIO-1427](https://linear.app/siobytes/issue/SIO-1427) (fleet migration umbrella, Backlog),
[SIO-1426](https://linear.app/siobytes/issue/SIO-1426) (konnect MRTR pilot, Backlog),
[SIO-1439](https://linear.app/siobytes/issue/SIO-1439) (scoping, Backlog),
[SIO-1409](https://linear.app/siobytes/issue/SIO-1409) / [SIO-1435](https://linear.app/siobytes/issue/SIO-1435) (readiness program and follow-on, Done)

Method: primary-source research on the spec, the TypeScript SDK, the LangChain
adapter and AgentCore docs; two read-only inventories of this repo (server side
and consumer side); one adversarial design review of the proposed approach.
Nothing was started, run, or probed live. Items that still need a live probe are
listed in section 8.

## 1. Verdict

Yes, the migration is feasible, and both blockers recorded on SIO-1427 have
cleared: SDK v2 went stable on 2026-07-27 and `@langchain/mcp-adapters` 2.0.0
(built on the v2 client) shipped on 2026-10-01.

It is not urgent. The v1 SDK is still maintained in parallel (1.32.0 shipped
2026-10-02), the 2025-era protocol is not deprecated, and no consumer of our
servers can speak the new revision today.

The cheapest safe path is NOT the cutover the couchbase pilot implies. Migrate
each server in place, behind its existing bootstrap, ports and health routes.
SDK v2's HTTP handler serves old and new clients from one endpoint, and every
one of our servers already runs stateless, so there is no cutover, no parallel
port and no flag day. The parallel `index-v2.ts` / `bootstrap-v2.ts` tree should
be deleted, not grown to parity: it has already drifted four tools behind v1.

Three things are genuinely hard, and they are independent of each other:

1. The AgentCore SigV4 proxy drops every client header, including the three the
   new revision requires. kafka and aws cannot be reached in the new protocol
   until the proxy forwards them AND AgentCore Runtime is shown to pass them
   through to the container. The second half is unverified.
2. Tool schemas change from JSON Schema draft-7 to draft 2020-12 on the wire.
   Every `tools-list-snapshot` hash churns and the model sees different schema
   text. That is a behaviour change for the agent, not a refactor.
3. The agent-side adapter upgrade (1.1.3 to 2.0.0) is a breaking change of its
   own: it prefixes tool names with the server name by default, which would
   break action-driven tool selection unless switched off.

## 2. What the spec revision changes

`2026-07-28` is final. Changes that touch this codebase:

| Change | Effect here |
|---|---|
| `initialize` handshake removed; each request carries protocol version and client capabilities in `_meta` | No per-connection state. The SDK handles the envelope. |
| Protocol sessions and `Mcp-Session-Id` removed | We already run stateless. The unused stateful mode in six `http.ts` files becomes dead code. |
| `server/discover` is mandatory | SDK provides it. |
| Required headers on modern POSTs: `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` (must agree with the body, else 400 / `-32020`) | Breaks through the AgentCore SigV4 proxy as written. |
| Server-initiated elicitation and sampling replaced by multi-round-trip requests (`input_required` + `requestState`) | konnect's four `elicitation/create` call sites. |
| `ping`, `logging/setLevel` removed | No impact: liveness uses plain `/health`, `/identity`, `/ready` GETs, never MCP `ping`. |
| HTTP GET stream and `resources/subscribe` replaced by `subscriptions/listen` | No impact: nothing sends `listChanged` or resource updates. elastic declares `tools.listChanged: true` and never emits it. |
| `tools/list` results carry `ttlMs` and `cacheScope`; deterministic tool order SHOULD | SDK adds the fields. |
| Tool schemas are full JSON Schema 2020-12 | Snapshot churn; see risk 2. |
| Roots, Sampling, Logging, HTTP+SSE transport deprecated (12-month minimum window) | Unused here. |

Request-scoped `notifications/progress` still flows on the response stream of
the request it belongs to.

## 3. SDK and ecosystem state

| Component | State on 2026-10-03 | What we run |
|---|---|---|
| `@modelcontextprotocol/sdk` (v1) | 1.32.0, still receiving backported fixes, no published end of life | 1.30.0, pinned by a root `overrides` |
| `@modelcontextprotocol/server` / `client` / `core` (v2) | 2.3.0 stable | `server` / `core` / `node` 2.0.0, couchbase only; no v2 client installed |
| `@langchain/mcp-adapters` | 2.0.0 on SDK v2 client, serves modern and legacy servers | 1.1.3 on SDK v1 |
| zod | v2 server needs `^4.2.0`; adapter 2.0.0 needs `^4.4.3` | 4.3.6 (root override; catalog says `^4.4.3`) |
| AgentCore Runtime | Docs acknowledge `2026-07-28`; platform still injects `Mcp-Session-Id` for microVM affinity | kafka and aws deployed |

Facts about SDK v2 that shape the plan:

- v1 and v2 are different package names and coexist. They already do in this
  repo. A fleet can be mixed for as long as needed.
- Upgrading the SDK does not change the wire. A v2 server on the classic
  transports still speaks only the 2025-era protocol. The new revision is served
  only through `createMcpHandler(factory)` (HTTP) and `serveStdio(factory)`.
- `createMcpHandler` defaults to `legacy: 'stateless'`: one endpoint serves both
  eras, a fresh server per request. That is exactly our current stateless shape.
- A v2 `Client` defaults to the legacy handshake, byte for byte. The modern era
  is opt-in (`versionNegotiation: { mode: 'auto' }`, which probes
  `server/discover` and falls back). So our upstream clients to GitLab and
  Atlassian are unaffected by anything in this study.
- A codemod (`npx @modelcontextprotocol/codemod@latest v1-to-v2 .`) covers the
  mechanical import and rename work. Adopting the new revision is explicitly not
  codemod-automatable.
- Raw Zod shapes are still accepted by `registerTool` in 2.0.0. Our roughly 420
  registration sites do not need rewriting. The sugar methods (`.tool()` etc.)
  are gone, and `tools-verify` already bans them.

## 4. Where the codebase stands

### Servers

All ten server packages use the shared v1 bootstrap (`createMcpApplication`,
`packages/shared/src/bootstrap.ts`), the high-level `McpServer`, and
`registerTool` only. Every server defaults to stateless HTTP
(`MCP_SESSION_MODE` defaults to `stateless`; nothing in the repo sets it).
The stateless `/mcp` handler is the same eleven lines in eleven places (seven
`transport/http.ts`, three single-file `transport.ts`, one shared
`packages/shared/src/transport/agentcore.ts`):

```ts
const server = serverFactory();
const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
await server.connect(transport);
return await transport.handleRequest(req);
```

Protocol features that are stateful or server-initiated:

| Feature | Where | Status |
|---|---|---|
| Elicitation (`extra.sendRequest({ method: "elicitation/create" })`) | konnect `tools/configuration/operations.ts`, four sites | Almost certainly already broken on stateless HTTP: the reply lands on a fresh server instance and the call waits out the 60 s timeout. konnect is offline by design (SIO-1439). |
| App-level "elicitation session" tools | konnect, in-process `Map` | Not protocol. Unaffected by the spec; already process-local. |
| Progress notifications | elastic `utils/notifications.ts`, two wrapped call sites | A process-global request-context singleton: concurrent calls overwrite each other (live bug today). Progress tokens are server-invented, so no client can correlate them. Low impact. |
| Sampling, roots, logging messages, resource subscriptions, `listChanged` sends, per-session state | none found | |

### The couchbase pilot

Corrections to the note that prompted this study:

- The pilot was built by SIO-1424 (#626), fixed by SIO-1436 (#629), and extended
  by SIO-1443 (#634). SIO-1443 was the surface port, not the pilot.
- `index-v2.ts` registers 39 tools; v1 now has 43. The three FTS tools and
  `capella_get_cluster_diagnostics_report` (SIO-1823) were added to v1 only.
  Nothing compares the two.
- The pilot is on SDK 2.0.0, published the day before the spec went final. It
  carries a workaround (`supportedProtocolVersions: [..., "2026-07-28"]`,
  `server-v2.ts:60-63`) that must be re-checked on 2.3.0.
- `bootstrap-v2.ts` is HTTP-only and has no `/health`, `/ready`, `/identity`,
  `/ping`, API-key auth, origin validation, connect backoff, metrics wiring,
  stdio, agentcore or proxy mode. Its read-only chokepoint is a stub.
- There are ten server packages, not nine.
- `docs/architecture/mcp-integration.md:410` still says there is exactly one SDK
  version in the tree, and `:414` names a function that does not exist.

Every "cutover requirement" in that note (transport parity, readiness parity,
connect resilience, port flip, parallel run) exists only because the pilot built
a second bootstrap. None of them apply to an in-place migration.

### Consumers

| Consumer | Client | Can speak 2026-07-28 today |
|---|---|---|
| LangGraph agent (`packages/agent/src/mcp-bridge.ts`), also IaC, landing-zone, eval harnesses | `@langchain/mcp-adapters` 1.1.3 on SDK 1.30.0, `transport: "http"`, one client per server | No |
| AgentCore SigV4 proxy (ports 3000, 3001) | Hand-rolled signed `fetch`, one process-wide session id | No, and it drops client headers |
| GitLab and Atlassian upstream proxies | SDK v1 `Client`, long-lived | No, and it does not matter (upstream decides) |
| OAuth seed / doctor, `tools-verify` | SDK v1 `Client` | No |
| `eval/tool-probe.ts`, proxy readiness probe | Raw bare `tools/call` / `tools/list`, no handshake | Already stateless-style; routed as legacy |
| Pi spokes | context-mode over stdio only | Not a consumer of our servers |
| Claude Desktop (documented) | stdio to elastic | Via `serveStdio` after migration |

No consumer depends on a long-lived session or SSE stream. A reconnect always
re-runs the handshake.

One inferred cost in the current setup, not observed at runtime: the bridge
injects a `traceparent` header on every tool call, and adapter 1.1.3 forks a new
client (new transport, new `initialize`) whenever per-call headers are present,
and never closes it. If that holds, every tool call pays a handshake today. The
new protocol removes the handshake entirely.

## 5. Per-server compatibility

| Server | Size | Why |
|---|---|---|
| landing-zone-iac | S | 14 tools, single `transport.ts`, one test file. Best first target. |
| elastic-iac | S | 44 tools, single `transport.ts`. |
| knowledge-graph | S | 21 tools. Runs in-process in the web app; verify that start path. |
| aws | S (server) | Stateless-only already. New-protocol reachability blocked by the proxy. |
| atlassian | S | Five registration sites. Upstream client stays on v1. |
| gitlab | M | Proxy plus code analysis; five in-memory tests. Upstream client stays on v1. |
| kafka | M | `ErrorCode` checks in `tools/wrap.ts`, stateful-mode tests to delete. Proxy-blocked like aws. |
| couchbase | M | Reconcile two trees: port `src/tools` in place, delete `src/v2`, `index-v2.ts`, `server-v2.ts`. |
| konnect | M | Elicitation decision and a handler-type cascade. Offline by design, so no live verification path. |
| elastic | L | 145 registration sites, a typed `registerTool` monkey-patch, the only read-only chokepoint consumer, 53 test files, 137 `McpError` imports. |

Client and server halves of the proxy packages can sit on different SDK majors:
only plain JSON crosses the boundary, and every `instanceof UnauthorizedError`
stays inside the client files.

## 6. Recommended approach

### Server track: migrate in place

Per server, as one atomic change (a v1 factory cannot be handed to
`createMcpHandler`; it checks `instanceof` against the v2 class):

1. Port the server factory to the v2 `McpServer` (codemod plus hand fixes).
2. In that server's transport file, replace the eleven-line stateless handler
   with a `createMcpHandler(factory, { onerror })` built once per process, and
   call `handler.close()` on shutdown.
3. stdio through `serveStdio(factory)`.

Everything else stays: `createMcpApplication`, ports, `/health`, `/ready`,
`/identity`, `/ping`, auth, origin checks, readiness probe, connect backoff.
Existing clients keep working because the handler serves the 2025-era protocol
statelessly, which is what they get today.

Shared changes needed first, all behaviour-neutral and none requiring `shared`
to import v2:

- `McpApplicationOptions<T, S = McpServer>`: generic over the server type,
  defaulting to v1, so the nine unmigrated servers need zero edits.
- `startAgentCoreTransport` takes a `(req) => Promise<Response>` handler instead
  of a server factory. Seven callers, one line each.
- `createCachedServerFactory` (SIO-1041 record/replay) skips methods that do not
  exist on the server. As written it binds `.tool` / `.resource` / `.prompt`
  and would throw at boot on v2.
- Loosen the parameter type of `installReadOnlyChokepoint` and
  `installToolCallLogging`.

Keep the dispatch-level wrap for the chokepoint and tool-call logging. The
SIO-1438 decision record adopted a per-tool wrap as the v2 idiom, and the review
found that is a regression: v2 validates input before the tool executor runs, so
a per-tool wrap never sees validation failures, and their envelope stamping,
warn log and metric silently disappear. The existing dispatch-level wrap works
on a v2 server unchanged (same `_requestHandlers` shape) and already fails
loudly at boot if the internals move. SIO-1438 should be revisited.

### Order

1. Bump couchbase's v2 packages to the target version, add
   `@modelcontextprotocol/server` to the catalog (one resolved copy, because of
   the `instanceof`), rerun the wire test, re-check the version-list workaround.
2. Two cleanups that can land on v1 today, independent of everything else:
   delete the unused stateful session mode (six `http.ts` files plus kafka's
   stateful tests), and replace elastic's global notification context with a
   log-only `sendProgress`.
3. The shared seam changes above.
4. One shared test helper that keeps the v1 `Client` but points
   `StreamableHTTPClientTransport`'s `fetch` option at a handler, and conversion
   of the 30 test files (plus `tools-verify`) that use `InMemoryTransport`. v1
   and v2 in-memory pairs cannot interconnect, and v2 has no in-memory transport
   for the modern era.
5. landing-zone-iac in place. Proves http, stdio and the agentcore transport,
   and measures the per-request registration cost.
6. couchbase in place; delete `index-v2.ts`, `server-v2.ts`, `src/v2`,
   `bootstrap-v2.ts`.
7. elastic-iac, knowledge-graph, aws, kafka.
8. atlassian, gitlab.
9. konnect.
10. elastic.
11. Remove the v1 stateless helper and flip the bootstrap default.

### Agent track: adapter 1.1.3 to 2.0.0

Independent of the server track; either can go first. The new protocol is only
actually used on the wire once both are done and the client opts in.

- Requires `@langchain/core ^1.2.6` (have 1.1.45), `@langchain/langgraph
  ^1.4.13` (have 1.3.0), `zod ^4.4.3` (override pins 4.3.6). These are root
  `package.json` changes.
- Tool names gain a `server__` prefix by default. Tool YAML, action-driven
  selection and prompts key on bare names, so set
  `prefixToolNameWithServerName: false`.
- `MultiServerMCPClient` is deprecated in favour of `MCPAdapter` but still works.
- Config shape, connection behaviour and tool results changed; read the
  migration guide before sizing this.
- Unblocks agent-side `structuredContent` consumption (SIO-1437 was closed as
  blocked on exactly this).

### Proxy track: AgentCore SigV4 proxy

`signRequest` builds outbound headers from scratch and never reads the incoming
request. To carry the new protocol it must forward `MCP-Protocol-Version`,
`Mcp-Method`, `Mcp-Name` and `Mcp-Param-*`. Until that is done and AgentCore is
proven to pass them through, keep the kafka and aws clients on the legacy era.
The servers behind the proxy can still be migrated; they just keep being reached
in the old protocol.

The proxy's session stickiness (and the `DELETE /mcp` after an image update) is
AgentCore microVM affinity, not an MCP session. The new spec does not remove it.

## 7. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Schema drift to draft 2020-12 changes what the model sees; all eight snapshot hashes churn | Certain | Diff the emitted JSON for one server before regenerating; run mcp-tool-eval on the first migrated server and compare against baseline. |
| Per-request registration cost: v2 converts every schema to JSON Schema eagerly at registration, unmemoized; elastic would pay 100+ conversions per request | Likely | Measure on landing-zone-iac; if it matters, convert once in the record/replay factory. |
| Error-shape drift: unknown tool becomes a JSON-RPC error instead of an `isError` result; `ProtocolError` drops the `MCP error N:` prefix that `agentcore-proxy.ts:360,367` regexes on | Likely | Leave the 137 `McpError` imports on v1 in the first pass; add one wire test per server for unknown-tool and validation-failure shapes. |
| AgentCore Runtime strips the required headers | Unknown | Live probe before any client goes modern for kafka or aws. |
| Findings verified against SDK 2.0.0, target is 2.3.0 (which already tightened server reuse: one server across stateless requests now fails with `ALREADY_CONNECTED`) | Certain | Step 1 of the order re-verifies on the target version before anything else moves. |
| konnect cannot be verified live | Certain, by design | Port mechanically, leave elicitation on its existing fallback, do the MRTR conversion (SIO-1426) only when konnect is back. |

## 8. Not yet verified

These need a run or a live probe, not more reading:

1. Whether AgentCore Runtime forwards `MCP-Protocol-Version`, `Mcp-Method` and
   `Mcp-Name` to the container.
2. Whether SDK 2.3.0 still needs the `supportedProtocolVersions` workaround, and
   whether `_requestHandlers` and the eager schema conversion are unchanged.
3. Whether adapter 1.1.3 really re-handshakes on every tool call (inferred from
   its `fork(headers)` code path).
4. What negotiation mode adapter 2.0.0 uses by default, and how an `auto` client
   behaves when a middlebox strips the headers (clean fallback or hard failure).
5. The v1 `Client` over `StreamableHTTPClientTransport` with an injected `fetch`
   as a test harness (expected to work; the optional GET should get a 405).

## 9. Out of scope

- Converting konnect elicitation to `inputRequired` (SIO-1426).
- Moving the GitLab and Atlassian upstream clients and `BaseOAuthClientProvider`
  to the v2 client and its new auth interface. Nothing forces it; v1 is
  maintained.
- Real client-correlated progress notifications in elastic.
- Registering an AgentCore Gateway in front of the runtimes.

## 10. Sources

- https://modelcontextprotocol.io/specification/2026-07-28/changelog
- https://blog.modelcontextprotocol.io/posts/2026-07-28/
- https://ts.sdk.modelcontextprotocol.io/v2/migration/ (upgrade-to-v2, support-2026-07-28)
- https://github.com/modelcontextprotocol/typescript-sdk/releases
- npm registry metadata for `@modelcontextprotocol/sdk`, `/server`, `/client`, `@langchain/mcp-adapters`
- https://github.com/langchain-ai/langchainjs release `@langchain/mcp-adapters@2.0.0`
- https://www.langchain.com/blog/mcp-in-langchain-stateless-protocol-elicitation-and-more
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp.html
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp-protocol-contract.html
- Repo: `experiments/HANDOFF-2026-08-07-SIO-1424.md`, `experiments/HANDOFF-2026-08-07-SIO-1435-followon-status.md`, `docs/superpowers/specs/2026-08-07-couchbase-v2-full-coverage-design.md`
