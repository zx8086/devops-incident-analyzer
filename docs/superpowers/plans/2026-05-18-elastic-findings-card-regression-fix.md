# ElasticFindingsCard Regression Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ElasticFindingsCard` render against real elastic MCP output by teaching `extractElasticFindings` to parse the multi-text-block content format the MCP actually returns.

**Architecture:** Two-path extractor — keep the existing JSON-envelope path for fabricated/JSON-shaped responses (preserves all 5 existing unit tests), add a new text-block path that fires when `o.rawJson` is a string. The text-block path splits on `Document ID:` markers, then within each document extracts the `monitor: {...}`, `url: {...}`, `observer: {...}`, `summary: {...}`, `state: {...}` blocks via brace-balanced parsing + `JSON.parse`, and resolves `status` from a priority chain (`monitor.status` → `summary.status` → `state.status`). Per-doc fallback handles browser synthetic monitors that emit status only at `summary.status` or `state.status`.

**Tech Stack:** Bun monorepo · Zod v4 schemas · LangGraph extractFindings node · existing `tryParseJson` helper at `packages/agent/src/sub-agent.ts:142-148` (already returns the raw string on parse failure — no upstream change needed).

---

## Context

The 2026-05-18 SIO-785 Phase 2 live-verification session (handover: `experiments/HANDOFF-2026-05-18-sio-785-cards-phase-2-shipped.md`) discovered that `ElasticFindingsCard` never renders against real elastic MCP output. Root cause traced and documented in memory `reference_elastic_mcp_text_block_response`:

1. `elasticsearch_search` returns `result.content` as multiple text blocks (one summary + one pretty-printed document per hit).
2. `@langchain/mcp-adapters` joins those into a single ToolMessage `content` string.
3. `tryParseJson(content)` returns the **original string** (not `null`) because the joined text isn't JSON.
4. `extractElasticFindings` calls `SearchResponseSchema.safeParse(o.rawJson)` against a string → fails → emits `{}` → no card.

Each document in the real format contains YAML-like top-level keys with JSON-object values:

```
Document ID: <id>
Score: <n>

agent: { ... }
monitor: {
  "name": "https://www.calvinklein.ee/5-pack-trunks-icon-cotton-stretch-lv00nb4437ub1",
  "id": "b223ae62-...",
  "type": "browser",
  "status": "down"           // sometimes present
}
url: {
  "full": "https://www.calvinklein.ee/5-pack-trunks-icon-cotton-stretch-lv00nb4437ub1"
}
observer: {
  "geo": { "name": "Europe - Germany" },
  "name": "europe-west3-a"
}
summary: {
  "up": 0,
  "down": 1,
  "status": "down"           // fallback source 1
}
state: {
  "up": 0,
  "down": 4323,
  "status": "down"           // fallback source 2
}
@timestamp: 2025-12-20T14:58:52.969Z
```

Key real-data observations (from `/tmp/elastic-joined-content.txt`, captured 2026-05-18 against `ap-cld` cluster):

