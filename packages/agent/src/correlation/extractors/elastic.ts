// packages/agent/src/correlation/extractors/elastic.ts
// SIO-785 follow-up (2026-05-18): minimal Elastic findings extractor. Today
// surfaces synthetic monitor status from elasticsearch_search queries against
// the synthetics-* index pattern. The SOUL's Synthetic-Monitor Cross-Check rule
// (SIO-717) mandates these queries during Confluent outage investigation, so
// the underlying response shape is stable across runs.
//
// Extend with new branches when other deterministic signals stabilise (APM
// service summary, top error log clusters, etc.). Each new branch should pull
// from a specific ES index pattern + query type so the schema stays tight.
import type { ElasticFindings, ElasticSyntheticMonitor, ToolOutput } from "@devops-agent/shared";
import { z } from "zod";

// Elasticsearch hit envelope.
const HitSchema = z.object({
	_source: z.unknown(),
});
const SearchResponseSchema = z.object({
	hits: z.object({
		hits: z.array(HitSchema),
	}),
});

// Synthetic monitor document subset we surface in the card.
const SyntheticHitSourceSchema = z.object({
	monitor: z.object({
		name: z.string(),
		status: z.string(),
	}),
	url: z
		.object({
			full: z.string().optional(),
		})
		.optional(),
	"@timestamp": z.string().optional(),
	observer: z
		.object({
			geo: z
				.object({
					name: z.string().optional(),
				})
				.optional(),
		})
		.optional(),
});

function looksLikeSyntheticIndex(o: ToolOutput): boolean {
	// SIO-717: the SOUL pattern is `synthetics-*`. Soft-detect via the index
	// or query arg if the agent included it in toolArgs (typical via MCP).
	const args = (o as unknown as { toolArgs?: Record<string, unknown> }).toolArgs;
	if (args && typeof args === "object") {
		const index = (args as { index?: unknown }).index;
		if (typeof index === "string" && /synthetics?/i.test(index)) return true;
	}
	// Fallback: any search hit whose _source has monitor.status counts.
	return false;
}

export function extractElasticFindings(outputs: ToolOutput[]): ElasticFindings {
	const monitorsByName = new Map<string, ElasticSyntheticMonitor>();

	for (const o of outputs) {
		if (o.toolName !== "elasticsearch_search") continue;
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
