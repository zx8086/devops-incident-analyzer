// agent/src/normalizer.ts

import { getLogger } from "@devops-agent/observability";
import type { InvestigationFocus, NormalizedIncident } from "@devops-agent/shared";
import { DATA_SOURCE_IDS } from "@devops-agent/shared";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { createLlm } from "./llm.ts";
import { withKeyAliases } from "./llm-json.ts";
import { parseLlmJsonWithCorrection } from "./llm-json-retry.ts";
import { contentBlockTypes, extractTextFromContent } from "./message-utils.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:normalizer");

// LLMs often return null instead of omitting fields, and numbers instead of strings
// for metric values. Coerce and strip nulls to handle this gracefully.
const coerceNullableString = z
	.union([z.string(), z.number(), z.null()])
	.transform((v) => (v === null || v === undefined ? undefined : String(v)))
	.optional();

const NormalizationObject = z.object({
	severity: z
		.enum(["critical", "high", "medium", "low"])
		.nullish()
		.transform((v) => v ?? undefined),
	timeWindow: z
		.object({ from: z.string(), to: z.string() })
		.nullish()
		.transform((v) => v ?? undefined),
	affectedServices: z
		.array(
			z.object({
				name: z.string(),
				namespace: coerceNullableString,
				deployment: coerceNullableString,
			}),
		)
		.nullish()
		.transform((v) => v ?? undefined),
	extractedMetrics: z
		.array(
			z.object({
				name: z.union([z.string(), z.number()]).transform(String),
				value: coerceNullableString,
				threshold: coerceNullableString,
			}),
		)
		.nullish()
		.transform((v) => v ?? undefined),
});

// SIO-1233: every field here is .nullish(), which is correct (see the "do not make fields
// required" note below) but means an envelope drift that would LOUDLY fail the entity
// extractor validates cleanly here and degrades to serviceCount: 0 in silence. Aliases remove
// the most common cause; the recovery pass below catches what is left.
//
// Note what these aliases can and cannot do. They fix a MISSPELLED key. They cannot fix a
// WRAPPED payload: parseLlmJson's single-key unwrap only fires when validation FAILS, and an
// all-nullish schema never fails -- {"incident":{...}} parses vacuously to an empty object.
// That path is covered by extractServiceCandidates, not here. Pinned by a test in
// normalizer-sanitize.test.ts so this stays true if the schema's optionality ever changes.
// Exported for the SIO-1233 regression tests (see entity-extractor.ts for the rationale).
export const NormalizationSchema = withKeyAliases(NormalizationObject, {
	affected_services: "affectedServices",
	extracted_metrics: "extractedMetrics",
	time_window: "timeWindow",
});

const NORMALIZATION_KEYS = ["severity", "timeWindow", "affectedServices", "extractedMetrics"] as const;

// SIO-1221: moved to llm-json.ts so all thirteen LLM-JSON parse sites share it, not just
// this one. Re-exported here because normalizer-sanitize.test.ts and prior callers import
// it from this module.
export { sanitizeJsonControlChars } from "./llm-json.ts";

// Service-shaped: at least two segments joined by - _ or . ("prana-order-service", "orders.api").
// A single bare word is deliberately NOT a candidate -- "checkout" or "database" in prose would
// seed a focus that scopes the whole investigation to a word the user never meant as a service.
const SERVICE_TOKEN = /^[a-z0-9]+(?:[-_.][a-z0-9]+)+$/i;
// Bare AND pre-release versions: "1.2.3", "v1.2.3", "1.2.3-rc1", "2.0.0-beta.1". The original
// `^\d+(\.\d+)+$` missed every pre-release form, because the "-rc1" tail made it fail the anchor
// while still satisfying SERVICE_TOKEN -- so "we deployed 1.2.3-rc1" seeded a focus on a version.
const VERSION_TOKEN = /^v?\d+(?:\.\d+)+(?:[-.][a-z0-9]+)*$/i;
// A dotted token ending in a file extension is a filename, not a service: "app.log",
// "config.yaml" and "dump.json" are all two dot-joined segments and contain none of the
// /@:\ characters rejected below.
const FILE_EXTENSION_TOKEN = /\.(log|json|ya?ml|txt|csv|conf|ini|xml|sql|md|tsv|gz|zip)$/i;

// Infrastructure vocabulary that is service-SHAPED but never a service. These appear in incident
// prose constantly ("check the error-rate", "the merge-request that caused it").
const SERVICE_STOP_LIST: ReadonlySet<string> = new Set([
	"data-source",
	"data-sources",
	"merge-request",
	"merge-requests",
	"time-window",
	"error-rate",
	"error-rates",
	"root-cause",
	"real-time",
	"end-to-end",
]);

const MAX_RECOVERED_SERVICES = 3;

