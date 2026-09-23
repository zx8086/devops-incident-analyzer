# Archify spike: diagrams for the network and application map cards

- Date: 2026-09-23
- Ticket: [SIO-1876](https://linear.app/siobytes/issue/SIO-1876)
- Branch: `SIO-1876-archify-spike`
- Flag: `ARCHIFY_DIAGRAMS_ENABLED=true` (opt-in, default off)

## Question

Can Archify (https://github.com/tt-a1i/archify, MIT) replace the ECharts force layouts in `NetworkTopologyCard` and `ApplicationTopologyCard`? If it can, is it better to produce the diagram with a deterministic converter or with an LLM?

## What was built

| Piece | File |
|---|---|
| Vendored Archify 2.17.0-dev.1 (upstream `8809b27`) | `vendor/archify/` (see `VENDORED.md`) |
| CLI wrapper (`deliver --json`, temp dir, diagnostics) | `apps/web/src/lib/server/archify/render.ts` |
| Deterministic converter (banded grid, VPC/subnet boundaries, gutter routing) | `apps/web/src/lib/server/archify/to-archify.ts` |
| LLM author plus repair loop on Bedrock (`diagramAuthor` role, max 3 attempts). **Measured, then removed before the PR** (see Recommendation) | was `apps/web/src/lib/server/archify/describe.ts` |
| `POST /api/diagram` (Zod-validated, cached by hash); `GET` reports the flag. Bounded after the Greptile review on #904: the builders' node/edge caps, a 512 KB body cap, a 50-entry cache, and at most 2 renders running + 8 queued (503 beyond that) | `apps/web/src/routes/api/diagram/+server.ts` |
| `Map / Diagram` tabs (the spike also had a `Diagram (LLM)` tab), sandboxed srcdoc iframe | `apps/web/src/lib/components/ArchifyDiagram.svelte` |

`describe.ts` was a port of `archify/integrations/bun-svelte/describe.ts`. The Anthropic SDK was swapped for `createLlm`, which meant no new dependency, no new secret, the topology never left the AWS account, and the call was traced and deadline-bound. The measurements below were taken with it. It was then deleted, together with the `diagramAuthor` role, the prompt-only vendored files (`SKILL.md`, the authoring contract, the example) and the LLM tab. Archify itself uses no model, so the shipped path makes no LLM call.

## Findings

### 1. Archify is an offline renderer

Archify is not a graph library. It has no browser API: every render is a child process that turns JSON into a complete HTML file of about 800 KB, containing inline SVG and the viewer JS. It also has no auto-layout. Every component needs `pos` or a grid `row`/`col`.

### 2. Its checker is strict, and the checker is the real contract

`deliver` runs layout checks with no lenient mode. `standard` is the floor, and `edge-through-node` is enforced as "a correctness invariant". The first converter attempt was rejected for:
- labels wider than the default 120px component
- an edge drawn through an unrelated component
- an edge label drawn over a component

The corridor, merge and turn-room checks (`geometry.mjs:517-563`) apply as well. To pass them, the converter had to:
- size components explicitly (190x64) and clip labels to 22 characters;
- order the kind bands so every edge points right. ENIs go before workloads, and consumer groups before topics;
- give each subnet or VPC its own row block, so a boundary's bounding box never takes in another group's component;
- route same-column and column-skipping edges through the grid gutters with explicit `via` points, and drop their labels, because a gutter is narrower than a label.

With those changes both synthetic fixtures render, and after the fixes in section 4 so do both real topologies. However, the routed edges share gutter lanes, so the corridor checks are the likely next rejection. Whether they fire is decided by the checker, not by the converter.

### 3. The LLM path works but is slow

Live test (`ARCHIFY_LIVE=1`, application fixture of 6 nodes and 4 edges, Sonnet 5 via Bedrock with Haiku 4.5 as fallback):
- **ok after 2 attempts** (one repair round driven by Archify diagnostics)
- **106 s** wall time

The system prompt is about 11k tokens (SKILL.md sections, the authoring contract, two schemas, one example) and is cached. Every repair round is another full generation.

### 4. Live turn

One real incident turn was run on an isolated dev instance (port 5174). Datasources were Elastic, Kafka and AWS across 7 production estates. The turn produced:
- **Network map:** 200 nodes, capped (`truncated`), and 210 edges. Kinds: 92 DNS records, 36 target groups, 27 workloads, 27 subnets, 15 load balancers, 3 VPCs.
- **Application map:** 38 nodes and 41 edges. Kinds: 15 services, 10 topics, 9 dependencies, 4 consumer groups.

The real topologies were dumped to the gitignored `experiments/archify-spike/out/` and replayed offline. The repo is public, so none of that data is committed here.

**Converter on real data.** It took three fix rounds before both renders passed:
1. The network map's final artifact check failed with no classified diagnostic. The cause is an upstream Archify bug: the checker prints about 2.9 MB of JSON for 200 nodes, and `spawnSync`'s default 1 MB `maxBuffer` then fails with ENOBUFS. The vendored copy now carries a local patch for this (`vendor/archify/VENDORED.md`). It is worth reporting upstream.
2. The application map had 16 label-over-component rejections. Labels on edges between adjacent columns sat near the source, over the neighbouring component.
3. The fix was a wider gutter (130px) and each label pinned to the gutter centre (`labelAt`). After that, both real topologies pass `deliver` with zero diagnostics.

**LLM on real data.** Neither topology rendered:

| Topology | Result | Wall time | Tokens |
|---|---|---|---|
| Application, 38 nodes | truncated at the 32,768-token output cap, attempt 1 | 328 s | 18,480 in / 32,768 out |
| Network, 200 nodes | truncated at the 32,768-token output cap, attempt 1 | 339 s | 60,131 in / 32,768 out |

These runs used a 600 s deadline (`AGENT_LLM_TIMEOUT_DIAGRAM_AUTHOR_MS`). Under the default 120 s deadline, both failed in the UI with `DeadlineExceededError`. So did the 13-node synthetic network fixture. The route now returns that error as a 422, and the tab shows the message.

For comparison, the 6-node application fixture succeeded in 106 s with 2 attempts (see 3 above).

A note on cost: the cache wrote 13,292 tokens of system prompt on each run, and each run read 0 from it, because the two runs started at the same moment.

**UI.** Verified on the 5174 instance with the flag on:
- The tabs appear only when `GET /api/diagram` reports the flag as enabled.
- The converter tab renders in about 1.2 s. That includes a cold compile after a hot reload; a CLI render on its own takes about 165 ms.
- The LLM tab shows a spinner, then the deadline error.
- The ECharts map stays mounted underneath, and the text view is unchanged.

A caveat on the screenshots: the browser pane's capture does not paint an opaque-origin (sandboxed, no `allow-same-origin`) iframe. A probe from inside the frame confirmed the SVG is laid out (375x230, no hidden ancestors). Temporarily adding `allow-same-origin` made it visible to the capture. Real browsers render sandboxed srcdoc frames normally, but a person should look once in a normal browser before this goes further.

### 5. Converter cost

The converter plus render takes about 165 ms per fixture, the time for one CLI child process. There is no model cost.

### 6. Closing the gap with the Archify gallery

The first real render of the 200-node network map was a 12,976 px tall page, and 140 of its 363 labels were cut off. The [Archify gallery](https://tt-a1i.github.io/archify/gallery.html) examples are 7-12 hand-laid-out nodes each. Two changes were made:

- **Style:** `meta.visual_preset: "signal-flow"` (the gallery's look).
- **Focused view** (`focus.ts`), drawing at most 16 components:
  - DNS records that alias the same target are merged into one node. On the live map, 56 records pointed at 11 targets, 20 of them at one ALB.
  - The drawing then expands outward from the nodes linked to a focus service, taking each node together with up to 4 of its busiest neighbours.
  - When the seeds' neighbourhoods run out, it continues from the busiest remaining hub. The live network map's 6 focus-linked workloads had no traffic edges at all.
  - The subnet and VPC of every kept node are kept, so their boundaries still draw.
  - The subtitle says "N of M nodes ... all on the Map tab", and a map that already fits is drawn whole.

Result on the live topologies:

| Map | Size | Boxes | Connections | Boundaries | Notes |
|---|---|---|---|---|---|
| Network | 1,636 px tall (was 12,976) | 16 | 8 | 7 | The 6 focus workloads are each unconnected in their own subnet |
| Application | fits one screen | 16 | 16 | 0 | 1 box unconnected |

Two early versions of the rule failed on real data:
- Plain breadth-first search gave the network map 6 unconnected boxes.
- With no fan-out cap, one ALB spent the whole budget on a star of 15 target groups.

Views and lane labels (the gallery's "01 / User Interface" bands and named chapters) were not added.

## What you give up compared with the ECharts cards

- **Interaction.** ECharts has zoom, pan and hover tooltips on every node. Archify's viewer offers focus, routes, lenses and export instead. These are good for reading one diagram, but the tooltip detail (health, CIDR, error rate) must now fit into a 22-character label, a sublabel or a tag.
- **Edge labels on routed edges.** The converter drops them. The LLM keeps them but moves them.
- **Scale.** The builders cap topologies at 200 network nodes and 150 application nodes (`MAX_NODES`). A banded grid of 200 nodes is a very tall page. An LLM authoring 200 positioned components is well past what this spike showed works.
- **Theme.** A srcdoc iframe has no URL query, so `?theme=` / `?embed=1` do nothing. `embedHtml` shims `matchMedia` instead, which is fragile against upstream changes.

## Recommendation

**Do not replace the ECharts cards with Archify. Drop the LLM mode.** (Done in this PR: only the converter ships, behind the flag.)

1. **The LLM path does not work for this data.** A 38-node map fills Sonnet 5's entire 32k output budget and is still unfinished after 5.5 minutes. A diagram that takes minutes to produce, or never arrives, is no use during an incident. It could only work for tiny maps (10 nodes or fewer), or as an offline postmortem artifact with a much larger budget. Neither is what these cards are for.
2. **The deterministic converter works, is free, and is fast** (about 165 ms per render). Both real topologies now pass Archify's strict checker. But it passes only because it hand-routes around the checker, and every new topology shape can hit a check it has not seen yet (corridor sharing is the next likely one). It also gives up the interaction responders use: hover detail, zoom and pan.
3. **If the Archify look is wanted, keep it as an add-on, not a replacement.** The converter stays behind the flag as an extra "Diagram" view or an export for a postmortem or ticket, and ECharts remains the primary view. That is the current wiring, minus the LLM tab.

If that add-on route is taken, the follow-ups are:
- report the `maxBuffer` bug upstream;
- decide on vendoring (about 2 MB, with one local patch) versus a pinned git dependency;
- run a readability check with a real on-call engineer on the 200-node network render;
- ~~remove `describe.ts`, the `diagramAuthor` role and the LLM tab~~ (done).

## Verification run

```bash
cd apps/web && bun run test                      # 576 pass, 0 fail
cd packages/agent && bun run test                # 5172 pass, 0 fail
cd apps/web && bunx svelte-check --threshold error   # 0 errors
```
