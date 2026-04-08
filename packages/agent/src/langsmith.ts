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

	// Greedy budget enforcement: truncate largest fields first until total fits
	const entries = Object.entries(obj).map(([key, value]) => ({
		key,
		value,
		size: JSON.stringify(value).length,
	}));
	entries.sort((a, b) => b.size - a.size);

	let totalSize = serialized.length;
	const result: Record<string, unknown> = {};

	for (const entry of entries) {
		if (totalSize > MAX_FIELD_BYTES && entry.size > 1024) {
			const placeholder = `[truncated: ${entry.size} bytes]`;
			result[entry.key] = placeholder;
			totalSize -= entry.size - placeholder.length;
		} else {
			result[entry.key] = entry.value;
		}
	}

	if (totalSize > MAX_FIELD_BYTES) {
		return { _truncated: `[entire payload truncated: ${serialized.length} bytes]` };
	}

	return result;
}

function patchClient(client: Record<string, unknown>, label: string): boolean {
	if (!client || typeof client.processInputs !== "function") return false;
	client.processInputs = async (inputs: Record<string, unknown>) => trimLargeValues(inputs);
	client.processOutputs = async (outputs: Record<string, unknown>) => trimLargeValues(outputs);
	logger.info(`Patched ${label} LangSmith client payload limits`);
	return true;
}

async function patchClientPayloadLimits(): Promise<void> {
	// Monkey-patch the LangSmith Client singleton's processInputs/processOutputs
	// to truncate oversized fields before they hit the API.
	//
	// Three client instances need patching:
	// 1. CJS singleton (getDefaultLangChainClientSingleton via createRequire)
	// 2. ESM singleton (the one LangChain runtime actually uses)
	// 3. RunTree.sharedClient (static client that bypasses the tracer singleton)
	try {
		const { createRequire } = await import("node:module");
		const require = createRequire(import.meta.url);
		const singletonsPath = require.resolve("@langchain/core/singletons");
		const tracerCjsPath = singletonsPath.replace(/singletons[/\\]index\.(c?js)$/, "singletons/tracer.$1");

		// Patch CJS singleton
		const { getDefaultLangChainClientSingleton: getCjs } = require(tracerCjsPath);
		patchClient(getCjs(), "CJS");

		// Patch ESM singleton (Bun dual-package hazard: CJS and ESM have separate singletons)
		const tracerEsmPath = tracerCjsPath.replace(/\.cjs$/, ".js");
		const esmMod = await import(tracerEsmPath);
		patchClient(esmMod.getDefaultLangChainClientSingleton(), "ESM");

		// Patch RunTree.sharedClient -- a static Client() that some tracing paths use
		// instead of the getDefaultLangChainClientSingleton() singletons.
		// langsmith is a transitive dep (via @langchain/core), so resolve from core's context.
		try {
			const coreRequire = createRequire(singletonsPath);
			const runTreesMod = coreRequire("langsmith/run_trees");
			const RunTree = runTreesMod.RunTree as { getSharedClient?: () => Record<string, unknown> };
			if (typeof RunTree?.getSharedClient === "function") {
				patchClient(RunTree.getSharedClient(), "RunTree.sharedClient");
			}
		} catch {
			// RunTree patching is best-effort; CJS/ESM singletons cover the primary path
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
