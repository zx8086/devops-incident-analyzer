# Agent-side structuredContent consumption

Date: 2026-08-07
Origin: [SIO-1437](https://linear.app/siobytes/issue/SIO-1437/agent-side-structuredcontent-consumption-blocked-on-langchainmcp) (Thread 1 of the [SIO-1435](https://linear.app/siobytes/issue/SIO-1435) MCP v2 adoption follow-on), which duplicates the pre-existing [SIO-1425](https://linear.app/siobytes/issue/SIO-1425/deferred-agent-side-structuredcontent-consumption-extractfindings) (deferred out of [SIO-1409](https://linear.app/siobytes/issue/SIO-1409), PR E / [SIO-1422](https://linear.app/siobytes/issue/SIO-1422)).

## Problem

SIO-1437 was originally framed as "blocked on `@langchain/mcp-adapters` v2 SDK support." Re-verification this session found that framing was wrong: `@langchain/mcp-adapters@1.1.3` (the latest published version; a v2-targeting migration PR, [langchain-ai/langchainjs#11236](https://github.com/langchain-ai/langchainjs/pull/11236), exists but is pre-release/beta and unrelated to this gap) already routes MCP `structuredContent` to `ToolMessage.artifact` on **v1**, today. The actual gap is narrower and purely agent-side: nothing in `packages/agent/src/` reads `.artifact` — `extractContent()` (`packages/agent/src/sub-agent-instrumentation.ts:448`) extracts only `.content`, and `buildPersistedToolOutput` (`packages/agent/src/sub-agent.ts:509-538`) always re-derives `toolOutputs[].rawJson` by `JSON.parse`-ing the tool's text output, even for the 4 tools ([SIO-1422](https://linear.app/siobytes/issue/SIO-1422)'s wave-1) that already emit an equivalent structured object.

This exact narrower gap is what SIO-1425 already tracks, deliberately deferred with two stated reasons: (1) ROI is mostly "skip a redundant text re-parse" since the extractors are already defensive and tested, and (2) eval impact must be reassessed because — unlike the server-side wave — this changes agent-side data flow.

## Goals

- Eliminate the redundant `JSON.parse(content_text)` for the 4 SIO-1422 tools by consuming `ToolMessage.artifact`'s structured payload instead, when present.
- Zero behavior change for every other tool (no `.artifact`, unaffected — same `tryParseJson(text)` path as today).
- Zero behavior change for the 4 target tools' *output* — `extractFindings`'s extractors must see the identical validated data they see today.
- Reassess eval impact before merge, per SIO-1425's explicit prerequisite.

## Non-goal: extractor rewrites

This session verified (research agent, live code comparison) that for all 4 tools, the server's `structuredContent` and the text `content` are serializations of the exact same in-memory object per call — never cached, never diverging, no PascalCase/camelCase or field-name mismatch against what each extractor's Zod schema already validates. The one shape nuance (`kafka_list_consumer_groups`'s `structuredContent` is always the `{groups:[...]}`-wrapped form, never the bare array `content` text carries when the handler's result is a plain array) is already handled by the extractor's existing `ListConsumerGroupsWrapperSchema` fallback (`packages/agent/src/correlation/extractors/kafka.ts:20-25`). So this is a **data-source swap**, not a reshaping or re-validation change — `packages/agent/src/correlation/extractors/{kafka,aws,atlassian}.ts` need no edits.

## Design

### 1. Capture the structured payload alongside text

`extractContent()` (`packages/agent/src/sub-agent-instrumentation.ts:448-453`) currently returns only `(result as ToolMessage).content`. Extend the raw-capture path to also pull `ToolMessage.artifact`'s `mcp_structured_content` entry when present — the adapter's shape (`@langchain/mcp-adapters` `dist/tools.js:311-325`, confirmed installed and live today) is:

```ts
// ToolMessage.artifact, when the MCP tool declared an outputSchema:
{ type: "mcp_structured_content", data: <the tool's structuredContent object> }
```

Add a sibling helper, e.g. `extractStructuredContent(result: unknown): unknown | undefined`, mirroring `extractContent`'s type-narrowing style:

```ts
function extractStructuredContent(result: unknown): unknown | undefined {
	if (!(result instanceof ToolMessage)) return undefined;
	const artifact = result.artifact;
	if (!Array.isArray(artifact)) return undefined;
	const entry = artifact.find(
		(a): a is { type: "mcp_structured_content"; data: unknown } =>
			typeof a === "object" && a !== null && (a as { type?: unknown }).type === "mcp_structured_content",
	);
	return entry?.data;
}
```

### 2. Thread it through the raw-capture -> persisted-output path

The raw capture site (`sub-agent-instrumentation.ts`, where `extractContent` is currently called to build the pre-truncation snapshot) and `RawToolOutput`'s shape both currently carry only `text`. Add an optional `structuredContent?: unknown` field to `RawToolOutput` and populate it from `extractStructuredContent` at the same capture site, so it survives through to wherever `buildPersistedToolOutput` consumes `RawToolOutput` entries.

### 3. Prefer structuredContent in `buildPersistedToolOutput`

`packages/agent/src/sub-agent.ts:509-538` currently does (approximately):

```ts
rawJson: tryParseJson(normalizeToolContent(text))
```

Change to prefer the structured payload when present:

```ts
rawJson: structuredContent !== undefined ? structuredContent : tryParseJson(normalizeToolContent(text))
```

No tool-name allowlist is needed in this function — the gate is naturally `structuredContent !== undefined`, since only the 4 SIO-1422 tools populate `.artifact` today. If a 5th tool later declares an `outputSchema`, it picks up this path automatically and correctly (this is the intended forward behavior, not scope creep: the mechanism is generic, only today's *population* is narrow).

### 4. No extractor changes

Per the Non-goal section: `extractFindings` and its three affected extractors (`kafka.ts`, `aws.ts`, `atlassian.ts`) already validate `toolOutputs[].rawJson` with Zod schemas that byte-match the structured payload's shape. They continue to work unmodified — `rawJson`'s *source* changes, its *value* does not.

### 5. Eval reassessment (required before merge)

SIO-1425 explicitly flags this as a prerequisite: even though the design targets zero output change, this alters agent-side data flow (a `JSON.parse` of serialized text is replaced by direct consumption of a pre-parsed object reference) in a way the server-side SIO-1422 wave did not. Before merging:

- Run the incident-replay eval (or the smaller live-anchor probe, memory `reference_live_eval_anchor_entities_per_datasource`) pre/post this change on the same dataset and confirm no `datasourceVerdicts`/`response_quality` drift for the kafka/aws/atlassian examples.
- If any drift appears, treat it as a signal the "same object, different route" assumption from this spec's research needs re-checking for that specific example — do not paper over it by adjusting the eval.

## Testing

Extend the existing unit tests around `buildPersistedToolOutput` / `extractContent` (co-located test file, e.g. `sub-agent-instrumentation.test.ts` or `sub-agent.test.ts`) with:

- One case per target tool: a `ToolMessage` constructed with both `.content` (JSON text) and `.artifact` (`[{type: "mcp_structured_content", data: <object>}]`) set, asserting the persisted `rawJson` equals `data` by reference/deep-equal, and that `tryParseJson` was not invoked on the text (spy or a deliberately-mismatched text fixture that would fail Zod validation if `tryParseJson`'s result were used instead).
- One case with `.artifact` absent (or present but no `mcp_structured_content` entry): confirm `rawJson` still equals `tryParseJson(text)`'s result — the existing path for every other tool is provably untouched.
- One case with `.artifact` present but `structuredContent` is `undefined`/malformed in some way `extractStructuredContent` doesn't recognize (e.g. wrong `type` string): confirm it falls back to the text-parse path rather than throwing.

Then the eval reassessment from Design step 5, as a pre-merge gate rather than a unit test.

## Files to modify

| File | Change |
|---|---|
| `packages/agent/src/sub-agent-instrumentation.ts` | Add `extractStructuredContent()`; call it alongside `extractContent()` at the raw-capture site |
| `packages/agent/src/sub-agent.ts` | Add `structuredContent?: unknown` to `RawToolOutput`; prefer it in `buildPersistedToolOutput` (~line 509-538) |
| `packages/agent/src/sub-agent-instrumentation.test.ts` (or equivalent) | New test cases per Testing section |

No changes to `packages/agent/src/correlation/extractors/*.ts`, `packages/shared/src/agent-state.ts` (`ToolOutputSchema`/`DataSourceResultSchema` shapes are unchanged — `rawJson: z.unknown()` already accommodates either source), or any MCP server package.

## Verification

```bash
bun run --filter '@devops-agent/agent' typecheck
bun run --filter '@devops-agent/agent' test
bun run lint
```

Plus the eval reassessment from Design step 5 before merge (not part of the standard CI gate — a deliberate manual pre-merge check per SIO-1425's own instruction).
