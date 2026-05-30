# Key Decisions

Append-only log of durable decisions the agent (or its operators) made during
incident investigations. Promotions to this file are human-in-the-loop: the
agent proposes a decision and a human merges it via PR (see EPIC 1 / memory-pr).
The most recent decisions are injected into the orchestrator prompt so prior
calls inform new ones.

Format per entry:

```
## <ISO-8601 timestamp> (<requestId>)

<decision statement>

Rationale: <why>
```

<!-- Entries are appended below this line. -->
