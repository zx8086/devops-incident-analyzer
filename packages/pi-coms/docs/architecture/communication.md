# Communication

The message model shared by both transports: how a prompt travels, how replies come back automatically, and the rails that keep agent-to-agent conversation from looping. Tool names below use the `coms_net_*` form; the `coms_*` equivalents behave the same unless a difference is called out.

## Tool surface

| Tool | Parameters | Behavior |
|------|-----------|----------|
| `coms_net_list` | `project?`, `include_explicit?` | List peers with name, purpose, model, live context usage, status |
| `coms_net_send` | `target`, `prompt`, `conversation_id?`, `response_schema?`, `ttl_ms?` | Send a prompt to one peer; returns `msg_id` on ack. A `ttl_ms` beyond the 30-minute default makes the send durable (see Mailbox below) |
| `coms_net_get` | `msg_id` | Non-blocking status poll: `pending`, `complete`, `error`, `timeout` |
| `coms_net_await` | `msg_id`, `timeout_ms?` | Block until the reply lands or the timeout fires |
| `coms_net_broadcast` | `prompt`, `targets?`, `timeout_ms?` | Fan out to all (or selected) peers; replies gathered in parallel |
| `coms_net_inbox` | `name?`, `limit?`, `since?`, `msg_id?` | Read a durable inbox non-destructively: retained mailbox messages, identical for every reader. `name` defaults to the shared duty inbox `ops` (`PI_COMS_NET_INBOX_NAME`). `name=<agent>` is that agent's conversation history: every completed prompt with sender, time, status and reply, kept 14 days after completion (`PI_COMS_NET_HISTORY_RETAIN_MS`). Listing bodies are 2000-char previews; `msg_id` returns one message in full (see [Monitoring](monitoring.md#the-durable-inbox-read-many-on-demand)) |

`coms_net_broadcast` exists only on the networked transport. `target` is a peer name in the caller's project, or a session id. When a name maps to more than one live session, the hub rejects the send with `ambiguous_target` rather than guessing.

## Message lifecycle

States: `queued`, `delivered`, `stored`, `complete`, `error`, `timeout` (`MessageStatus` in `contracts/wire.ts`). There is deliberately no `in_progress` state. `stored` belongs to one-way mailbox mail only (SIO-1738): it is terminal on write and never enters the request-reply lifecycle drawn below.

```
+--------+  target SSE open  +-----------+  reply submitted  +----------+
| queued | ----------------> | delivered | ----------------> | complete |
+--------+                   +-----------+                   +----------+
    |                              |                              or
    |         TTL (30 min) expires |                         +----------+
    +------------------------------+-----------------------> |  error   |
                                                             +----------+
```

1. **Send.** `coms_net_send` posts to `/v1/messages`. The hub resolves the target, checks the hop count and the target's inbox depth (cap 100), assigns a ULID `msg_id`, and pushes a `prompt` event down the target's SSE stream. The sender gets the `msg_id` back immediately.
2. **Deliver.** The receiving extension injects the prompt into its session as a follow-up message that triggers a normal Pi turn (`extensions/coms-net.ts:657-746`). The injected text names the sender and its working directory.
3. **Reply.** On `agent_end`, the extension takes the final assistant message of that turn and submits it via `POST /v1/messages/:id/response` (`extensions/coms-net.ts:1774-1828`). The hub pushes a `response` event to the sender and releases any awaiters.
4. **Collect.** The sender's `coms_net_await` races three sources: the local SSE-resolved promise, a server long-poll on `/v1/messages/:id/await`, and a local timer (`extensions/coms-net.ts:1564`).

Messages expire 30 minutes after creation by default (`PI_COMS_NET_MESSAGE_TTL_MS`); expired queued or delivered messages become `error: "expired"`. A send may request a longer `ttl_ms`, capped by `PI_COMS_NET_MAX_TTL_MS` (default 14 days).

### Mailbox: durable sends to offline peers

A send whose `ttl_ms` exceeds the default is a **mailbox send**. If the target name has no live session, the hub does not return `target_not_found`; it stores the message by name (`200 {status: "stored", target_session: null}`) and persists it in sqlite. A mailbox send is `stored` from creation whether or not the target is online, and stays `stored`: nothing answers it, so it never becomes `delivered` or `complete`, and its expiry alone decides when the row is deleted (SIO-1738). The next session registering under that name receives all its stored mail oldest-first as `prompt` events flagged `mailbox: true`, right after `hello` and `pool_snapshot` on its SSE stream. Mailbox-flagged prompts never trigger a turn on the recipient: the extension shows a passive notice and the content is read on demand with `coms_net_inbox` (the hub inbox retains it until TTL expiry). Only interactive short-TTL sends trigger turns and auto-replies. Queued mail survives hub restarts and container recreation. Short-TTL interactive sends keep the fail-fast behavior exactly as before.