- `monitor.status` is **sometimes missing** on browser synthetic docs (the first heartbeat doesn't carry it; the journey-end doc does).
- `monitor.name` is sometimes a URL (browser synthetics) and sometimes a friendly label (HTTP synthetics).
- `monitor.id` is a stable UUID — better dedupe key than `name`.
- `@timestamp` is a bare ISO scalar on its own line, not a JSON value.

After this plan completes, all 5 cards render against real MCP output.

---

## File Structure

### Files to be created
- `packages/agent/src/correlation/extractors/__fixtures__/elastic-synthetics-real.txt` — verbatim copy of the joined ToolMessage content captured from the live elastic MCP. Drives the new text-block tests.

### Files to be modified
- `packages/agent/src/correlation/extractors/elastic.ts` — add a `parseTextBlockSyntheticMonitors(content: string)` helper + branch on `typeof o.rawJson === "string"` in the main loop. Keep the existing JSON-envelope path intact.
- `packages/agent/src/correlation/extractors/elastic.test.ts` — add 5 new tests for the text-block format. Existing 5 tests must continue to pass.
- `experiments/findings-card-verification.md` — update Task 3 verdict from "REGRESSION" to "PASS" after live-verification.

### Files unchanged
- `packages/agent/src/sub-agent.ts` — `tryParseJson` already returns the raw string on failure; no upstream change needed.
- `packages/shared/src/agent-state.ts` — `ElasticFindingsSchema` + `ElasticSyntheticMonitorSchema` unchanged.
- `apps/web/src/lib/components/ElasticFindingsCard.svelte` — unchanged; the card already handles the populated state correctly per unit tests.

---

## Pre-flight

- [ ] **Step P1: Sync + branch**

```bash
git fetch
git checkout main
git pull --ff-only
git checkout -b simonowusupvh/sio-786-elastic-extractor-text-block
```

The branch name uses `sio-786` as a placeholder; if you've filed a different ticket ID for this fix, substitute. Branching off `main` (now at `9368207` after PR #118 merged) keeps this isolated.

- [ ] **Step P2: Confirm the regression still reproduces**

Start the elastic MCP and probe:

```bash
bun run --filter @devops-agent/mcp-server-elastic dev > /tmp/el.log 2>&1 &
sleep 15
grep "started successfully" /tmp/el.log | head -1
curl -s -X POST http://localhost:9080/mcp \
  -H "Accept: application/json, text/event-stream" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"elasticsearch_search","arguments":{"index":"synthetics-*","query":{"match_all":{}},"size":2}}}' \
  | grep -c "Document ID:"
```

Expected: `≥1`. Confirms the text-block format is still what the MCP emits.

- [ ] **Step P3: Capture a fresh fixture from the live MCP**

```bash
mkdir -p packages/agent/src/correlation/extractors/__fixtures__
curl -s -X POST http://localhost:9080/mcp \
  -H "Accept: application/json, text/event-stream" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"elasticsearch_search","arguments":{"index":"synthetics-*","query":{"match_all":{}},"size":3}}}' \
  | python3 -c "
import json, sys
raw = sys.stdin.read()
data_lines = [l[6:].rstrip() for l in raw.split('\n') if l.startswith('data: ')]
for l in data_lines:
    try:
        p = json.loads(l)
        if 'result' in p:
            blocks = p['result']['content']
            joined = '\n\n'.join(b.get('text','') for b in blocks)
            sys.stdout.write(joined)
            break
    except Exception: pass
" > packages/agent/src/correlation/extractors/__fixtures__/elastic-synthetics-real.txt
wc -l packages/agent/src/correlation/extractors/__fixtures__/elastic-synthetics-real.txt
grep -c "Document ID:" packages/agent/src/correlation/extractors/__fixtures__/elastic-synthetics-real.txt
```

Expected: file has ≥30 lines and ≥3 `Document ID:` markers. This fixture is the source of truth for the new tests.

---

## Task 1: Add failing test for the text-block format (red)

**Files:**
- Modify: `packages/agent/src/correlation/extractors/elastic.test.ts`
- Reference: `packages/agent/src/correlation/extractors/__fixtures__/elastic-synthetics-real.txt`

- [ ] **Step 1.1: Add the new test block at the end of the describe block**

In `packages/agent/src/correlation/extractors/elastic.test.ts`, after the existing `test("ignores malformed elasticsearch_search outputs", ...)` block (line 104), add **before the closing `});`** of the outer `describe`:

```ts
	test("parses synthetic monitors from real text-block MCP response (string rawJson)", () => {
		const realResponse = [
			"Total results: 10000, showing 2 from position 0",
			"",
			"Document ID: AbcXyz",
			"Score: 1",
			"",
			'agent: {\n  "name": "job-1",\n  "type": "heartbeat"\n}',
			'monitor: {\n  "origin": "ui",\n  "name": "https://example.com/page",\n  "id": "mon-uuid-1",\n  "type": "browser",\n  "status": "down"\n}',
			'url: {\n  "full": "https://example.com/page"\n}',
			'observer: {\n  "geo": {\n    "name": "Europe - Germany"\n  },\n  "name": "europe-west3-a"\n}',
			"@timestamp: 2026-05-18T14:58:52.969Z",
		].join("\n");

		const outputs: ToolOutput[] = [
			{ toolName: "elasticsearch_search", rawJson: realResponse },
		];
		const findings = extractElasticFindings(outputs);
		expect(findings.syntheticMonitors).toHaveLength(1);
		expect(findings.syntheticMonitors?.[0]).toEqual({
			name: "https://example.com/page",
			status: "down",
			url: "https://example.com/page",
			observedAt: "2026-05-18T14:58:52.969Z",
			geo: "Europe - Germany",
		});
	});

	test("falls back to summary.status when monitor.status is missing", () => {
		const realResponse = [
			"Document ID: AbcXyz",
			"",
			'monitor: {\n  "name": "https://example.com/x",\n  "id": "mon-uuid-2",\n  "type": "browser"\n}',
			'summary: {\n  "up": 0,\n  "down": 1,\n  "status": "down"\n}',
			"@timestamp: 2026-05-18T14:58:52.969Z",
		].join("\n");
		const outputs: ToolOutput[] = [
			{ toolName: "elasticsearch_search", rawJson: realResponse },
		];
		const findings = extractElasticFindings(outputs);
		expect(findings.syntheticMonitors?.[0]?.status).toBe("down");
	});

	test("falls back to state.status when monitor.status AND summary.status are missing", () => {
		const realResponse = [
			"Document ID: AbcXyz",
			"",
			'monitor: {\n  "name": "https://example.com/y",\n  "id": "mon-uuid-3"\n}',
			'state: {\n  "up": 0,\n  "down": 4323,\n  "status": "down"\n}',
		].join("\n");
		const outputs: ToolOutput[] = [
			{ toolName: "elasticsearch_search", rawJson: realResponse },
		];
		const findings = extractElasticFindings(outputs);
		expect(findings.syntheticMonitors?.[0]?.status).toBe("down");
	});

	test("dedupes by monitor.id (not name) across multiple Document blocks", () => {
		// Two heartbeat records for the same monitor.id — first wins (most-recent).
		const realResponse = [
			"Document ID: First",
			"",
			'monitor: {\n  "name": "https://example.com/z",\n  "id": "shared-uuid",\n  "status": "up"\n}',
			"@timestamp: 2026-05-18T15:00:00.000Z",
			"",
			"Document ID: Second",
			"",
			'monitor: {\n  "name": "https://example.com/z",\n  "id": "shared-uuid",\n  "status": "down"\n}',
			"@timestamp: 2026-05-18T14:00:00.000Z",
		].join("\n");
		const outputs: ToolOutput[] = [
			{ toolName: "elasticsearch_search", rawJson: realResponse },
		];
		const findings = extractElasticFindings(outputs);
		expect(findings.syntheticMonitors).toHaveLength(1);
		expect(findings.syntheticMonitors?.[0]?.status).toBe("up"); // first wins
	});

	test("parses against the captured live fixture", async () => {
		const fs = await import("node:fs/promises");
		const path = await import("node:path");
		const fixturePath = path.join(import.meta.dir, "__fixtures__", "elastic-synthetics-real.txt");
		const realResponse = await fs.readFile(fixturePath, "utf-8");
		const outputs: ToolOutput[] = [
			{ toolName: "elasticsearch_search", rawJson: realResponse },
		];
		const findings = extractElasticFindings(outputs);
		// Real fixture has at least one parseable monitor record.
		expect((findings.syntheticMonitors ?? []).length).toBeGreaterThan(0);
		// Every parsed monitor has a name and a status string.
		for (const m of findings.syntheticMonitors ?? []) {
			expect(typeof m.name).toBe("string");
			expect(m.name.length).toBeGreaterThan(0);
			expect(typeof m.status).toBe("string");
			expect(m.status.length).toBeGreaterThan(0);
		}
	});
```

- [ ] **Step 1.2: Run tests to verify the 5 new ones fail (red)**

```bash
bun test packages/agent/src/correlation/extractors/elastic.test.ts
```

Expected output: `5 pass, 5 fail` (the original 5 still pass; the 5 new ones fail because the extractor doesn't yet parse strings).

- [ ] **Step 1.3: Commit the failing tests**

```bash
git add packages/agent/src/correlation/extractors/elastic.test.ts \
        packages/agent/src/correlation/extractors/__fixtures__/elastic-synthetics-real.txt
git commit -m "$(cat <<'EOF'
SIO-786: failing tests for ElasticFindingsCard text-block parsing

5 new tests exercise the real elasticsearch_search MCP response format
(multi-text-block string content). Tests fail today because
extractElasticFindings only handles the {hits:{hits:[]}} JSON envelope.

Captures a live fixture at __fixtures__/elastic-synthetics-real.txt
from the ap-cld deployment for the fixture-driven test case.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Implement the text-block parser helper

**Files:**
- Modify: `packages/agent/src/correlation/extractors/elastic.ts`

- [ ] **Step 2.1: Add the helper above `extractElasticFindings`**

In `packages/agent/src/correlation/extractors/elastic.ts`, add the following code **after** the `SyntheticHitSourceSchema` block (around line 45) and **before** `function looksLikeSyntheticIndex` (around line 47):

```ts
// SIO-786 (2026-05-18): real elastic MCP returns multi-text-block content
// joined into a single string by @langchain/mcp-adapters. Each document is a
// section starting with "Document ID: <id>" containing YAML-like top-level
// fields with JSON object values:
//
//   monitor: { "name": "...", "id": "...", "status": "down" }
//   url: { "full": "..." }
//   observer: { "geo": { "name": "..." } }
//   summary: { "up": 0, "down": 1, "status": "down" }
//   state: { "status": "down" }
//   @timestamp: 2026-05-18T14:58:52.969Z
//
// `monitor.status` is not always present on browser synthetic heartbeat
// records; resolve status from monitor.status -> summary.status -> state.status.
// Dedupe by monitor.id (stable UUID); fall back to monitor.name when id is
// absent.

// Find a "<key>: {" line and return the substring of the brace-balanced JSON
// object that follows. Returns null when the key isn't present or braces
// don't balance.
function extractJsonBlock(text: string, key: string): string | null {
	const re = new RegExp(`^${key}:\\s*\\{`, "m");
	const m = re.exec(text);
	if (!m) return null;
	const start = m.index + m[0].length - 1; // position of opening brace
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (escape) {
			escape = false;
			continue;
		}
		if (ch === "\\") {
			escape = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

function parseJsonBlock<T = unknown>(text: string, key: string): T | null {
	const block = extractJsonBlock(text, key);
	if (block === null) return null;
	try {
		return JSON.parse(block) as T;
	} catch {
		return null;
	}
}

// Bare-scalar field, e.g. `@timestamp: 2026-05-18T14:58:52.969Z` (no quotes,
// not a JSON value).
function extractScalarField(text: string, key: string): string | null {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`^${escaped}:\\s*(\\S.*?)\\s*$`, "m");
	const m = re.exec(text);
	return m ? (m[1] ?? null) : null;
}

interface ParsedMonitorSection {
	name?: string;
	id?: string;
	status?: string;
	type?: string;
}
interface ParsedUrlSection {
	full?: string;
}
interface ParsedObserverSection {
	geo?: { name?: string };
	name?: string;
}
interface ParsedStatusSection {
	status?: string;
}

function parseSyntheticMonitorsFromText(content: string): ElasticSyntheticMonitor[] {
	// Split on "Document ID:" — the leading marker for each hit's section.
	// The first split element (before the first Document ID) is the summary
	// line ("Total results: ...") which we drop.
	const sections = content.split(/^Document ID:.*$/m).slice(1);
	if (sections.length === 0) return [];

	const monitorsByKey = new Map<string, ElasticSyntheticMonitor>();
	for (const section of sections) {
		const monitor = parseJsonBlock<ParsedMonitorSection>(section, "monitor");
		if (!monitor || !monitor.name) continue;

		// Status priority: monitor.status -> summary.status -> state.status.
		let status = monitor.status;
		if (!status) {
			const summary = parseJsonBlock<ParsedStatusSection>(section, "summary");
			status = summary?.status;
		}
		if (!status) {
			const state = parseJsonBlock<ParsedStatusSection>(section, "state");
			status = state?.status;
		}
		if (!status) continue; // no resolvable status — skip

		const dedupeKey = monitor.id ?? monitor.name;
		if (monitorsByKey.has(dedupeKey)) continue; // first wins (most-recent)

		const url = parseJsonBlock<ParsedUrlSection>(section, "url");
		const observer = parseJsonBlock<ParsedObserverSection>(section, "observer");
		const timestamp = extractScalarField(section, "@timestamp");

		monitorsByKey.set(dedupeKey, {
			name: monitor.name,
			status,
			...(url?.full && { url: url.full }),
			...(timestamp && { observedAt: timestamp }),
			...(observer?.geo?.name && { geo: observer.geo.name }),
		});
	}
	return Array.from(monitorsByKey.values());
}
```

- [ ] **Step 2.2: Wire the new path into `extractElasticFindings`**

Replace the body of `extractElasticFindings` (currently lines 59-89) with:

```ts
export function extractElasticFindings(outputs: ToolOutput[]): ElasticFindings {
	const monitorsByName = new Map<string, ElasticSyntheticMonitor>();

	for (const o of outputs) {
		if (o.toolName !== "elasticsearch_search") continue;

		// SIO-786: real elastic MCP returns multi-text-block content joined into
		// a string by tryParseJson's fall-through. Detect string rawJson and
		// route to the text-block parser; otherwise keep the JSON-envelope path.
		if (typeof o.rawJson === "string") {
			for (const m of parseSyntheticMonitorsFromText(o.rawJson)) {
				if (monitorsByName.has(m.name)) continue;
				monitorsByName.set(m.name, m);
			}
			continue;
		}

		const parsed = SearchResponseSchema.safeParse(o.rawJson);
		if (!parsed.success) continue;
		const hits = parsed.data.hits.hits;
		// Heuristic: if the search wasn't against synthetics, the hits won't have
		// the monitor.status shape and the inner safeParse will skip them.
		const wantSynthetic = looksLikeSyntheticIndex(o) || hits.length > 0;
		if (!wantSynthetic) continue;
		for (const hit of hits) {
			const source = SyntheticHitSourceSchema.safeParse(hit._source);
			if (!source.success) continue;
			// Only keep the most recent doc per monitor name (responses are typically
			// sorted by @timestamp desc; first wins).
			if (monitorsByName.has(source.data.monitor.name)) continue;
			monitorsByName.set(source.data.monitor.name, {
				name: source.data.monitor.name,
				status: source.data.monitor.status,
				...(source.data.url?.full ? { url: source.data.url.full } : {}),
				...(source.data["@timestamp"] ? { observedAt: source.data["@timestamp"] } : {}),
				...(source.data.observer?.geo?.name ? { geo: source.data.observer.geo.name } : {}),
			});
		}
	}

	if (monitorsByName.size === 0) return {};
	return { syntheticMonitors: Array.from(monitorsByName.values()) };
}
```

- [ ] **Step 2.3: Run tests to verify all 10 pass (green)**

```bash
bun test packages/agent/src/correlation/extractors/elastic.test.ts
```

Expected: `10 pass, 0 fail`.

If any of the 4 hand-built tests fail, debug the parser against the failing fixture inline:

```bash
bun -e "import { extractElasticFindings } from './packages/agent/src/correlation/extractors/elastic.ts'; const r = extractElasticFindings([{ toolName: 'elasticsearch_search', rawJson: '<paste-failing-fixture>' }]); console.log(JSON.stringify(r, null, 2))"
```

If the fixture-driven test (Step 1.1 last test) fails, inspect the fixture for unexpected shapes:

```bash
grep -c "Document ID:" packages/agent/src/correlation/extractors/__fixtures__/elastic-synthetics-real.txt
grep -A1 "monitor:" packages/agent/src/correlation/extractors/__fixtures__/elastic-synthetics-real.txt | head -10
```

- [ ] **Step 2.4: Typecheck the full repo**

```bash
bun run typecheck 2>&1 | grep -E "Exited|ERRORS"
```

Expected: every package shows `Exited with code 0`.

- [ ] **Step 2.5: Commit**

```bash
git add packages/agent/src/correlation/extractors/elastic.ts
git commit -m "$(cat <<'EOF'
SIO-786: parse real elasticsearch_search text-block format

Adds a text-block parser path to extractElasticFindings that fires when
o.rawJson is a string (the case for real elastic MCP responses, where
@langchain/mcp-adapters joins multiple text content blocks into one
ToolMessage content). The existing JSON-envelope path is preserved for
the fabricated {hits:{hits:[]}} shape, so all 5 prior unit tests still
pass.

Parser splits on "Document ID:" markers, extracts the monitor/url/
observer/summary/state JSON blocks via brace-balanced text extraction,
and resolves status from a priority chain (monitor.status ->
summary.status -> state.status) since browser synthetic heartbeats
don't always carry monitor.status. Dedupe key is monitor.id (stable
UUID) falling back to monitor.name.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Lint + full test suite

- [ ] **Step 3.1: Run lint and auto-fix**

```bash
bun run lint:fix 2>&1 | tail -5
```

If files I edited get reformatted, expected. If lint:fix reports errors in **files I didn't author** (the same pre-existing drift on `main` from the prior session), restore them:

```bash
# Confirm which files were changed
git diff --name-only
# Restore any that aren't packages/agent/src/correlation/extractors/elastic.ts
# or packages/agent/src/correlation/extractors/elastic.test.ts
git restore <unrelated-files>
```

Then re-run lint to confirm my files are clean:

```bash
bun run lint 2>&1 | grep -B2 "× " | head -20
```

Expected: no errors against `elastic.ts` or `elastic.test.ts`.

- [ ] **Step 3.2: Run the full test suites**

```bash
bun test packages/agent/src 2>&1 | tail -3
cd apps/web && bun test 2>&1 | tail -3
cd ../../packages/shared && bun test 2>&1 | tail -3
```

Expected:
- `packages/agent/src`: ≥444 pass (439 pre-existing + 5 new), 18 skip, 0 fail
- `apps/web`: 100 pass, 0 fail
- `packages/shared`: 287 pass, 0 fail

- [ ] **Step 3.3: Commit any biome auto-format that hit my files**

```bash
cd /Users/Simon.Owusu@Tommy.com/WebstormProjects/devops-incident-analyzer
git status --short
# Only stage elastic.ts / elastic.test.ts / __fixtures__/elastic-synthetics-real.txt
git add packages/agent/src/correlation/extractors/elastic.ts \
        packages/agent/src/correlation/extractors/elastic.test.ts \
        packages/agent/src/correlation/extractors/__fixtures__/elastic-synthetics-real.txt
# Only commit if there's something staged from biome:
if ! git diff --staged --quiet; then
  git commit -m "$(cat <<'EOF'
chore: biome auto-format SIO-786 elastic extractor changes

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
fi
```

---

## Task 4: Live-verify in browser

**Files (read-only):**
- `apps/web/src/lib/components/ElasticFindingsCard.svelte`
- `experiments/findings-card-verification.md`

- [ ] **Step 4.1: Make sure all MCPs are up + web is on the new code**

```bash
# Kill anything from prior sessions; restart fresh so bun picks up the new agent code
# Per memory reference_bun_hot_does_not_reresolve_modules, --hot is not enough.
pkill -f "vite|sveltekit|apps/web.*dev" 2>/dev/null
sleep 3
# MCPs (skip kafka per handover; konnect not running)
for pkg in elastic gitlab atlassian couchbase aws; do
  lsof -nP -iTCP:$([ "$pkg" = elastic ] && echo 9080 || [ "$pkg" = gitlab ] && echo 9084 || [ "$pkg" = atlassian ] && echo 9085 || [ "$pkg" = couchbase ] && echo 9082 || echo 3001) -sTCP:LISTEN 2>/dev/null >/dev/null \
    || bun run --filter @devops-agent/mcp-server-$pkg dev > /tmp/$pkg.log 2>&1 &
done
sleep 25
cd apps/web && bun run dev > /tmp/web.log 2>&1 &
sleep 12
grep -E "MCP server connected|MCP tools loaded" /tmp/web.log | tail -10
```

Expected: web log shows `MCP server connected` for elastic-mcp at minimum.

- [ ] **Step 4.2: Drive the browser**

Open http://localhost:5173. Set the datasource filter to **Elastic only** (click "None" then "Elastic"), set the Elastic deployment to **ap-cld only** (click deployment-row "None" then "ap-cld"). Submit prompt:

> Are any synthetic monitors currently down on the ap-cld cluster? Query synthetics-* and report monitor name, status, and observer geo.

Wait ~90s for the agent to finish.

- [ ] **Step 4.3: Confirm the card renders**

After "Completed in Xs" appears, check the DOM for the card. Either via browser DevTools console:

```js
const t = document.body.innerText;
console.log({
  has_elastic_findings: t.includes('ELASTIC FINDINGS'),
  has_synthetic_monitors: t.includes('SYNTHETIC MONITORS'),
  // Extract a snippet of the card
  excerpt: (t.match(/ELASTIC FINDINGS[\s\S]{0,500}/) || ['(not present)'])[0],
});
```

Expected: both flags true, excerpt shows status-dot rows with monitor names + statuses + geo.

- [ ] **Step 4.4: Take a screenshot**

Save to `experiments/screenshots/2026-05-18-elastic-card-fixed.png` (browser screenshot via DevTools or any tool).

- [ ] **Step 4.5: Update the verification log**

In `experiments/findings-card-verification.md`, modify the Task 3 verdict from REGRESSION to PASS. Use the Edit tool with this exact replacement (preserves the rest of the file):

```
old_string:
**Verdict:** REGRESSION — agent data flows through markdown but typed card path is broken. Fix is out of scope for this plan (SIO-785 Phase 2 covers AWS + Atlassian cards and verification of existing cards, not extractor-pipeline bugs).

new_string:
**Verdict (original):** REGRESSION — agent data flows through markdown but typed card path is broken.

**Verdict (after SIO-786 fix, 2026-05-18):** PASS — extractElasticFindings now parses the text-block format. Live-verified against ap-cld cluster with the same prompt; ElasticFindingsCard renders N synthetic monitor rows with status dot + name + geo. Screenshot at `experiments/screenshots/2026-05-18-elastic-card-fixed.png`. The follow-up ticket sections below are kept for historical context but the regression is resolved.
```

Also update the summary table at the bottom (the `## Verification summary` section): change the Elastic row's Verdict from `REGRESSION` to `PASS (after SIO-786 fix)`.

- [ ] **Step 4.6: Commit the verification log + screenshot**

```bash
git add experiments/findings-card-verification.md experiments/screenshots/2026-05-18-elastic-card-fixed.png
git commit -m "$(cat <<'EOF'
docs: SIO-786 — ElasticFindingsCard regression resolved

Live-verified extractElasticFindings now parses the real text-block
format returned by elasticsearch_search. Card renders against ap-cld
cluster synthetic monitor data. Verification log + screenshot updated.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Push + open PR

- [ ] **Step 5.1: Push the branch**

```bash
git push -u origin simonowusupvh/sio-786-elastic-extractor-text-block
```

- [ ] **Step 5.2: Open PR with `gh`**

```bash
gh pr create --title "SIO-786: fix ElasticFindingsCard regression — parse text-block MCP format" --body "$(cat <<'EOF'
## Summary

Fixes the ElasticFindingsCard regression discovered during SIO-785 Phase 2 live-verification (see `experiments/findings-card-verification.md` § Task 3 and memory `reference_elastic_mcp_text_block_response`).

- Real `elasticsearch_search` MCP responses return `result.content` as multiple text blocks (a summary line + one pretty-printed document per hit), not the fabricated `{hits:{hits:[]}}` JSON envelope.
- `@langchain/mcp-adapters` joins those blocks into a single ToolMessage `content` string; `tryParseJson` returns the raw string; the extractor's `SearchResponseSchema.safeParse` against a string fails; extractor emits `{}`; card never renders.
- Fix: add a text-block parser path that fires when `o.rawJson` is a string. Splits on `Document ID:` markers, extracts `monitor/url/observer/summary/state` JSON blocks via brace-balanced text extraction, resolves status from a priority chain (`monitor.status` → `summary.status` → `state.status`) since browser synthetic heartbeats don't always carry `monitor.status`.
- Existing JSON-envelope path preserved; all 5 prior unit tests still pass.
- Live-verified against `ap-cld` deployment — card now renders synthetic monitor rows.

## Test plan

- [x] `bun test packages/agent/src/correlation/extractors/elastic.test.ts` — 10 pass (5 existing + 5 new)
- [x] `bun run typecheck` — 0 errors across all packages
- [x] `bun run lint` — clean for files in this PR
- [x] Live-verified in browser at http://localhost:5173 against ap-cld synthetic monitors
- [x] Verification log updated; screenshot at `experiments/screenshots/2026-05-18-elastic-card-fixed.png`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5.3: Update Linear**

Set the SIO-786 issue (or whichever ticket ID was used) to **In Review** via the Linear MCP. Comment with the PR URL.

---

## Verification (end-to-end)

```bash
# Local validation
bun run typecheck
bun run lint
bun test packages/agent/src/correlation/extractors/elastic.test.ts  # 10 pass
bun test packages/agent/src                                          # ≥444 pass

# Tool-shape probe (regression sentinel)
curl -s -X POST http://localhost:9080/mcp \
  -H "Accept: application/json, text/event-stream" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"elasticsearch_search","arguments":{"index":"synthetics-*","query":{"match_all":{}},"size":2}}}' \
  | grep -c "Document ID:"
# Expect: ≥1 — confirms the text-block format is still what the MCP emits.

# Browser check
# 1. Open http://localhost:5173
# 2. Filter: Elastic only, ap-cld only
# 3. Ask: "Are any synthetic monitors down on ap-cld?"
# 4. Expect: ElasticFindingsCard renders with at least one row
```

## Out of scope (do NOT do this session)

- Update other extractors to parse text-block format. Elastic is the only one whose real MCP returns multi-text-block content; the kafka/couchbase/gitlab/aws/atlassian MCPs all return JSON-parseable single blocks.
- Modify `tryParseJson` in `packages/agent/src/sub-agent.ts:142`. It already returns the raw string on failure; that's the contract this fix relies on.
- Modify the elastic MCP to emit a structured JSON content block alongside the text blocks. The cleaner end-state but requires AgentCore redeploy and is tracked under the deferred kafka-redeploy follow-up.
- Add APM service summary, top error log clusters, or other elastic findings beyond synthetic monitors. The card's `ElasticFindingsSchema` is intentionally minimal per `packages/shared/src/agent-state.ts:122-128`.
- Refactor `extractElasticFindings` into multiple files. The new helper is ~70 lines; the file stays under 200 lines total.

## Memory references

- `reference_elastic_mcp_text_block_response` — primary reference for this bug. Update after this PR merges to point at the fix as resolved.
- `feedback_extractor_fixtures_must_mirror_real_mcp` — reinforced again; the new test at Step 1.1 step "parses against the captured live fixture" mirrors real MCP output verbatim.
- `feedback_no_direct_push_to_main` — followed in Step P1 (branch before code).
- `reference_bun_hot_does_not_reresolve_modules` — followed in Step 4.1 (full restart before live-verify).
- `feedback_verbatim_plan_code_has_bugs` — re-read the helper code before committing; the brace-balanced parser has subtle escape-handling logic worth double-checking against the fixture.
- `feedback_handover_doc_structure` — follow at completion if a handover is needed for next session.
