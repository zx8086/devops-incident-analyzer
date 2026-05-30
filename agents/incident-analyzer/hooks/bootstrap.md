# Bootstrap

Run once per chat session, before the first investigation turn.

At session start:

1. Read `memory/runtime/context.md` and the recent entries of
   `memory/runtime/key-decisions.md`. Treat them as durable operating context;
   they carry forward estate facts and prior decisions across sessions.
2. Consult `memory/wiki/index.md` before querying live datasources. Prefer an
   existing compiled wiki page over re-deriving service topology or runbook
   steps from raw sources.
3. Warm the knowledge graph connection so prior-relationship enrichment is ready
   when entities are first extracted. If the graph is unavailable, proceed
   without it; graph context degrades gracefully to empty.

This is agent-session lifecycle, separate from the MCP servers' own process
startup.
