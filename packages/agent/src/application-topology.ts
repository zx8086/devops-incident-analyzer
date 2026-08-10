// agent/src/application-topology.ts
// SIO-1457: pure per-turn application-map builder -- the service-to-service layer
// above the SIO-1204 network map. Parses the turn's toolOutputs[] (elastic APM
// destination aggregation + kafka consumer-group tools) into the shared
// ApplicationTopology shape. Called TWICE per turn because `aggregate` runs before
// `extractFindings` (same double-build convention as network-topology.ts): once in
// aggregate for the prompt summary, once in extractFindings for the state slot +
// SSE event. Must therefore stay pure, cheap, and total: malformed outputs are
// skipped via safeParse, never thrown on. The KG prior-knowledge overlay is
// deliberately NOT read here (pure/sync contract) -- graphEnrich populates
// state.applicationTopologyOverlay and extractFindings merges it via
// mergeApplicationTopologyOverlay below.
import type {
	ApplicationTopology,
	ApplicationTopologyEdge,
	ApplicationTopologyNode,
	DataSourceResult,
	ToolOutput,
} from "@devops-agent/shared";
import { z } from "zod";
import { matchesFocus } from "./correlation/focus-match.ts";

export const MAX_NODES = 150;
export const MAX_EDGES = 300;

