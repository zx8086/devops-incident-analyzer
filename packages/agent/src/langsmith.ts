// agent/src/langsmith.ts
import { getLogger } from "@devops-agent/observability";
import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";

const logger = getLogger("agent:langsmith");

let initialized = false;

// LangSmith API has a 26MB per-field limit. With 119 MCP tools bound to
// sub-agents, the auto-traced inputs/outputs serialize to ~73MB and get
// rejected with 422 errors, breaking trace hierarchy.
const MAX_FIELD_BYTES = 20 * 1024 * 1024; // 20MB safety margin

function trimLargeValues(obj: Record<string, unknown>): Record<string, unknown> {
	const serialized = JSON.stringify(obj);
	if (serialized.length <= MAX_FIELD_BYTES) return obj;

	const trimmed: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		const valStr = JSON.stringify(value);
		if (valStr.length > MAX_FIELD_BYTES) {
			trimmed[key] = `[truncated: ${valStr.length} bytes]`;
		} else {
			trimmed[key] = value;
		}
	}
	return trimmed;
}

async function patchClientPayloadLimits(): Promise<void> {
	// Monkey-patch the LangSmith Client singleton's processInputs/processOutputs
	// to truncate oversized fields before they hit the API.
	try {
		// Use createRequire to bypass Vite's strict ESM exports-map validation.
		// The internal @langchain/core/singletons/tracer path isn't in the
		// package's exports map, so Vite's SSR resolver rejects a bare
		// dynamic import(). Node/Bun's require() resolves it fine at runtime.
		const { createRequire } = await import("node:module");
		const require = createRequire(import.meta.url);
		const { getDefaultLangChainClientSingleton } = require("@langchain/core/singletons/tracer");

		// Force singleton creation so we can patch it before auto-tracer uses it
		const client = getDefaultLangChainClientSingleton();

		if (client && typeof client.processInputs === "function") {
			client.processInputs = async (inputs: Record<string, unknown>) => trimLargeValues(inputs);
			client.processOutputs = async (outputs: Record<string, unknown>) => trimLargeValues(outputs);
		}
	} catch (error) {
		// Graceful degradation: traces may be oversized but execution continues
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"Failed to configure trace payload limits, traces may be truncated by LangSmith",
		);
	}
}

export async function initializeLangSmith(): Promise<boolean> {
	if (initialized) return true;
	initialized = true;

	const apiKey = process.env.LANGSMITH_API_KEY;
	const project = process.env.LANGSMITH_PROJECT;

	if (!apiKey) {
		logger.info("No API key found, tracing disabled");
		return false;
	}

	// LangChain auto-reads these env vars for tracing
	process.env.LANGCHAIN_TRACING_V2 = "true";
	if (project) {
		process.env.LANGCHAIN_PROJECT = project;
	}

	await patchClientPayloadLimits();

	logger.info({ project: project ?? "default" }, "Tracing enabled");
	return true;
}

export async function flushLangSmithCallbacks(): Promise<void> {
	try {
		await awaitAllCallbacks();
	} catch (error) {
		logger.warn({ error: error instanceof Error ? error.message : String(error) }, "Failed to flush callbacks");
	}
}
