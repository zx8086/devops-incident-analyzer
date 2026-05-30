// gitagent-bridge/src/memory.ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Live agent memory layout (EPIC 3) + compiled LLM wiki (EPIC 2). The loader
// reads contents (so prompt builders can inline them) AND retains absolute
// paths (so the memory-writer can append). Distinct from the LangGraph
// checkpointer: the checkpointer is per-thread transient graph state; this is
// durable, human-readable, cross-session, git-tracked.
export interface LoadedMemory {
	runtime: {
		dailyLog?: string;
		keyDecisions?: string;
		context?: string;
	};
	runtimePaths: {
		dailyLog: string;
		keyDecisions: string;
		context: string;
	};
	wiki: {
		indexMd?: string;
		logMd?: string;
		pagePaths: string[];
	};
}

function readIfExists(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	return readFileSync(path, "utf-8");
}

function isDirectory(path: string): boolean {
	if (!existsSync(path)) return false;
	return statSync(path).isDirectory();
}

// Returns undefined when memory/ is absent (live-memory disabled). The runtime
// paths are always populated (even when the files do not yet exist) so the
// appender knows where to write.
export function loadMemoryLayout(agentDir: string): LoadedMemory | undefined {
	const memoryDir = join(agentDir, "memory");
	if (!isDirectory(memoryDir)) return undefined;

	const runtimeDir = join(memoryDir, "runtime");
	const dailyLogPath = join(runtimeDir, "dailylog.md");
	const keyDecisionsPath = join(runtimeDir, "key-decisions.md");
	const contextPath = join(runtimeDir, "context.md");

	const wikiDir = join(memoryDir, "wiki");
	const pagesDir = join(wikiDir, "pages");
	const pagePaths = isDirectory(pagesDir)
		? readdirSync(pagesDir)
				.filter((f) => f.endsWith(".md") && f !== ".gitkeep")
				.map((f) => join(pagesDir, f))
		: [];

	return {
		runtime: {
			dailyLog: readIfExists(dailyLogPath),
			keyDecisions: readIfExists(keyDecisionsPath),
			context: readIfExists(contextPath),
		},
		runtimePaths: {
			dailyLog: dailyLogPath,
			keyDecisions: keyDecisionsPath,
			context: contextPath,
		},
		wiki: {
			indexMd: readIfExists(join(wikiDir, "index.md")),
			logMd: readIfExists(join(wikiDir, "log.md")),
			pagePaths,
		},
	};
}
