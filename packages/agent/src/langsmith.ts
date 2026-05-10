// agent/src/langsmith.ts
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "@devops-agent/observability";
import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";

const logger = getLogger("agent:langsmith");

let initialized = false;

// LangSmith API has a 26,214,400-byte (25 MiB) per-multipart-field cap. With 119 MCP
// tools bound to sub-agents, single ToolMessage outputs can serialize past 75 MB and
// hit `Failed to send multipart request. Received status [422]: ... field size N
// exceeds maximum allowed size of 26214400 bytes` on `patch.<run-id>.outputs`.
const SERVER_FIELD_LIMIT = 26_214_400;
const MAX_FIELD_BYTES = 18 * 1024 * 1024; // 18MB JSON budget; ~7MiB headroom for multipart overhead
const MAX_VALUE_BYTES = SERVER_FIELD_LIMIT - 2 * 1024 * 1024; // 24MB hard cap per single value

function safeJsonSize(value: unknown): number {
	// JSON.stringify(undefined) returns undefined (not a string), so guard before .length.
	const serialized = JSON.stringify(value);
	return typeof serialized === "string" ? serialized.length : 0;
}

function trimLargeValues(obj: unknown): unknown {
	if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
		return obj;
	}
	const record = obj as Record<string, unknown>;
	const sizes = new Map<string, number>();
	let totalSize = 2; // "{}"
	let needsPerKeyTrim = false;
	for (const [key, value] of Object.entries(record)) {
		const size = safeJsonSize(value);
		sizes.set(key, size);
		totalSize += size + key.length + 4;
		if (size > MAX_VALUE_BYTES) needsPerKeyTrim = true;
	}

	if (totalSize <= MAX_FIELD_BYTES && !needsPerKeyTrim) return record;

	const entries = Object.entries(record)
		.map(([key, value]) => ({ key, value, size: sizes.get(key) ?? 0 }))
		.sort((a, b) => b.size - a.size);

	const result: Record<string, unknown> = {};
	for (const entry of entries) {
		const overSingleValueCap = entry.size > MAX_VALUE_BYTES;
		const overTotalBudget = totalSize > MAX_FIELD_BYTES && entry.size > 1024;
		if (overSingleValueCap || overTotalBudget) {
			const placeholder = `[truncated: ${entry.size} bytes]`;
			result[entry.key] = placeholder;
			totalSize -= entry.size - placeholder.length;
		} else {
			result[entry.key] = entry.value;
		}
	}

	if (totalSize > MAX_FIELD_BYTES) {
		return { _truncated: `[entire payload truncated: ${totalSize} bytes]` };
	}

	return result;
}

const patchedPrototypes = new WeakSet<object>();

function patchClientPrototype(ClientClass: unknown, label: string): boolean {
	if (typeof ClientClass !== "function") return false;
	const proto = (ClientClass as { prototype?: Record<string, unknown> }).prototype;
	if (!proto || typeof proto.processInputs !== "function") return false;
	if (patchedPrototypes.has(proto)) return false;
	proto.processInputs = async function (this: unknown, inputs: unknown) {
		return trimLargeValues(inputs);
	};
	proto.processOutputs = async function (this: unknown, outputs: unknown) {
		return trimLargeValues(outputs);
	};
	patchedPrototypes.add(proto);
	logger.info(`Patched ${label} Client.prototype payload limits`);
	return true;
}

interface BunLockedDep {
	dir: string;
	pkgPath: string;
}

function discoverBunLockedDeps(prefix: string): BunLockedDep[] {
	const bunDir = join(process.cwd(), "node_modules", ".bun");
	if (!existsSync(bunDir)) return [];
	try {
		return readdirSync(bunDir, { withFileTypes: true })
			.filter((d) => d.isDirectory() && d.name.startsWith(prefix))
			.map((d) => {
				// Bun encodes scoped packages with `+` and joins version with the LAST `@`.
				// Examples: "langsmith@0.6.3" -> "langsmith"; "@langchain+core@1.1.40" -> "@langchain/core".
				const lastAt = d.name.lastIndexOf("@");
				const rawName = lastAt > 0 ? d.name.slice(0, lastAt) : d.name;
				const pkgName = rawName.replace("+", "/");
				const pkgPath = join(bunDir, d.name, "node_modules", pkgName);
				return { dir: d.name, pkgPath };
			})
			.filter((dep) => existsSync(dep.pkgPath));
	} catch {
		return [];
	}
}

async function loadModule(modulePath: string, ext: "cjs" | "js"): Promise<Record<string, unknown> | null> {
	try {
		if (ext === "cjs") {
			const { createRequire } = await import("node:module");
			return createRequire(import.meta.url)(modulePath) as Record<string, unknown>;
		}
		return (await import(modulePath)) as Record<string, unknown>;
	} catch (error) {
		logger.debug(
			{ modulePath, error: error instanceof Error ? error.message : String(error) },
			"Failed to load module for prototype patch",
		);
		return null;
	}
}

async function patchAllLangSmithClientPrototypes(): Promise<number> {
	let patched = 0;
	const langsmiths = discoverBunLockedDeps("langsmith@");
	for (const ls of langsmiths) {
		for (const ext of ["cjs", "js"] as const) {
			const clientPath = join(ls.pkgPath, "dist", `client.${ext}`);
			if (!existsSync(clientPath)) continue;
			const mod = await loadModule(clientPath, ext);
			if (!mod) continue;
			if (patchClientPrototype(mod.Client, `${ls.dir}/${ext.toUpperCase()}`)) patched += 1;
		}
	}
	return patched;
}

async function patchClientPayloadLimits(): Promise<void> {
	// Patch Client.prototype on every langsmith copy in the bun graph so processInputs
	// /processOutputs truncate oversized fields on EVERY Client instance, including:
	//   - getDefaultLangChainClientSingleton() in each @langchain/core copy
	//   - RunTree.sharedClient in each langsmith copy
	//   - LangChainTracer ad-hoc clients (constructed with `client ?? singleton`)
	//   - Any future Client constructed via `new Client()` anywhere in the dep graph
	//
	// Earlier instance-only patching (SIO-687 v1) missed Clients reached via:
	//   - LangChainTracer.getRunTreeWithTracingConfig (creates new RunTree with the
	//     tracer's client field) -- if a runTree arrives via getCurrentRunTree() with
	//     its OWN client, line 82 of tracer_langchain.js reassigns this.client.
	//   - Multiple langsmith versions (0.5.12 nested under older @langchain/core,
	//     0.6.3 top-level) each define their own Client class with separate prototypes.
	try {
		const protosPatched = await patchAllLangSmithClientPrototypes();
		logger.info({ protosPatched }, "Patched LangSmith Client.prototype across bun module graph");
	} catch (error) {
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

export const _internal = { trimLargeValues, MAX_FIELD_BYTES, MAX_VALUE_BYTES, SERVER_FIELD_LIMIT };
