// gitagent-bridge/src/memory.test.ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemoryLayout } from "./memory.ts";

function makeMemoryDir(opts: {
	runtime?: Partial<Record<"dailylog.md" | "key-decisions.md" | "context.md", string>>;
	wiki?: Partial<Record<"index.md" | "log.md", string>>;
	pages?: Record<string, string>;
}): string {
	const dir = mkdtempSync(join(tmpdir(), "gitagent-memory-test-"));
	const memoryDir = join(dir, "memory");
	if (opts.runtime) {
		mkdirSync(join(memoryDir, "runtime"), { recursive: true });
		for (const [name, content] of Object.entries(opts.runtime)) {
			writeFileSync(join(memoryDir, "runtime", name), content);
		}
	}
	if (opts.wiki || opts.pages) {
		mkdirSync(join(memoryDir, "wiki"), { recursive: true });
		for (const [name, content] of Object.entries(opts.wiki ?? {})) {
			writeFileSync(join(memoryDir, "wiki", name), content);
		}
		if (opts.pages) {
			mkdirSync(join(memoryDir, "wiki", "pages"), { recursive: true });
			for (const [name, content] of Object.entries(opts.pages)) {
				writeFileSync(join(memoryDir, "wiki", "pages", name), content);
			}
		}
	}
	// Ensure memory/ exists even when no subdirs requested
	mkdirSync(memoryDir, { recursive: true });
	return dir;
}

describe("loadMemoryLayout", () => {
	test("returns undefined when memory/ is absent", () => {
		const dir = mkdtempSync(join(tmpdir(), "gitagent-nomemory-"));
		try {
			expect(loadMemoryLayout(dir)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	test("reads runtime contents and always populates runtime paths", () => {
		const dir = makeMemoryDir({
			runtime: { "dailylog.md": "# Daily\n", "context.md": "# Context\n" },
		});
		try {
			const mem = loadMemoryLayout(dir);
			expect(mem?.runtime.dailyLog).toBe("# Daily\n");
			expect(mem?.runtime.context).toBe("# Context\n");
			// key-decisions.md not written -> content undefined, path still set
			expect(mem?.runtime.keyDecisions).toBeUndefined();
			expect(mem?.runtimePaths.keyDecisions).toBe(join(dir, "memory", "runtime", "key-decisions.md"));
			expect(mem?.runtimePaths.dailyLog).toBe(join(dir, "memory", "runtime", "dailylog.md"));
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	test("enumerates wiki pages and reads index/log", () => {
		const dir = makeMemoryDir({
			wiki: { "index.md": "# Index\n", "log.md": "# Log\n" },
			pages: { "kafka-lag.md": "# Kafka Lag\n", "topology.md": "# Topology\n", ".gitkeep": "" },
		});
		try {
			const mem = loadMemoryLayout(dir);
			expect(mem?.wiki.indexMd).toBe("# Index\n");
			expect(mem?.wiki.logMd).toBe("# Log\n");
			expect(mem?.wiki.pagePaths.length).toBe(2);
			expect(mem?.wiki.pagePaths.some((p) => p.endsWith("kafka-lag.md"))).toBe(true);
			expect(mem?.wiki.pagePaths.some((p) => p.endsWith(".gitkeep"))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	test("present but empty memory/ yields defined layout with empty wiki pages", () => {
		const dir = makeMemoryDir({});
		try {
			const mem = loadMemoryLayout(dir);
			expect(mem).toBeDefined();
			expect(mem?.wiki.pagePaths).toEqual([]);
			expect(mem?.runtime.dailyLog).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true });
		}
	});
});
