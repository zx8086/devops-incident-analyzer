# Renovate integration slug resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix "No pending Renovate update found for 'Custom UDP Logs'" by resolving a user-typed Kibana Fleet display name (e.g. "Custom UDP Logs") to its real EPM package slug (e.g. "udp") before the Renovate Dependency Dashboard matcher runs, so display-name phrasing and slug phrasing both resolve to the same pending update.

**Architecture:** One new pure-ish node, `resolveIntegrationSlug`, inserted into the existing `extractRenovateTarget → resolveRenovateMarker` edge in the elastic-iac graph. It calls Kibana's existing `GET /api/fleet/epm/packages?withPackagePoliciesCount=true` endpoint (same call `enrichRenovateTarget` already makes, same auth/config resolution via `resolveKibanaConfig`), checks whether `target.integration` already equals some package's `name` (slug) — if so, no-op — otherwise checks for a case-insensitive exact match against some package's `title` (display name) and rewrites `target.integration` to that package's `name`. Never blocks the turn; any failure (no deployment config, network error, non-2xx, no match) falls through unchanged, preserving today's behavior for correct-slug input.

**Tech Stack:** TypeScript (strict, no `any`), Bun test (`bun:test`, `mock()`), LangGraph `StateGraph` node function, existing `fetch`-mocking convention from `renovate-integration.test.ts`.

**Spec:** [docs/superpowers/specs/2026-08-16-renovate-integration-slug-resolution-design.md](../specs/2026-08-16-renovate-integration-slug-resolution-design.md)

## Global Constraints

- TypeScript strict mode, never use `any` (biome `noExplicitAny: "error"`).
- Named exports preferred; no comments beyond the file's established "why" style (business-logic reasoning, not restating names).
- The new node must **never** set `blockedReason` and must **never** throw — every external call independently wrapped, matching `enrichRenovateTarget`'s established soft-fail pattern.
- Exact-match only against Kibana `title` (case-insensitive) — no substring/fuzzy matching against `title`. This was an explicit design decision confirmed with the user: exactly one fuzzy-matching stage exists in this sub-flow (`filterDashboardMatches` against the Renovate marker), not two.
- No new state fields — reuses the existing `renovateTarget: { deployment: string; integration: string } | null` annotation (`state.ts:790`, reducer `last`).
- Run `bun run typecheck && bun run lint` and the affected test file after every task.

---

### Task 1: `resolveIntegrationSlug` node + graph wiring

