// agent/src/llm-json-retry.ts

import type { z } from "zod";
import { type JsonShape, type LlmJsonResult, parseLlmJson } from "./llm-json.ts";

// SIO-1233: one corrective re-ask when an LLM's JSON does not match the schema.
//
// Deliberately NOT in llm-json.ts: that module is a pure, synchronous, dependency-free parser
// and every one of its 13 call sites depends on it staying that way. This module owns the only
// async concern, and even here the LLM call is injected as a callback -- so nothing in the
// retry path imports llm.ts or LangChain, and the whole thing is testable with a plain stub.
//
// Why a re-ask rather than a determinism knob: there is none. ROLE_OVERRIDES sets
// temperature: 0 for both entityExtractor and normalizer, and llm.ts:269 DISCARDS it because
// claude-sonnet-5 has acceptsTemperature: false. Bedrock Converse's inferenceConfig has no
// `seed`. topP exists but is unprobed for this model, and shipping it on a hunch is exactly
// how SIO-1213/1214 happened. So the drift cannot be prevented -- only corrected.

export type CorrectedJsonResult<T> = LlmJsonResult<T> & { attempts: number };

// The Zod issue text is echoed back to the model verbatim. That is safe in this direction and
// only this direction: issue text is key paths and type names, and where it does quote a
// received value that value came from the model's own previous turn. It is NOT logged -- the
// caller logs `reason` and `observedKeys`, never the body.
export function buildCorrectionPrompt(failureMessage: string, expectedKeys: readonly string[]): string {
	return `Your previous response did not match the required schema.

Validation error: ${failureMessage}

Return ONLY a JSON object with EXACTLY these top-level keys: ${expectedKeys.join(", ")}.
Do not wrap it in any container key. Do not add explanation, commentary, or markdown fences.`;
}

export async function parseLlmJsonWithCorrection<S extends z.ZodTypeAny>(
	text: string,
	schema: S,
	options: {
		expectedKeys: readonly string[];
		// Receives the correction prompt, returns the model's raw response TEXT (the caller
		// owns message construction and content extraction, so this module stays LangChain-free).
		reinvoke: (correctionPrompt: string) => Promise<string>;
		shape?: JsonShape;
		onRetry?: (first: Extract<LlmJsonResult<z.infer<S>>, { ok: false }>) => void;
	},
): Promise<CorrectedJsonResult<z.infer<S>>> {
	const first = parseLlmJson(text, schema, { shape: options.shape });
	if (first.ok) return { ...first, attempts: 1 };

	options.onRetry?.(first);

	// Single-shot. The caller's existing degrade (all-datasources fallback / empty incident)
	// remains the second fallback -- a retry loop here would multiply latency on exactly the
	// turns that are already slowest, and two failures in a row is a prompt problem, not a
	// sampling one.
	let retryText: string;
	try {
		retryText = await options.reinvoke(buildCorrectionPrompt(first.message, options.expectedKeys));
	} catch (error) {
		// The re-ask itself failed (invoke error, or the caller's RunnableConfig signal aborted).
		// Report the ORIGINAL parse failure: it describes what the model actually sent, which is
		// the diagnostic that matters, and it is what the caller would have degraded on anyway.
		void error;
		return { ...first, attempts: 2 };
	}

	const second = parseLlmJson(retryText, schema, { shape: options.shape });
	return { ...second, attempts: 2 };
}
