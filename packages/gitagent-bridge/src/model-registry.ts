// gitagent-bridge/src/model-registry.ts

// SIO-1223: the SINGLE source of truth for every model this repo may invoke.
//
// Before this, model knowledge lived in two uncoupled places: MODEL_MAP here (name -> Bedrock
// id) and NO_TEMPERATURE_MODEL_MARKERS in packages/agent/src/llm.ts (which model families
// reject `temperature`). SIO-1213 added to the first and production broke; SIO-1214 then
// retrofitted the second. Nothing linked them, so the next bump would repeat it exactly.
//
// A model is not "known" until it has a complete capability record here, and every field must
// be backed by an actual probe run -- see docs/development/model-upgrade-checklist.md and the
// committed reports in docs/reference/model-probes/.
//
// This module is plain data with no dependencies on purpose: packages/agent depends on
// gitagent-bridge, never the reverse, so the registry has to live on this side of the seam.

/** Observed shape of `AIMessage.content`. "blocks" means extractTextFromContent is mandatory. */
export type ContentShape = "string" | "blocks";

export interface ModelCapabilities {
	/** Bedrock inference-profile id, exactly as passed to ChatBedrockConverse. */
	readonly bedrockId: string;

	/**
	 * SIO-1214. false => `temperature` must NOT be sent. Claude's 4.7+/5 generation rejects it
	 * outright ("`temperature` is deprecated for this model") rather than accepting and
	 * ignoring it, so sending it hard-fails every call for that role.
	 */
	readonly acceptsTemperature: boolean;

	/** SIO-1217. Observed content shape with NO tools bound. */
	readonly contentShapeWithoutTools: ContentShape;
	/** SIO-1217. Observed content shape WITH tools bound. */
	readonly contentShapeWithTools: ContentShape;
	/** Union of observed block `type` values across probe prompts, e.g. ["reasoning", "text"]. */
	readonly observedBlockTypes: readonly string[];

	/**
	 * SIO-1216. Whether a reasoning/thinking block was seen under OUR request config (no
	 * additionalModelRequestFields, no explicit thinking config).
	 *
	 * STOCHASTIC: Sonnet 5 returned reasoning on 1/3 then 2/3 of prompt shapes across two runs
	 * of the same probe. Treat false as "not seen in that run", never as "cannot happen".
	 */
	readonly emitsReasoningContent: boolean;

	/**
	 * SIO-1219. Whether the probe OBSERVED raw unescaped control characters inside a JSON
	 * string literal.
	 *
	 * Named "observed", not "emits", because a negative proves nothing: SIO-1219 was a real
	 * production failure on Sonnet 5 that the probe does not reproduce on demand -- every entry
	 * below currently reads false despite that. parseLlmJson therefore sanitizes
	 * UNCONDITIONALLY at all thirteen call sites (SIO-1221), and a false here must never be
	 * used to justify removing the sanitizer.
	 */
	readonly observedRawControlCharsInJson: boolean;

	/**
	 * Smallest CONFIGURED maxTokens at which a full six-section incident report finished with
	 * stopReason "end_turn". A LONG_FORM_ROLES member budgeted below this truncates -- the
	 * SIO-649 failure (a report cut before its mandatory trailing Confidence line, leaving the
	 * HITL gate a 0 score) reproduced by a more verbose model at a budget that used to be ample.
	 */
	readonly longFormMinTokens: number;

	/** Advisory: probe-measured single-call latency across the whole probe run. */
	readonly observedLatencyMs: { readonly p50: number; readonly max: number };

	/** Provenance: date and region of the probe run behind the fields above. */
	readonly verifiedAt: string;
	readonly verifiedRegion: string;
	/**
	 * Repo-relative path to the committed probe report, or null for a rollback-only entry that
	 * no manifest references. The provenance test asserts the file exists whenever this is set,
	 * AND that every model an agent.yaml actually uses has a non-null report.
	 */
	readonly probeReport: string | null;
}