**Files:**
- Modify: `packages/agent/src/iac/nodes.ts` (add new function; insert after `resolveKibanaConfig`, i.e. after line 425, before the `fetchRenovateChangelog` comment block at line 427 — keeps it adjacent to `resolveKibanaConfig` which it calls, and above `resolveRenovateMarker`'s existing position at line 360 is fine since function declarations hoist, but placing the new function textually near `resolveKibanaConfig` keeps related code together)
- Modify: `packages/agent/src/iac/graph.ts:44` (add `resolveIntegrationSlug` to the `nodes.ts` import block, alphabetically between `reconcileStack` (line 42) and `renovateTriggerGate` (line 43))
- Modify: `packages/agent/src/iac/graph.ts:182-183` (add node registration between `extractRenovateTarget` and `resolveRenovateMarker`)
- Modify: `packages/agent/src/iac/graph.ts:332-336` (redirect `extractRenovateTarget`'s conditional edge to `resolveIntegrationSlug`; add new unconditional edge to `resolveRenovateMarker`)
- Test: `packages/agent/src/iac/renovate-integration.test.ts` (new `describe` block, colocated near the existing `enrichRenovateTarget` block at line 822)

**Interfaces:**
- Consumes: `IacStateType.renovateTarget: { deployment: string; integration: string } | null` (existing, set by `extractRenovateTarget`). Consumes existing `resolveKibanaConfig(deployment: string): { url: string; apiKey: string } | null` (`nodes.ts:418-425`, unchanged).
- Produces: `export async function resolveIntegrationSlug(state: IacStateType): Promise<Partial<IacStateType>>` — returns `{}` (no change) or `{ renovateTarget: { deployment: string; integration: string } }` (slug-resolved). This is the exact shape `resolveRenovateMarker` (the next node) already reads via `state.renovateTarget`.

- [ ] **Step 1: Write the failing tests**

Insert this new `describe` block into `packages/agent/src/iac/renovate-integration.test.ts`, immediately after the closing of the `enrichRenovateTarget (SIO-XXXX)` describe block (search for the line `describe("enrichRenovateTarget (SIO-XXXX)", () => {` at line 832 and its matching closing `});`, then insert after it — that block's own ticket placeholder was never backfilled in the source file; leave it as-is, do not "fix" it as part of this task). Add the import at the top of that new block's preceding line, matching this file's established per-block re-import convention (e.g. line 822 `import { enrichRenovateTarget } from "./nodes.ts";`):

```typescript
import { resolveIntegrationSlug } from "./nodes.ts";

// SIO-1474: resolves a Kibana Fleet display name (e.g. "Custom UDP Logs") to its EPM package
// slug (e.g. "udp") before resolveRenovateMarker's substring match against the Renovate
// dashboard marker runs. Never blocks the turn -- any failure (no deployment config, network
// error, non-2xx, no title match) falls through with target.integration unchanged. Mocking
// convention matches enrichRenovateTarget's established pattern (capture/restore global.fetch
// and process.env in afterEach).
describe("resolveIntegrationSlug (SIO-1474)", () => {
	const ORIGINAL_FETCH = global.fetch;
	const ORIGINAL_ENV = { ...process.env };

	afterEach(() => {
		global.fetch = ORIGINAL_FETCH;
		process.env = { ...ORIGINAL_ENV };
	});

	function baseState(integration: string): Partial<IacStateType> {
		return {
			renovateTarget: { deployment: "ap-cld", integration },
		};
	}

	test("returns no change when target.integration already equals a package's slug (name)", async () => {
		process.env.ELASTIC_AP_CLD_URL = "https://ap-cld.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_AP_CLD_API_KEY = "test-key";
		global.fetch = mock(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/fleet/epm/packages?")) {
				return Response.json({ items: [{ name: "udp", title: "Custom UDP Logs", version: "2.5.1" }] });
			}
			return new Response("Not Found", { status: 404 });
		}) as unknown as typeof fetch;

		const out = await resolveIntegrationSlug(baseState("udp") as IacStateType);

		expect(out).toEqual({});
	});

	test("resolves a display-name match to the package's slug", async () => {
		process.env.ELASTIC_AP_CLD_URL = "https://ap-cld.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_AP_CLD_API_KEY = "test-key";
		global.fetch = mock(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/fleet/epm/packages?")) {
				return Response.json({ items: [{ name: "udp", title: "Custom UDP Logs", version: "2.5.1" }] });
			}
			return new Response("Not Found", { status: 404 });
		}) as unknown as typeof fetch;

		const out = await resolveIntegrationSlug(baseState("Custom UDP Logs") as IacStateType);

		expect(out).toEqual({ renovateTarget: { deployment: "ap-cld", integration: "udp" } });
	});

	test("resolves a display-name match case-insensitively", async () => {
		process.env.ELASTIC_AP_CLD_URL = "https://ap-cld.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_AP_CLD_API_KEY = "test-key";
		global.fetch = mock(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/fleet/epm/packages?")) {
				return Response.json({ items: [{ name: "udp", title: "Custom UDP Logs", version: "2.5.1" }] });
			}
			return new Response("Not Found", { status: 404 });
		}) as unknown as typeof fetch;

		const out = await resolveIntegrationSlug(baseState("custom udp logs") as IacStateType);

		expect(out).toEqual({ renovateTarget: { deployment: "ap-cld", integration: "udp" } });
	});

	test("returns no change when no package name or title matches", async () => {
		process.env.ELASTIC_AP_CLD_URL = "https://ap-cld.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_AP_CLD_API_KEY = "test-key";
		global.fetch = mock(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/fleet/epm/packages?")) {
				return Response.json({ items: [{ name: "udp", title: "Custom UDP Logs", version: "2.5.1" }] });
			}
			return new Response("Not Found", { status: 404 });
		}) as unknown as typeof fetch;

		const out = await resolveIntegrationSlug(baseState("totally unrelated package") as IacStateType);

		expect(out).toEqual({});
	});

	test("returns {} immediately when renovateTarget is null, without calling fetch", async () => {
		let fetchCalled = false;
		global.fetch = mock(async () => {
			fetchCalled = true;
			return new Response("should not be called", { status: 500 });
		}) as unknown as typeof fetch;

		const out = await resolveIntegrationSlug({ renovateTarget: null } as IacStateType);

		expect(out).toEqual({});
		expect(fetchCalled).toBe(false);
	});

	test("returns no change when ELASTIC_<DEPLOYMENT>_URL is unset for this deployment", async () => {
		delete process.env.ELASTIC_AP_CLD_URL;
		delete process.env.ELASTIC_AP_CLD_API_KEY;
		global.fetch = mock(async () => new Response("should not be called", { status: 500 })) as unknown as typeof fetch;

		const out = await resolveIntegrationSlug(baseState("Custom UDP Logs") as IacStateType);

		expect(out).toEqual({});
	});

	test("returns no change when the Kibana call errors (network failure)", async () => {
		process.env.ELASTIC_AP_CLD_URL = "https://ap-cld.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_AP_CLD_API_KEY = "test-key";
		global.fetch = mock(async () => {
			throw new Error("connection reset");
		}) as unknown as typeof fetch;

		const out = await resolveIntegrationSlug(baseState("Custom UDP Logs") as IacStateType);

		expect(out).toEqual({});
	});

	test("returns no change when the Kibana call returns a non-2xx status", async () => {
		process.env.ELASTIC_AP_CLD_URL = "https://ap-cld.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_AP_CLD_API_KEY = "test-key";
		global.fetch = mock(async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;

		const out = await resolveIntegrationSlug(baseState("Custom UDP Logs") as IacStateType);

		expect(out).toEqual({});
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts -t "resolveIntegrationSlug"`
Expected: FAIL — `resolveIntegrationSlug` is not exported from `./nodes.ts` (module resolution / undefined-is-not-a-function error, not a assertion failure).

- [ ] **Step 3: Write the minimal implementation**

In `packages/agent/src/iac/nodes.ts`, insert this new function immediately after `resolveKibanaConfig`'s closing brace (currently ending at line 425, right before the `fetchRenovateChangelog` comment block that begins at line 427):

```typescript
// SIO-1474: resolves a Kibana Fleet display name ("Custom UDP Logs") to its EPM package slug
// ("udp") before resolveRenovateMarker's substring match against the Renovate dashboard marker
// runs -- extractRenovateTarget's LLM extraction has no display-name-vs-slug guidance, and
// filterDashboardMatches' substring looseness is intentional/don't-touch (see its own comment),
// so the fix belongs here: a deterministic lookup against Kibana's own package list, which is
// ground truth. Reuses the exact same /api/fleet/epm/packages call enrichRenovateTarget already
// makes (same auth/config via resolveKibanaConfig) -- not deduplicated across the two call
// sites, matching how enrichRenovateTarget and fetchAffectedPolicyNames already run as two
// independent Kibana calls per turn. Exact-match only against title (case-insensitive) -- no
// substring/fuzzy fallback here, to keep exactly one fuzzy-matching stage in this sub-flow
// (filterDashboardMatches), not two. Never blocks the turn: any failure (no deployment config,
// network error, non-2xx, no match) falls through with target.integration unchanged, preserving
// today's behavior for input that already names a correct slug. (Best-effort; unit-tested.)
export async function resolveIntegrationSlug(state: IacStateType): Promise<Partial<IacStateType>> {
	const target = state.renovateTarget;
	if (!target) return {};

	const kibanaConfig = resolveKibanaConfig(target.deployment);
	if (!kibanaConfig) return {};

	try {
		const res = await fetch(`${kibanaConfig.url}/api/fleet/epm/packages?withPackagePoliciesCount=true`, {
			headers: { Authorization: `ApiKey ${kibanaConfig.apiKey}`, "kbn-xsrf": "true" },
			signal: AbortSignal.timeout(8_000),
		});
		if (!res.ok) {
			log.warn(
				{ deployment: target.deployment, integration: target.integration, status: res.status },
				"resolveIntegrationSlug: Kibana Fleet call returned non-2xx; continuing without slug resolution",
			);
			return {};
		}
		const body = (await res.json()) as { items?: unknown };
		const items = Array.isArray(body.items) ? body.items : [];
		const packages = items.filter(
			(item): item is { name: string; title?: unknown } =>
				typeof item === "object" && item !== null && typeof (item as { name?: unknown }).name === "string",
		);

		const wanted = target.integration.toLowerCase();
		const alreadySlug = packages.some((p) => p.name.toLowerCase() === wanted);
		if (alreadySlug) return {};

		const titleMatch = packages.find((p) => typeof p.title === "string" && p.title.toLowerCase() === wanted);
		if (!titleMatch) return {};

		return { renovateTarget: { deployment: target.deployment, integration: titleMatch.name } };
	} catch (error) {
		log.warn(
			{
				deployment: target.deployment,
				integration: target.integration,
				error: error instanceof Error ? error.message : String(error),
			},
			"resolveIntegrationSlug: Kibana Fleet call failed; continuing without slug resolution",
		);
		return {};
	}
}
```

In `packages/agent/src/iac/graph.ts`:

1. Line 44 import block — add `resolveIntegrationSlug` alphabetically:

```typescript
	reconcileStack,
	renovateTriggerGate,
	resolveIntegrationSlug,
	resolveRenovateMarker,
	reviewPlan,
```

2. Lines 182-183 — register the new node between `extractRenovateTarget` and `resolveRenovateMarker`:

```typescript
			.addNode("extractRenovateTarget", extractRenovateTarget)
			.addNode("resolveIntegrationSlug", resolveIntegrationSlug)
			.addNode("resolveRenovateMarker", resolveRenovateMarker)
```

3. Lines 332-336 — redirect the existing conditional edge and add the new unconditional edge:

```typescript
			// extractRenovateTarget can block (clarify) before resolving -- blockedReason -> END.
			.addConditionalEdges("extractRenovateTarget", (s) => (s.blockedReason ? END : "resolveIntegrationSlug"), [
				"resolveIntegrationSlug",
				END,
			])
			// resolveIntegrationSlug never blocks -- always proceeds to dashboard matching.
			.addEdge("resolveIntegrationSlug", "resolveRenovateMarker")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts -t "resolveIntegrationSlug"`
Expected: PASS, all 8 new tests green.

Then run the full file to confirm no regressions in the existing 93+ tests:

Run: `cd packages/agent && bun test src/iac/renovate-integration.test.ts`
Expected: PASS, all tests green (existing `resolveRenovateMarker`/`filterDashboardMatches`/`enrichRenovateTarget` suites unaffected — their tests call those functions directly, not through the graph, so the new node's insertion doesn't touch their inputs/outputs).

- [ ] **Step 5: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: 0 errors. If lint flags import ordering in `graph.ts`, run `bun run lint:fix` and re-verify the diff only reorders imports (no logic change).

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/iac/nodes.ts packages/agent/src/iac/graph.ts packages/agent/src/iac/renovate-integration.test.ts
git commit -m "SIO-1474: resolve Kibana Fleet display name to EPM slug before Renovate dashboard match"
```

---

### Task 2: Live end-to-end verification

**Files:** None modified — this task runs the real dev server against the real `ap-cld` deployment and the real GitLab Dependency Dashboard to confirm the fix resolves the originally reported case.

**Interfaces:**
- Consumes: the running `apps/web` dev server's `/api/agent/stream` (or the elastic-iac equivalent) endpoint, and the real `ELASTIC_AP_CLD_URL`/`ELASTIC_AP_CLD_API_KEY` env vars already configured in `.env`.
- Produces: a manual confirmation report (no code artifact) — pass/fail against the reported repro.

- [ ] **Step 1: Check port 5173 is free, then start the web dev server**

```bash
lsof -i :5173
bun run --filter @devops-agent/web dev
```

Track the PID.

- [ ] **Step 2: Re-run the exact reported query against the real ap-cld deployment**

Send the elastic-iac agent this exact prompt (the one from the original bug report): `In the ap-cld deployment, upgrade the 'Custom UDP Logs' integration`

Expected: the agent now reaches the `renovate_trigger_choice` approval gate showing the `udp` marker / `chore(deps): [ap-cld] udp to v2.5.1` entry, instead of returning "No pending Renovate update found for 'Custom UDP Logs' on 'ap-cld'."

- [ ] **Step 3: Confirm the already-correct-slug path still works unchanged**

Send: `In the ap-cld deployment, upgrade the 'udp' integration`

Expected: same result as Step 2 (reaches the same gate) — confirms `resolveIntegrationSlug`'s already-a-slug no-op path didn't regress the previously-working case.

- [ ] **Step 4: Decline the gate (do not actually trigger the Renovate MR) and kill the dev server**

Decline the approval gate in the UI (this is a live production GitLab project — do not approve unless the user explicitly wants a real MR triggered).

```bash
kill <tracked PID>
lsof -nP -iTCP:5173 -sTCP:LISTEN
```

Expected: second command returns nothing (port confirmed free).

- [ ] **Step 5: Report results**

No commit for this task (verification only). Report pass/fail for Steps 2-3 back to the user before proceeding to finishing-a-development-branch.
