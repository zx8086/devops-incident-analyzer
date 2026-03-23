// shared/src/tracing/langsmith.ts
import type { RunTree } from "langsmith/run_trees";
import { getCurrentRunTree, withRunTree } from "langsmith/singletons/traceable";
import { traceable } from "langsmith/traceable";

let isTracingEnabled = false;
let isInitialized = false;

export interface TracingOptions {
	apiKey?: string;
	project?: string;
	endpoint?: string;
}

export function initializeTracing(options: TracingOptions = {}): void {
	if (isInitialized) return;
	isInitialized = true;

	const enabled =
		process.env.LANGSMITH_TRACING === "true" || process.env.LANGCHAIN_TRACING_V2 === "true";
	const apiKey = options.apiKey || process.env.LANGSMITH_API_KEY || process.env.LANGCHAIN_API_KEY;

	if (!enabled) return;
	if (!apiKey) return;

	const endpoint = options.endpoint || process.env.LANGSMITH_ENDPOINT || "https://api.smith.langchain.com";
	const project = options.project || process.env.LANGSMITH_PROJECT;

	process.env.LANGSMITH_TRACING = "true";
	process.env.LANGCHAIN_TRACING_V2 = "true";
	process.env.LANGSMITH_API_KEY = apiKey;
	process.env.LANGCHAIN_API_KEY = apiKey;
	process.env.LANGSMITH_ENDPOINT = endpoint;
	process.env.LANGCHAIN_ENDPOINT = endpoint;
	if (project) {
		process.env.LANGSMITH_PROJECT = project;
		process.env.LANGCHAIN_PROJECT = project;
	}

	isTracingEnabled = true;
}

export function isTracingActive(): boolean {
	return isTracingEnabled;
}

export function getCurrentTrace(): RunTree | undefined {
	if (!isTracingEnabled) return undefined;
	try {
		return getCurrentRunTree(true);
	} catch {
		return undefined;
	}
}

export function getTraceable() {
	return traceable;
}

export function getRunTreeUtils() {
	return { getCurrentRunTree, withRunTree };
}

// Allow resetting for tests
export function resetTracing(): void {
	isTracingEnabled = false;
	isInitialized = false;
}
