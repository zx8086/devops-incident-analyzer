# SIO-590: Wire LangSmith Tracing with Compliance Metadata

## Goal

Inject compliance metadata from agent.yaml into all LangSmith traces so every graph invocation carries audit-relevant fields (risk tier, HITL mode, PII handling, retention period, etc.).

## Approach

Inline merge in `invokeAgent()` (Approach A). Call `complianceToMetadata()` from gitagent-bridge at the point where `RunnableConfig.metadata` is assembled, merging compliance fields with per-request metadata before passing to `graph.streamEvents()`.

### Why This Approach

- Single change site (~5 lines) in `apps/web/src/lib/server/agent.ts`
- `getAgent()` is already imported in that file
- `complianceToMetadata()` is already implemented and exported from gitagent-bridge
- LangChain's `RunnableConfig.metadata` propagates automatically through all graph nodes and sub-agent invocations -- no extra wiring needed
- No new abstractions, modules, or dependencies

### Alternatives Considered

- **Cache at module level via `getGraph()`**: Adds mutable state for zero practical benefit since the transform is pure and cheap. Risk of stale metadata if agent YAML is hot-reloaded.
- **Helper function wrapper**: One-liner indirection with no reuse -- YAGNI.

## Code Change

### `apps/web/src/lib/server/agent.ts`

New import:

```typescript
import { complianceToMetadata } from "@devops-agent/gitagent-bridge";
```

In `invokeAgent()`, replace the metadata spread in the `streamEvents` config:

```typescript
// Before:
...(options.metadata && { metadata: options.metadata }),

// After:
metadata: {
  ...complianceToMetadata(getAgent().manifest.compliance),
  ...options.metadata,
},
```

Compliance fields go first so per-request metadata (request_id, session_id) takes precedence. All compliance keys are prefixed with `compliance_` so collisions are not realistic, but the ordering is defensive by convention.

## Metadata Fields on Every Trace

| Field | Example Value | Source |
|-------|--------------|--------|
| `compliance_risk_tier` | `medium` | `agent.yaml compliance.risk_tier` |
| `compliance_audit_logging` | `true` | `compliance.recordkeeping.audit_logging` |
| `compliance_retention_period` | `1y` | `compliance.recordkeeping.retention_period` |
| `compliance_immutable_logs` | `true` | `compliance.recordkeeping.immutable` |
| `compliance_hitl` | `conditional` | `compliance.supervision.human_in_the_loop` |
| `compliance_pii_handling` | `redact` | `compliance.data_governance.pii_handling` |
| `compliance_data_classification` | `internal` | `compliance.data_governance.data_classification` |
| `request_id` | `<uuid>` | per-request (existing) |
| `session_id` | `<uuid>` | per-request (existing) |

## Propagation

LangChain's `RunnableConfig.metadata` propagates through all StateGraph nodes automatically. Every node trace (classify, normalize, entityExtractor, queryDataSource, align, aggregate, etc.) and sub-agent invocation inherits the compliance fields without additional wiring.

## Test

Unit test in `apps/web/src/lib/server/agent.test.ts`:

- Mock `getAgent()` to return a manifest with compliance config
- Mock `buildGraph()` to return a graph stub with a spied `streamEvents`
- Call `invokeAgent()` with per-request metadata
- Assert `streamEvents` was called with config containing all compliance metadata fields merged with per-request metadata
- Assert compliance fields appear alongside (not overwriting) request_id and session_id

## What Does NOT Change

- `initializeLangSmith()` -- untouched, still handles env vars and payload patching
- `buildGraph()` -- untouched
- `complianceToMetadata()` -- already implemented and tested in gitagent-bridge
- No new packages or dependencies

## Acceptance Criteria

- LangSmith traces include compliance_risk_tier, compliance_audit_logging, compliance_retention_period, compliance_immutable_logs, compliance_hitl, compliance_pii_handling, compliance_data_classification
- Metadata attached to all graph invocations (root trace and all child node traces)
- Per-request metadata (request_id, session_id) preserved alongside compliance fields
- Unit test passes validating metadata merge
- Typecheck and lint pass