export const MODEL_REGISTRY = {
	// SIO-1213 additions. Both use the plain dateless EU cross-region id: verified against
	// `aws bedrock list-inference-profiles` (2026-07-26) as REAL profiles, so SIO-872's
	// "a bare non-suffixed id is not a valid Bedrock id" caveat does not apply to them.
	"claude-sonnet-5": {
		bedrockId: "eu.anthropic.claude-sonnet-5",
		acceptsTemperature: false,
		// The most verbose model in either chain. On the committed probe's full six-section report
		// it emits ~3,900-4,300 output tokens (4,287 at a 8192 cap, 3,874 at 16384) and TRUNCATES at
		// 4096, where Haiku 4.5 finishes the same report in 3,289 and Opus 4.8 in 3,094. Numbers
		// come from docs/reference/model-probes/*.md -- keep them in step with those reports.
		contentShapeWithoutTools: "blocks",
		contentShapeWithTools: "blocks",
		observedBlockTypes: ["reasoning", "text"],
		emitsReasoningContent: true,
		observedRawControlCharsInJson: false,
		longFormMinTokens: 8192,
		observedLatencyMs: { p50: 1890, max: 45305 },
		verifiedAt: "2026-07-26",
		verifiedRegion: "eu-central-1",
		probeReport: "docs/reference/model-probes/claude-sonnet-5.md",
	},
	"claude-opus-4-8": {
		bedrockId: "eu.anthropic.claude-opus-4-8",
		acceptsTemperature: false,
		contentShapeWithoutTools: "string",
		contentShapeWithTools: "blocks",
		observedBlockTypes: ["text"],
		emitsReasoningContent: false,
		observedRawControlCharsInJson: false,
		longFormMinTokens: 4096,
		observedLatencyMs: { p50: 1971, max: 41079 },
		verifiedAt: "2026-07-26",
		verifiedRegion: "eu-central-1",
		probeReport: "docs/reference/model-probes/claude-opus-4-8.md",
	},
	// The light tier: borrowed by classifier / gapsJudge / absenceJudge via the elastic-agent
	// sub-agent manifest, and the incident-analyzer fallback.
	"claude-haiku-4-5": {
		bedrockId: "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
		acceptsTemperature: true,
		contentShapeWithoutTools: "string",
		contentShapeWithTools: "string",
		observedBlockTypes: [],
		emitsReasoningContent: false,
		observedRawControlCharsInJson: false,
		longFormMinTokens: 4096,
		observedLatencyMs: { p50: 983, max: 29020 },
		verifiedAt: "2026-07-26",
		verifiedRegion: "eu-central-1",
		probeReport: "docs/reference/model-probes/claude-haiku-4-5.md",
	},
	// Rollback-only entries: retained so SIO-1213 can be reverted without a code change, but no
	// manifest references them, so they are deliberately unprobed (probeReport: null). Promote a
	// rollback entry by running the probe and filling in its report -- the provenance test
	// requires that before any manifest may point at it.
	// SIO-1262: PROMOTED from rollback-only to a live target -- the 7 sub-agent manifests point here.
	// Probed 2026-07-27 in eu-central-1. The previous hand-written placeholder had three values
	// WRONG: contentShapeWithTools was "string" (it is "blocks"), observedBlockTypes was [] (it is
	// ["text"]), and longFormMinTokens was 4096 -- which would have under-provisioned the subAgent
	// role's 8192. Exactly the class of silent capability assumption SIO-1224 built this gate for.
	"claude-sonnet-4-6": {
		bedrockId: "eu.anthropic.claude-sonnet-4-6",
		acceptsTemperature: true,
		contentShapeWithoutTools: "string",
		contentShapeWithTools: "blocks",
		observedBlockTypes: ["text"],
		emitsReasoningContent: false,
		observedRawControlCharsInJson: false,
		longFormMinTokens: 8192,
		observedLatencyMs: { p50: 2021, max: 87434 },
		verifiedAt: "2026-07-27",
		verifiedRegion: "eu-central-1",
		probeReport: "docs/reference/model-probes/claude-sonnet-4-6.md",
	},
	// SIO-872: the valid EU inference profile is ...-4-6-v1; the bare ...-4-6 is not a real
	// Bedrock id and was rejected at invoke time, silently forcing the fallback.
	"claude-opus-4-6": {
		bedrockId: "eu.anthropic.claude-opus-4-6-v1",
		acceptsTemperature: true,
		contentShapeWithoutTools: "string",
		contentShapeWithTools: "string",
		observedBlockTypes: [],
		emitsReasoningContent: false,
		observedRawControlCharsInJson: false,
		longFormMinTokens: 4096,
		observedLatencyMs: { p50: 0, max: 0 },
		verifiedAt: "unprobed",
		verifiedRegion: "unprobed",
		probeReport: null,
	},
} as const satisfies Record<string, ModelCapabilities>;

export type ModelName = keyof typeof MODEL_REGISTRY;

export function isKnownModel(name: string): name is ModelName {
	return Object.hasOwn(MODEL_REGISTRY, name);
}

// Preserves the pre-SIO-1223 error text from resolveBedrockConfig, which several tests and a
// good deal of operator muscle memory depend on.
export function getModelCapabilities(name: string): ModelCapabilities {
	const caps = (MODEL_REGISTRY as Record<string, ModelCapabilities>)[name];
	if (!caps) {
		throw new Error(`Unknown model "${name}". Available: ${Object.keys(MODEL_REGISTRY).join(", ")}`);
	}
	return caps;
}