This is how monitor reports reach an operator whose laptop was offline at check time. Full mechanics in [Monitoring](monitoring.md#the-hub-mailbox).

### Target death fails pending replies fast

When an agent leaves the hub for any reason (clean shutdown, stale eviction, token revocation), every message that was **delivered** to it but not yet answered is failed terminally with `error: "target_died"`. The sender's SSE stream gets a `response` event carrying the msg_id and the unregister reason, and any pending `coms_net_await` on that id resolves immediately instead of hanging until its timeout -- an in-flight turn does not survive the agent's death, so there is nothing to wait for. **Queued** (never-delivered) mailbox mail is untouched: it keeps store-and-forward semantics and still flushes to the name's next session.

### Replies are automatic -- never a tool call

The receiver must not call `coms_net_send` to answer an inbound prompt; its turn output is the answer. This rule is enforced three ways:

1. The injected inbound message carries an explicit guard: "reply by writing a normal assistant message ... DO NOT call coms_net_send/coms_net_await/coms_net_get to reply; that creates a ping-pong loop" (`extensions/coms-net.ts:722`).
2. Every send-family tool description repeats the warning.
3. The hop limit (below) backstops both.

### Structured replies

`response_schema` requests a JSON reply. The receiving extension (`buildTurnReplies` in `extensions/turnReply.ts`) checks the final assistant message in two steps and answers with an error, never a shape the sender cannot read:

1. **Is it JSON?** `extractJsonPayload` (`extensions/jsonPayload.ts`) tries the whole text, then each fenced block, then each top-level balanced object or array, retrying each with raw control characters inside strings escaped. Trailing commas, single quotes and comments are deliberately not repaired. When nothing parses the reply is `response not valid JSON (<n> chars, stop=<reason>; parse error: <cause>; starts: <head> ... ends: <tail>)`: the length, how the run stopped and a bounded head and tail of 160 characters each (SIO-1804), plus the parser's reason capped at 44 characters (SIO-1833). Bun's parser quotes the offending token from the payload, so everything it quotes is replaced with `"..."` before the reason leaves the host.
2. **Does it match the schema it was handed?** (SIO-1831) The required top-level keys are checked directly, then typebox `Value.Check` covers types and nested shape. A mismatch is `response did not match the requested schema (got keys: <keys>; missing required: <keys>)`, or, when every required key is present, `(got keys: <keys>; failed at: <path> (<expected>))`. Key names and schema paths only, never values: the payload carries account ids and ARNs. Only a schema that is unambiguously enforceable is enforced, meaning `type: "object"` with a non-empty `required` list; anything else (a bare `$ref`, an unknown type, an object with no `required`) passes through as parseable JSON, because typebox returns false rather than throwing on a schema it cannot interpret and would otherwise reject every answer.

The reply that passes is posted as the parsed value, not its text, and the hub stores it as JSON (SIO-1698: `String()` on the object used to store the literal `[object Object]`). A structured reply larger than the reply cap is rejected with `reply_too_large` (413) rather than truncated, since a cut object no longer parses; a string reply is truncated with a `[truncated by hub]` marker instead (`PI_COMS_NET_REPLY_CAP_BYTES`, see [Networking](networking.md#hub-listeners-and-ports)).

### Failed turns and stuck sessions

A run that ended in an error or was aborted, was cut off at the output limit, or produced no assistant text is answered with an **error**, never a blank `complete` (SIO-1678, `turnFailure`): `agent run error: <provider message>`, `agent run length: answer truncated at the output token limit`, or `empty reply: no assistant text`. This applies to every inbound prompt, with or without a schema. The hub backstops it: a blank response is stored as `error: "empty_reply"`.

A malformed `toolUse`/`toolResult` pair in the persisted session makes the provider reject every request identically, so the spoke repairs itself (SIO-1817): when the same provider error has come back `REPAIR_AFTER_REPEATS` (3) times in a row AND its text names the tool-pairing vocabulary, the extension compacts the session, which rewrites the history, and logs `history_repair` to the audit log. The match is deliberately narrow: a repeated access-denied or throttle failure never triggers it, because compaction cannot grant a permission and would bury the error the spoke-health check exists to surface.

## Broadcast

`coms_net_broadcast` (`extensions/coms-net.ts:1633-1693`):

1. Resolves targets: the explicit `targets` list, or every peer in the project that is not `offline` (stale peers are included).
2. Fans out one independent `/v1/messages` send per target in parallel. A per-target send failure becomes that target's result; it never fails the whole broadcast.
3. Gathers all replies in parallel with a **per-peer** timeout, so wall-clock time is bounded by the slowest peer, not the sum.
4. Returns `<replied>/<total>` with each reply (or error) under its peer name.

## Safety rails

| Rail | Mechanism | Default |
|------|-----------|---------|
| Hop limit | `hops` increments when a send happens inside an inbound-triggered turn; sends at the ceiling are rejected by client and hub | 5 (`PI_COMS_NET_MAX_HOPS`) |
| Ping-pong guard | Injected guard text plus tool-description warnings (coms-net) | -- |
| Inbox cap | Hub rejects sends when the target has 100 undelivered or unanswered messages | `PI_COMS_NET_MAX_INBOX` |
| Body cap | Hub rejects request bodies above 1 MiB with 413 | `PI_COMS_NET_MAX_BODY_BYTES` |
| Session ownership | In directory mode only the registering principal (or root) may open a session's stream, heartbeat, delete, send as, or answer for it (`403 not_owner`); inbox reads stay open to every principal | directory mode |
| Message TTL | Undelivered or unanswered messages expire | 30 min (`PI_COMS_NET_MESSAGE_TTL_MS`); per-send `ttl_ms` capped at 14 d (`PI_COMS_NET_MAX_TTL_MS`) |
| Audit log | Every send/receive/response logged with `msg_id`, names, hops -- never prompt or response bodies | -- |

A fresh user-initiated send starts at `hops = 0`. A send made while answering inbound messages uses one past the deepest unfulfilled inbound of the turn (`extensions/coms-net.ts:1270`, `outboundHops` in `extensions/turnReply.ts`), so a forwarding chain dies after five hosts no matter what the models decide to do.

## Audit logs

Both extensions append structured entries to the Pi session log: `coms-log` and `coms-net-log`. Logged: boot and shutdown, registration and name collisions, `prompt_in`/`prompt_out`, `response_in`/`response_out`, SSE connect/disconnect/reconnect, failures. Never logged: prompt text, response bodies, auth tokens. The hub additionally logs to stdout with prompt previews truncated to 47 characters.

## See Also

- [Networking](networking.md) -- the endpoints and SSE events beneath these semantics
- [Monitoring](monitoring.md) -- the mailbox in detail, and the monitor that relies on it
- [System Overview](overview.md)
- [Usage](../development/usage.md) -- addressing the fleet in practice

## Refusals and compaction on a spoke (SIO-1673)

Automatic replies have two exceptions, decided by `extensions/inboundPolicy.ts` before any turn runs. A refused prompt gets an immediate error reply (`status: error`) whose text starts with `refused:`, so the sender's await ends now instead of at its deadline, the monitor's budget can tell it from a failed turn, and it never enters the reply queue.

| Variable | Default | Effect |
|----------|---------|--------|
| `PI_COMS_NET_MUTE_SENDERS` | empty | Comma-separated name globs (`monitor-*`); every non-mailbox prompt from a matching sender is refused with `refused: recipient muted (<pattern>)` |
| `PI_COMS_NET_REFUSE_ABOVE_PCT` | `85` | Prompts carrying a `response_schema` (monitor investigations, analyzer verifications) are refused with `refused: recipient context at N%, refusing investigation` once context usage reaches this percentage. Prompts without a schema (people) always run |
| `PI_COMS_NET_COMPACT_ABOVE_TOKENS` | `150000` | After a turn that answered a schema-carrying prompt, the extension asks Pi to compact once the session is this large (`agent_settled` hook, never `agent_end`). Token-based because a Sonnet 5 spoke has a 1,000,000-token window and Pi's own threshold compaction fires only at 98.4% of it (the model is per spoke, see [Deployment](../deployment/deployment.md#iam-and-models)) |

Mailbox messages are unaffected: they never trigger a turn in the first place. On a deployed spoke these go in the operator-owned `~/.coms-env.local` (see `docs/deployment/operations-gotchas.md`); the monitor side has its own switches (`investigate off`, `pause`) in [Monitoring](monitoring.md#investigation-budget-and-operator-controls-sio-1673).