// Elastic MCP aggregation responses arrive as a prefixed text payload
// ("Search results with aggregations (...):\n\n{...}") joined by
// normalizeToolContent, so rawJson is frequently a STRING. Same brace-balanced
// extraction as correlation/extractors/elastic.ts (module-private there; the
// per-turn-map builders own their tool-output parsing, per the network-topology
// precedent of duplicating extractor row shapes locally).
function extractRootJson(rawJson: unknown): unknown {
	if (typeof rawJson !== "string") return rawJson;
	const firstBrace = rawJson.indexOf("{");
	if (firstBrace === -1) return undefined;
	let depth = 0;
	let inString = false;
	let escaped = false;
	let end = -1;
	for (let i = firstBrace; i < rawJson.length; i++) {
		const ch = rawJson[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
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
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	if (end === -1) return undefined;
	try {
		return JSON.parse(rawJson.slice(firstBrace, end + 1));
	} catch {
		return undefined;
	}
}

// Tolerate both the full ES envelope (aggregations.<agg>) and the unwrapped
// root shape (<agg> at top level), same as parseApmAggregationFromJson.
function aggregationRoot(rawJson: unknown): unknown {
	const body = extractRootJson(rawJson);
	if (!body || typeof body !== "object") return undefined;
	return (body as { aggregations?: unknown }).aggregations ?? body;
}

// SIO-1457: the APM destination-service aggregation (span.destination.service.resource
// bucketed under service.name) -- the runtime call graph. ToolOutput carries no args,
// so detection is purely structural on this response shape.
const DestinationBucketSchema = z.object({
	key: z.string(),
	doc_count: z.number(),
	avg_duration: z.object({ value: z.number().nullable().optional() }).optional(),
	error_count: z.object({ doc_count: z.number().optional() }).optional(),
});
const SourceBucketSchema = z.object({
	key: z.string(),
	doc_count: z.number(),
	by_destination: z.object({ buckets: z.array(DestinationBucketSchema) }),
});
const DestinationAggSchema = z.object({
	by_source: z.object({ buckets: z.array(SourceBucketSchema) }),
});

// The flat per-service health aggregation the elastic sub-agent already runs for
// apmByName findings (by_service terms agg) -- reused here purely to tint
// service nodes with errorRate/avgDurationMs, never to create edges.
const HealthBucketSchema = z.object({
	key: z.string(),
	doc_count: z.number(),
	avg_duration: z.object({ value: z.number().nullable().optional() }).optional(),
	errors: z.object({ doc_count: z.number().optional() }).optional(),
});
const HealthAggSchema = z.object({
	by_service: z.object({ buckets: z.array(HealthBucketSchema) }),
});

const DescribeConsumerGroupSchema = z.object({
	groupId: z.string(),
	state: z.string().optional(),
	offsets: z.array(z.object({ topic: z.string() })).optional(),
});
const ConsumerGroupLagSchema = z.object({
	groupId: z.string(),
	groupState: z.string().optional(),
	topics: z.array(z.object({ topic: z.string(), totalLag: z.string().optional() })).optional(),
});
const ListedGroupSchema = z.object({ id: z.string(), state: z.string().optional() });

interface Accumulator {
	nodes: Map<string, ApplicationTopologyNode>;
	edges: Map<string, ApplicationTopologyEdge>;
	sources: Set<string>;
}

// Merge-not-clobber (same rule as network-topology.ts): a later sighting of the
// same node fills gaps without erasing earlier fields.
function upsertNode(acc: Accumulator, node: ApplicationTopologyNode): void {
	const existing = acc.nodes.get(node.id);
	if (!existing) {
		acc.nodes.set(node.id, node);
		return;
	}
	const merged: ApplicationTopologyNode = { ...existing };
	for (const [k, v] of Object.entries(node)) {
		if (v === undefined) continue;
		const key = k as keyof ApplicationTopologyNode;
		if (merged[key] === undefined) {
			(merged as Record<string, unknown>)[key] = v;
		}
	}
	acc.nodes.set(node.id, merged);
}

function addEdge(acc: Accumulator, edge: ApplicationTopologyEdge): void {
	const key = `${edge.kind}|${edge.from}|${edge.to}`;
	const existing = acc.edges.get(key);
	if (!existing) {
		acc.edges.set(key, edge);
		return;
	}
	// An observed-this-turn sighting always wins over a prior-knowledge overlay
	// duplicate of the same edge: the merged edge stays priorKnowledge only when
	// BOTH sightings were overlay-sourced, and the EXISTING detail is preferred
	// (CodeRabbit PR #644: overlay edges arrive after observed ones, so an
	// incoming-priority detail would let a KG discoveredBy stamp overwrite this
	// turn's observed latency/error text). Incoming detail only fills a gap.
	const detail = existing.detail ?? edge.detail;
	const merged: ApplicationTopologyEdge = { from: existing.from, to: existing.to, kind: existing.kind };
	if (detail !== undefined) merged.detail = detail;
	if (existing.priorKnowledge === true && edge.priorKnowledge === true) merged.priorKnowledge = true;
	acc.edges.set(key, merged);
}

export function serviceNodeId(name: string): string {
	return `svc:${name}`;
}
export function topicNodeId(name: string): string {
	return `topic:${name}`;
}
export function consumerGroupNodeId(groupId: string): string {
	return `cg:${groupId}`;
}
export function dependencyNodeId(resource: string): string {
	return `dep:${resource}`;
}

// SIO-1460: per-locale storefront hosts (www.calvinklein.de:443, .fr:443, ...) are
// ONE logical dependency each. Host-shaped destinations group by an approximate
// registrable domain so the family renders as one node; everything else
// (postgresql, redis, bare hostnames, IP literals) passes through unchanged. The
// grouping is display-only -- dep: ids never reach the KG (application-topology-kg.ts).
const TWO_PART_SLD = new Set(["co", "com", "org", "net", "gov", "edu", "ac"]);

function parseHost(resource: string): { host: string; port?: string } | undefined {
	const r = resource.trim();
	const m = /^([a-z0-9.-]+?)(?::(\d+))?$/i.exec(r);
	const host = m?.[1];
	if (!host) return undefined;
	if (!host.includes(".")) return undefined; // bare single-label -> not a family
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return undefined; // IPv4 literal -> not a family
	if (!/[a-z]/i.test(host)) return undefined; // no letters -> not a hostname
	return { host, port: m?.[2] };
}

// Approximate registrable domain: last two labels, three when the penultimate label
// is a known two-part public suffix followed by a 2-letter ccTLD (co.uk, com.au).
function registrableDomain(host: string): string {
	const labels = host.toLowerCase().split(".").filter(Boolean);
	if (labels.length <= 2) return labels.join(".");
	const a = labels[labels.length - 2] ?? "";
	const b = labels[labels.length - 1] ?? "";
	if (TWO_PART_SLD.has(a) && b.length === 2) return labels.slice(-3).join(".");
	return labels.slice(-2).join(".");
}

// Rename the provisional dep:<family> nodes to "<family> (N hosts)" once every
// member host is known. Direct acc.nodes.set (NOT upsertNode): merge-not-clobber
// would keep the provisional name. Membership is keyed on normalized host, so N is
// the distinct-host count; a single-host family reads better as its raw endpoint.
function collapseHostFamilies(acc: Accumulator, familyMembers: Map<string, Map<string, string>>): void {
	for (const [family, hosts] of familyMembers) {
		const id = dependencyNodeId(family);
		const node = acc.nodes.get(id);
		if (!node) continue;
		const name = hosts.size > 1 ? `${family} (${hosts.size} hosts)` : [...hosts.values()][0];
		acc.nodes.set(id, { ...node, name });
	}
}

// SIO-1460: message-bus / in-process span.destination.service.resource values get
// special handling instead of one node per destination string:
//  - kafka*   : SKIP -- kafka edges come from the kafka datasource's consumer-group
//               tools; a producer-side guess from APM would conflict with the
//               deliberate PRODUCES_TO absence (no system of record).
//  - vert.x/* : SKIP -- an in-process event-bus address, never a network dependency.
//  - AMQP ... : COLLAPSE to one dep:amqp-bus broker node. RabbitMQ has no
//               consumer-group system of record (unlike kafka), so a single broker
//               node keeps its presence on the map instead of one node per
//               per-entity sync queue (observed live as "AMQP 1.0/ddm.contact.sync").
export const AMQP_BUS_ID = "dep:amqp-bus";

function busDestinationKind(resource: string): "skip" | "amqp" | undefined {
	const r = resource.trim();
	// The [/:]|$ tail matches every bus-address form (kafka/orders, kafka://broker,
	// kafka:9092, bare kafka) without swallowing real names that merely start with
	// the prefix (kafkacat-service, vert.xyz.com). Both are case-insensitive.
	if (/^kafka(?:[/:]|$)/i.test(r) || /^vert\.x(?:[/:]|$)/i.test(r)) return "skip";
	if (/^amqp\b/i.test(r)) return "amqp";
	return undefined;
}

function edgeDetail(avgUs: number | null | undefined, errors: number | undefined, calls: number): string | undefined {
	const parts: string[] = [];
	if (avgUs !== undefined && avgUs !== null) parts.push(`avg ${Math.round(avgUs / 1000)}ms`);
	// SIO-787 idiom: divide-by-zero guard, never emit 0/0.
	if (errors !== undefined && calls > 0) parts.push(`${((errors / calls) * 100).toFixed(1)}% err`);
	return parts.length > 0 ? parts.join(", ") : undefined;
}

// SIO-1457 (CodeRabbit PR #644): the baseline-skip check in sub-agent.ts must use
// the SAME structural detection as the builder -- a substring probe misses
// object-shaped rawJson (buildPersistedToolOutput preserves structured JSON) and
// false-positives on unrelated text containing "by_destination".
export function hasDestinationAggregation(rawJson: unknown): boolean {
	const root = aggregationRoot(rawJson);
	return root !== undefined && DestinationAggSchema.safeParse(root).success;
}

function parseElasticOutputs(
	acc: Accumulator,
	outputs: ToolOutput[],
	focus: string[],
	familyMembers: Map<string, Map<string, string>>,
): void {
	for (const o of outputs) {
		if (o.toolName !== "elasticsearch_search" && o.toolName !== "elasticsearch_multi_search") continue;
		const root = aggregationRoot(o.rawJson);
		if (!root) continue;

		const dest = DestinationAggSchema.safeParse(root);
		if (dest.success) {
			const sourceNames = new Set(dest.data.by_source.buckets.map((b) => b.key));
			for (const src of dest.data.by_source.buckets) {
				const srcId = serviceNodeId(src.key);
				upsertNode(acc, {
					id: srcId,
					kind: "service",
					name: src.key,
					service: matchesFocus(src.key, focus) ? src.key : undefined,
				});
				for (const d of src.by_destination.buckets) {
					const resource = d.key.trim();
					if (resource.length === 0) continue;
					const bus = busDestinationKind(resource);
					if (bus === "skip") continue;
					const detail = edgeDetail(d.avg_duration?.value, d.error_count?.doc_count, d.doc_count);
					if (bus === "amqp") {
						upsertNode(acc, { id: AMQP_BUS_ID, kind: "dependency", name: "AMQP broker" });
						addEdge(acc, { from: srcId, to: AMQP_BUS_ID, kind: "calls", detail });
						continue;
					}
					// A destination naming another instrumented service (or a focus
					// service) is a service-to-service call; anything else (postgresql,
					// redis, external hosts) is a datastore/external dependency. The
					// focus check is gated on a NON-EMPTY focus list: matchesFocus([])
					// matches everything (the SIO-1030 empty-collapse contract), which
					// would misclassify every datastore as a service.
					if (sourceNames.has(resource) || (focus.length > 0 && matchesFocus(resource, focus))) {
						const dstId = serviceNodeId(resource);
						upsertNode(acc, {
							id: dstId,
							kind: "service",
							name: resource,
							service: matchesFocus(resource, focus) ? resource : undefined,
						});
						addEdge(acc, { from: srcId, to: dstId, kind: "calls", detail });
					} else {
						const parsed = parseHost(resource);
						if (parsed) {
							// Host-shaped: route the edge at the family node now, record the host
							// for the post-loop "(N hosts)" rename. Membership is keyed on the
							// normalized host (lowercased, port-stripped) so api.example.com:443 and
							// :8443 count as ONE host; the raw endpoint is kept for the single-host
							// display name. addEdge dedups on kind|from|to, so multiple hosts of one
							// family from one source collapse to a single edge.
							const family = registrableDomain(parsed.host);
							const dstId = dependencyNodeId(family);
							const hosts = familyMembers.get(family) ?? new Map<string, string>();
							const hostKey = parsed.host.toLowerCase();
							if (!hosts.has(hostKey)) hosts.set(hostKey, resource);
							familyMembers.set(family, hosts);
							upsertNode(acc, { id: dstId, kind: "dependency", name: family });
							addEdge(acc, { from: srcId, to: dstId, kind: "calls", detail });
						} else {
							const dstId = dependencyNodeId(resource);
							upsertNode(acc, { id: dstId, kind: "dependency", name: resource });
							addEdge(acc, { from: srcId, to: dstId, kind: "calls", detail });
						}
					}
				}
			}
		}

		const health = HealthAggSchema.safeParse(root);
		if (health.success) {
			for (const b of health.data.by_service.buckets) {
				const node: ApplicationTopologyNode = {
					id: serviceNodeId(b.key),
					kind: "service",
					name: b.key,
					transactionCount: b.doc_count,
					service: matchesFocus(b.key, focus) ? b.key : undefined,
				};
				if (b.doc_count > 0 && b.errors?.doc_count !== undefined) {
					node.errorRate = b.errors.doc_count / b.doc_count;
				}
				if (b.avg_duration?.value !== undefined && b.avg_duration.value !== null) {
					node.avgDurationMs = b.avg_duration.value / 1000;
				}
				upsertNode(acc, node);
			}
		}
	}
}

function upsertConsumerGroup(acc: Accumulator, groupId: string, state: string | undefined, focus: string[]): string {
	const id = consumerGroupNodeId(groupId);
	upsertNode(acc, {
		id,
		kind: "consumerGroup",
		name: state ? `${groupId} (${state})` : groupId,
		service: matchesFocus(groupId, focus) ? groupId : undefined,
	});
	return id;
}

function parseKafkaOutputs(acc: Accumulator, outputs: ToolOutput[], focus: string[]): void {
	for (const o of outputs) {
		if (o.toolName === "kafka_describe_consumer_group") {
			const p = DescribeConsumerGroupSchema.safeParse(extractRootJson(o.rawJson));
			if (!p.success) continue;
			const cgId = upsertConsumerGroup(acc, p.data.groupId, p.data.state, focus);
			for (const { topic } of p.data.offsets ?? []) {
				upsertNode(acc, { id: topicNodeId(topic), kind: "kafkaTopic", name: topic });
				addEdge(acc, { from: cgId, to: topicNodeId(topic), kind: "consumes" });
			}
		} else if (o.toolName === "kafka_get_consumer_group_lag") {
			const p = ConsumerGroupLagSchema.safeParse(extractRootJson(o.rawJson));
			if (!p.success) continue;
			const cgId = upsertConsumerGroup(acc, p.data.groupId, p.data.groupState, focus);
			for (const t of p.data.topics ?? []) {
				upsertNode(acc, { id: topicNodeId(t.topic), kind: "kafkaTopic", name: t.topic });
				const lag = t.totalLag !== undefined && t.totalLag !== "0" ? `lag ${t.totalLag}` : undefined;
				addEdge(acc, { from: cgId, to: topicNodeId(t.topic), kind: "consumes", detail: lag });
			}
		} else if (o.toolName === "kafka_list_consumer_groups") {
			// Text content is the bare array; structuredContent wraps it as
			// { groups: [...] } (MCP wire constraint) -- tolerate both.
			const body = extractRootJson(o.rawJson) ?? o.rawJson;
			const groups = Array.isArray(body)
				? body
				: typeof body === "object" && body !== null && Array.isArray((body as { groups?: unknown }).groups)
					? (body as { groups: unknown[] }).groups
					: [];
			for (const raw of groups) {
				const p = ListedGroupSchema.safeParse(raw);
				if (!p.success) continue;
				// Enrichment only: a listed group carries no topic linkage, so it
				// contributes a node (state label) but never an edge.
				upsertConsumerGroup(acc, p.data.id, p.data.state, focus);
			}
		}
	}
}

// SIO-1460: on focused turns keep focus-anchored nodes (ANY node with `service`
// set -- svc: AND cg:) plus their 1-hop neighborhood; drop the rest. No-op on
// unfocused turns (matchesFocus([]) anchors everything -> show-all). An empty anchor
// set (focus matched nothing in this map) falls back to show-all: scoping to nothing
// must never blank a card that has real data (the SIO-1030 empty-collapse contract).
function scopeToFocus(acc: Accumulator, focusServices: string[]): void {
	if (focusServices.length === 0) return;
	const anchors = new Set<string>();
	for (const n of acc.nodes.values()) if (n.service !== undefined) anchors.add(n.id);
	if (anchors.size === 0) return;
	const keep = new Set(anchors);
	for (const e of acc.edges.values()) {
		if (anchors.has(e.from)) keep.add(e.to);
		if (anchors.has(e.to)) keep.add(e.from);
	}
	if (keep.size === acc.nodes.size) return;
	for (const id of [...acc.nodes.keys()]) if (!keep.has(id)) acc.nodes.delete(id);
	for (const [k, e] of [...acc.edges]) if (!keep.has(e.from) || !keep.has(e.to)) acc.edges.delete(k);
}

function capTopology(acc: Accumulator, turn: number): ApplicationTopology | undefined {
	if (acc.nodes.size === 0) return undefined;
	let truncated = false;
	let nodes = Array.from(acc.nodes.values());
	if (nodes.length > MAX_NODES) {
		// SIO-1460: rank before slicing so the LEAST relevant nodes are dropped, not
		// whatever landed last in insertion order. Rank: focus anchor (service set) >
		// kind:"service" > degree desc (edges touching the node) > insertion order
		// (stable tie-break). Also runs on the overlay cap path (shared) -- harmless,
		// overlay sets are small.
		const degree = new Map<string, number>();
		for (const e of acc.edges.values()) {
			degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
			degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
		}
		const rank = (n: ApplicationTopologyNode): number =>
			(n.service !== undefined ? 4 : 0) + (n.kind === "service" ? 2 : 0);
		nodes = nodes
			.map((n, i) => ({ n, i }))
			.sort((a, b) => rank(b.n) - rank(a.n) || (degree.get(b.n.id) ?? 0) - (degree.get(a.n.id) ?? 0) || a.i - b.i)
			.slice(0, MAX_NODES)
			.map((x) => x.n);
		truncated = true;
	}
	const keptIds = new Set(nodes.map((n) => n.id));
	let edges = Array.from(acc.edges.values()).filter((e) => keptIds.has(e.from) && keptIds.has(e.to));
	if (edges.length > MAX_EDGES) {
		edges = edges.slice(0, MAX_EDGES);
		truncated = true;
	}
	return {
		builtAtTurn: turn,
		sources: Array.from(acc.sources),
		nodes,
		edges,
		...(truncated && { truncated }),
	};
}

export function buildApplicationTopology(
	results: DataSourceResult[],
	focusServices: string[],
	turn = 0,
): ApplicationTopology | undefined {
	const acc: Accumulator = { nodes: new Map(), edges: new Map(), sources: new Set() };
	const familyMembers = new Map<string, Map<string, string>>();
	for (const r of results) {
		const outputs = r.toolOutputs ?? [];
		if (outputs.length === 0) continue;
		const before = acc.nodes.size;
		if (r.dataSourceId === "elastic") {
			parseElasticOutputs(acc, outputs, focusServices, familyMembers);
		} else if (r.dataSourceId === "kafka") {
			parseKafkaOutputs(acc, outputs, focusServices);
		}
		if (acc.nodes.size > before) acc.sources.add(r.dataSourceId);
	}
	collapseHostFamilies(acc, familyMembers);
	scopeToFocus(acc, focusServices);
	return capTopology(acc, turn);
}

// Node kind inferred from the id prefix contract shared with the graphEnrich
// overlay producer (graph-knowledge.ts): svc:/topic:/cg:/aws:/dep:/route:.
// "route:" renders as a service-kind node (an ApiRoute from a KG ROUTES_TO edge;
// a real apiRoute kind is deferred until Konnect is in scope).
function nodeFromOverlayId(id: string): ApplicationTopologyNode {
	if (id.startsWith("topic:")) return { id, kind: "kafkaTopic", name: id.slice(6) };
	if (id.startsWith("cg:")) return { id, kind: "consumerGroup", name: id.slice(3) };
	if (id.startsWith("aws:")) return { id, kind: "awsResource", name: id.slice(4).split("/").pop() };
	if (id.startsWith("dep:")) return { id, kind: "dependency", name: id.slice(4) };
	if (id.startsWith("route:")) return { id, kind: "service", name: id.slice(6) };
	return { id, kind: "service", name: id.startsWith("svc:") ? id.slice(4) : id };
}

// Union the KG prior-knowledge overlay (graphEnrich) into this turn's built map.
// Overlay-only turns still render (dashed edges), so the card can show what the
// KG already knows even when this turn's tools produced no app-level output.
export function mergeApplicationTopologyOverlay(
	built: ApplicationTopology | undefined,
	overlay: ApplicationTopologyEdge[],
	turn = 0,
): ApplicationTopology | undefined {
	if (overlay.length === 0) return built;
	const acc: Accumulator = {
		nodes: new Map((built?.nodes ?? []).map((n) => [n.id, n])),
		edges: new Map((built?.edges ?? []).map((e) => [`${e.kind}|${e.from}|${e.to}`, e])),
		sources: new Set(built?.sources ?? []),
	};
	for (const edge of overlay) {
		upsertNode(acc, nodeFromOverlayId(edge.from));
		upsertNode(acc, nodeFromOverlayId(edge.to));
		addEdge(acc, { ...edge, priorKnowledge: true });
	}
	acc.sources.add("knowledge-graph");
	const merged = capTopology(acc, built?.builtAtTurn ?? turn);
	if (merged && built?.truncated) merged.truncated = true;
	return merged;
}

const MAX_PROMPT_LINES = 20;

// Compact call-graph text for the aggregate prompt. The full map renders as a
// card in the UI; the prompt only needs enough to ground root-cause reasoning.
// Prior-knowledge overlay edges are skipped -- the aggregate prompt deliberately
// excludes KG content (SIO-1026/1027 enrichment-seam rule), and aggregate's
// re-run of the pure builder never sees the overlay anyway.
export function summarizeApplicationTopologyForPrompt(topology: ApplicationTopology): string {
	const byId = new Map(topology.nodes.map((n) => [n.id, n]));
	const label = (id: string): string => byId.get(id)?.name ?? id;
	const lines: string[] = [];

	for (const e of topology.edges) {
		if (e.priorKnowledge || e.kind !== "calls") continue;
		const target = byId.get(e.to);
		const dep = target?.kind === "dependency" ? " [dependency]" : "";
		lines.push(`- ${label(e.from)} -> ${label(e.to)}${dep}${e.detail ? ` (${e.detail})` : ""}`);
	}

	const topicsByGroup = new Map<string, { topic: string; detail?: string }[]>();
	for (const e of topology.edges) {
		if (e.priorKnowledge || e.kind !== "consumes") continue;
		const list = topicsByGroup.get(e.from) ?? [];
		list.push({ topic: label(e.to), detail: e.detail });
		topicsByGroup.set(e.from, list);
	}
	for (const [groupId, topics] of topicsByGroup) {
		const rendered = topics.map((t) => (t.detail ? `${t.topic} (${t.detail})` : t.topic)).join(", ");
		lines.push(`- ${label(groupId)} consumes ${rendered}`);
	}

	const unhealthy = topology.nodes.filter((n) => n.kind === "service" && n.errorRate !== undefined && n.errorRate > 0);
	for (const n of unhealthy) {
		lines.push(`- ${n.name ?? n.id}: ${((n.errorRate ?? 0) * 100).toFixed(1)}% error rate`);
	}

	if (lines.length > MAX_PROMPT_LINES) {
		const hidden = lines.length - (MAX_PROMPT_LINES - 1);
		return [...lines.slice(0, MAX_PROMPT_LINES - 1), `- ... (+${hidden} more lines)`].join("\n");
	}
	return lines.join("\n");
}