// SIO-1233: deterministic, no LLM. Pulls service-shaped tokens out of the raw query so a
// normalization that parsed cleanly but extracted nothing can still seed a focus.
//
// The ORIGINAL spelling is preserved, not a lowercased/normalized form: matchesFocus re-normalizes
// on its own, and resolveIdentifiers probes datasources with the literal token.
export function extractServiceCandidates(query: string, limit: number = MAX_RECOVERED_SERVICES): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const rawToken of query.split(/\s+/)) {
		// Strip surrounding punctuation before the structural checks, so a trailing comma or a
		// sentence-final period does not disqualify an otherwise valid name.
		const token = rawToken.replace(/^[("'`[]+/, "").replace(/[)"'`\].,;:!?]+$/, "");
		if (token === "") continue;
		// URLs, emails, host:port and paths. Each of these can satisfy SERVICE_TOKEN on a
		// sub-segment, and none of them is a service name.
		if (/[/@:\\]/.test(token)) continue;
		if (!SERVICE_TOKEN.test(token)) continue;
		// A service name always contains a letter. Rejects purely numeric shapes SERVICE_TOKEN
		// otherwise accepts ("1-2-3", "10.0.0.1") without needing a rule per shape.
		if (!/[a-z]/i.test(token)) continue;
		if (VERSION_TOKEN.test(token)) continue;
		if (FILE_EXTENSION_TOKEN.test(token)) continue;
		const key = token.toLowerCase();
		if (SERVICE_STOP_LIST.has(key) || seen.has(key)) continue;
		seen.add(key);
		out.push(token);
		if (out.length >= limit) break;
	}
	return out;
}

// Default ON (same idiom as KG_BINDINGS_WRITE_ENABLED): set NORMALIZER_SERVICE_RECOVERY_ENABLED
// =false (or 0) to fall back to the pre-SIO-1233 behaviour of accepting an empty focus.
export function isServiceRecoveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.NORMALIZER_SERVICE_RECOVERY_ENABLED;
	return v !== "false" && v !== "0";
}

const NORMALIZER_PROMPT = `Normalize the user's incident query into structured data for downstream analysis.

Available datasources: ${DATA_SOURCE_IDS.join(", ")}

Extract and return JSON with:
- severity: "critical" (outage), "high" (degraded), "medium" (anomaly), "low" (informational). Infer from keywords like "down", "outage" = critical; "slow", "degraded" = high; "check", "how" = medium.
- timeWindow: { from, to } as ISO 8601. Parse "last 30 min", "past hour", etc. If no time is mentioned, default to { from: 1 hour ago, to: now }.
- affectedServices: array of { name, namespace?, deployment? }. Extract service names, namespaces, or deployment identifiers mentioned.
- extractedMetrics: array of { name, value?, threshold? }. Extract metrics like "error rate 15%", "latency > 500ms", "lag 10000".

Return ONLY valid JSON, no explanation.`;

// SIO-750: Build the investigation focus anchor from the current normalized
// incident + query. Deterministic (no LLM call). Called on the first complex
// turn of a chat session; subsequent turns reuse the existing focus via the
// state.ts sticky reducer.
//
// On cold restart with isFollowUp:true but no focus persisted (the MemorySaver
// in packages/checkpointer was lost), we reconstruct from the current incident
// as the best-effort recovery and log a warning so operators can detect this.
export function buildInvestigationFocus(
	state: AgentStateType,
	incident: NormalizedIncident,
	query: string,
): InvestigationFocus {
	if (state.isFollowUp && !state.investigationFocus) {
		logger.warn(
			{ isFollowUp: true, hasIncident: !!incident },
			"Follow-up turn arrived without persisted investigationFocus -- checkpointer may have been lost; reconstructing from current incident",
		);
	}

	const services = incident.affectedServices?.map((s) => s.name) ?? [];
	const severity = incident.severity ?? "unspecified";
	// One-line deterministic summary: "<severity> investigation of <services> -- <first 80 chars of query>".
	const querySnippet = query.trim().replace(/\s+/g, " ").slice(0, 80);
	const summary =
		services.length > 0
			? `${severity} investigation of ${services.join(", ")} -- ${querySnippet}`
			: `${severity} investigation -- ${querySnippet}`;

	return {
		services,
		datasources: [], // populated by the entity-extractor in stage 2
		timeWindow: incident.timeWindow,
		summary,
		establishedAtTurn: state.messages.length,
	};
}

export async function normalizeIncident(
	state: AgentStateType,
	config?: RunnableConfig,
): Promise<Partial<AgentStateType>> {
	const lastMessage = state.messages.at(-1);
	if (!lastMessage) {
		logger.info("No message to normalize");
		return {};
	}

	const query = extractTextFromContent(lastMessage.content);
	logger.info({ query: query.slice(0, 100) }, "Normalizing incident query");

	// SIO-750: on follow-ups, surface the persisted investigation focus so the
	// LLM does not drift to unrelated services or time ranges. The focus is the
	// authoritative inheritance source; the legacy normalizedIncident.timeWindow
	// fallback is kept for the (rare) case where focus is unset but a prior
	// normalized incident exists (e.g. mid-session migration of an already-running
	// chat).
	const focus = state.investigationFocus;
	const followUpHint =
		state.isFollowUp && focus
			? `\nOriginal investigation: ${focus.summary}\nAnchored services: ${focus.services.join(", ") || "(none)"}\nAnchored datasources: ${focus.datasources.join(", ") || "(none)"}\nAnchored time window: ${focus.timeWindow ? JSON.stringify(focus.timeWindow) : "(none)"}\nTreat new services/metrics in the user's query as scoping additions to this investigation. Inherit anchored fields unless the query explicitly overrides them.`
			: state.isFollowUp && state.normalizedIncident?.timeWindow
				? `\nPrevious incident context: severity=${state.normalizedIncident.severity ?? "unknown"}, timeWindow=${JSON.stringify(state.normalizedIncident.timeWindow)}. Inherit these if the new query does not override them.`
				: "";

	const now = new Date();
	const oneHourAgo = new Date(now.getTime() - 3600_000);
	const timeContext = `\nCurrent time: ${now.toISOString()}. Default time window: { "from": "${oneHourAgo.toISOString()}", "to": "${now.toISOString()}" }`;

	const llm = createLlm("normalizer");
	try {
		const response = await llm.invoke(
			[
				{ role: "system", content: `${NORMALIZER_PROMPT}${timeContext}${followUpHint}` },
				{ role: "human", content: query },
			],
			config,
		);

		const text = extractTextFromContent(response.content);
		// SIO-1233: see entity-extractor.ts -- a reasoning-only turn yields "" and must not be
		// read as "the model found nothing in the query".
		if (text.trim() === "") {
			logger.warn(
				{ blockTypes: contentBlockTypes(response.content) },
				"Normalization got no text from the model; re-asking",
			);
		}
		const result = await parseLlmJsonWithCorrection(text, NormalizationSchema, {
			expectedKeys: NORMALIZATION_KEYS,
			reinvoke: async (correction) => {
				const retried = await llm.invoke(
					[
						{ role: "system", content: `${NORMALIZER_PROMPT}${timeContext}${followUpHint}` },
						{ role: "human", content: `${query}\n\n${correction}` },
					],
					config,
				);
				return extractTextFromContent(retried.content);
			},
			onRetry: (first) =>
				logger.warn(
					{ reason: first.reason, detail: first.message, observedKeys: first.observedKeys },
					"Normalization schema drift; re-asking once",
				),
		});
		if (result.ok) {
			const incident: NormalizedIncident = { ...result.data };

			// SIO-1233: the silent-failure catch. A drift that this all-nullish schema accepts
			// produces a perfectly valid incident with no services, which then makes
			// resolveIdentifiers a no-op (resolve-identifiers.ts:243) and forces every findings
			// card to filterMode "show-all". Detect "parsed fine, but the query names something
			// service-shaped and we extracted nothing" and say so.
			//
			// Note this deliberately does NOT make affectedServices required: it is legitimately
			// empty for "is anything degraded right now", and forcing the field makes the model
			// invent a name -- a WRONG focus yields droppedAll empty cards, strictly worse than
			// show-all.
			let serviceProvenance: "llm" | "query-recovery" = "llm";
			if ((incident.affectedServices?.length ?? 0) === 0) {
				const candidates = extractServiceCandidates(query);
				if (candidates.length > 0) {
					const recover = isServiceRecoveryEnabled();
					logger.warn(
						{ candidates, recovered: recover },
						"Normalization extracted no services from a query containing service-shaped tokens",
					);
					if (recover) {
						incident.affectedServices = candidates.map((name) => ({ name }));
						serviceProvenance = "query-recovery";
					}
				}
			}
			// SIO-750: establish the investigation focus on the first complex
			// turn. The sticky reducer in state.ts preserves the existing focus
			// across later turns; we only build a fresh one here when none is
			// persisted yet.
			const investigationFocus = state.investigationFocus ?? buildInvestigationFocus(state, incident, query);
			logger.info(
				{
					severity: incident.severity,
					serviceCount: incident.affectedServices?.length ?? 0,
					metricCount: incident.extractedMetrics?.length ?? 0,
					hasTimeWindow: !!incident.timeWindow,
					focusEstablishedAtTurn: investigationFocus.establishedAtTurn,
					focusServices: investigationFocus.services,
					// SIO-1233: distinguishes an LLM-extracted focus from a recovered one, so
					// "focusServices is non-empty" in a log is not mistaken for "the model worked".
					serviceProvenance,
					attempts: result.attempts,
				},
				"Normalization complete",
			);
			return { normalizedIncident: incident, investigationFocus };
		}
		// SIO-1221: parseLlmJson never throws, so log the reason here rather than
		// relying on the catch below (which now only sees invoke-level failures).
		logger.warn(
			{ reason: result.reason, detail: result.message, observedKeys: result.observedKeys, attempts: result.attempts },
			"Normalization failed, continuing without",
		);
	} catch (error) {
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"Normalization failed, continuing without",
		);
	}

	return {};
}
