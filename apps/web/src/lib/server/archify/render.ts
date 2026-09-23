// apps/web/src/lib/server/archify/render.ts
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// SIO-1876: ported from archify/integrations/bun-svelte/archify.ts. node:child_process instead of
// Bun.spawn because `vite dev` serves this app under Node; the vendored CLI runs under either.

export const DIAGRAM_TYPES = ["architecture", "workflow", "sequence", "dataflow", "lifecycle"] as const;
export type DiagramType = (typeof DIAGRAM_TYPES)[number];

export type Diagnostic = {
	code: string;
	severity: string;
	message: string;
	subject?: unknown;
	evidence?: unknown;
	supportedFixes?: string[];
};

export type RenderResult = { ok: true; html: string } | { ok: false; error: string; diagnostics: Diagnostic[] };

const TIMEOUT_MS = 30_000;
const CLI_REL = "vendor/archify/bin/archify.mjs";

// cwd is apps/web under dev/test and the repo root elsewhere, so walk up to the vendored copy.
function findArchifyDir(): string {
	if (process.env.ARCHIFY_DIR) return resolve(process.env.ARCHIFY_DIR);
	let dir = process.cwd();
	for (;;) {
		if (existsSync(join(dir, CLI_REL))) return join(dir, "vendor/archify");
		const parent = dirname(dir);
		if (parent === dir) throw new Error(`${CLI_REL} not found above ${process.cwd()}; set ARCHIFY_DIR`);
		dir = parent;
	}
}

let archifyDir: string | undefined;
export function getArchifyDir(): string {
	archifyDir ??= findArchifyDir();
	return archifyDir;
}

function run(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((done) => {
		execFile(process.execPath, args, { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
			const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
			done({ stdout, stderr, code });
		});
	});
}

// SIO-1876 (Greptile P1 on #904): each render is a child process that may run for TIMEOUT_MS, and
// /api/diagram is unauthenticated, so admission is bounded: MAX_ACTIVE run, MAX_QUEUED wait, and
// anything beyond that is refused immediately instead of piling up processes.
const MAX_ACTIVE = 2;
const MAX_QUEUED = 8;
let active = 0;
const queue: Array<() => void> = [];

export class RendererBusyError extends Error {
	constructor() {
		super(`diagram renderer busy (${MAX_ACTIVE} running, ${MAX_QUEUED} queued)`);
		this.name = "RendererBusyError";
	}
}

export function rendererLoad(): { active: number; queued: number } {
	return { active, queued: queue.length };
}

// A finished render hands its slot straight to the next waiter rather than freeing it, so a caller
// arriving in between can never take the slot and push `active` past MAX_ACTIVE.
function release(): void {
	const next = queue.shift();
	if (next) next();
	else active--;
}

// Admission is decided synchronously, before the first await, so a burst is counted exactly.
export function renderDiagram(type: DiagramType, diagram: unknown): Promise<RenderResult> {
	let slot: Promise<void>;
	if (active < MAX_ACTIVE) {
		active++;
		slot = Promise.resolve();
	} else if (queue.length < MAX_QUEUED) {
		slot = new Promise((resolve) => queue.push(resolve));
	} else {
		return Promise.reject(new RendererBusyError());
	}
	return slot.then(() => renderOnce(type, diagram)).finally(release);
}

// Insertion-ordered Map as a FIFO cache: re-setting an existing key does not refresh its position,
// which is fine for a cache whose entries never go stale (same topology, same diagram).
export function remember<V>(cache: Map<string, V>, key: string, value: V, max: number): void {
	cache.set(key, value);
	for (const oldest of cache.keys()) {
		if (cache.size <= max) break;
		cache.delete(oldest);
	}
}

// Archify's own ajv schema + layout checks validate the payload, so it is passed through as-is
// and problems come back as structured diagnostics.
async function renderOnce(type: DiagramType, diagram: unknown): Promise<RenderResult> {
	// The CLI only reads and writes files, so each call gets its own temp dir.
	const dir = await mkdtemp(join(tmpdir(), "archify-"));
	try {
		const input = join(dir, `in.${type}.json`);
		const output = join(dir, "out.html");
		await writeFile(input, JSON.stringify(diagram));

		const { stdout, stderr, code } = await run([
			join(getArchifyDir(), "bin/archify.mjs"),
			"deliver",
			type,
			input,
			output,
			"--json",
		]);

		let report: { ok?: boolean; error?: string; diagnostics?: Diagnostic[] };
		try {
			report = JSON.parse(stdout);
		} catch {
			return { ok: false, error: stderr.trim() || `archify exited with ${code}`, diagnostics: [] };
		}
		if (!report.ok) return { ok: false, error: report.error ?? "render failed", diagnostics: report.diagnostics ?? [] };
		return { ok: true, html: await readFile(output, "utf8") };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

// srcdoc iframes carry no URL query, so ?embed=1&theme= cannot reach the viewer. Its theme falls back
// to prefers-color-scheme (localStorage throws in the sandbox's opaque origin), so answer that query
// with the app's theme before any viewer script runs.
// ponytail: matchMedia shim, drop it if upstream Archify grows an embed-config hook.
export function embedHtml(html: string, theme: "light" | "dark"): string {
	const shim = `<script>(function(){document.documentElement.setAttribute('data-embed','true');var m=window.matchMedia.bind(window);window.matchMedia=function(q){if(/prefers-color-scheme/.test(q)){var light=${theme === "light"};var hit=/light/.test(q)?light:!light;return{matches:hit,media:q,onchange:null,addEventListener:function(){},removeEventListener:function(){},addListener:function(){},removeListener:function(){},dispatchEvent:function(){return false}}}return m(q)}})();</script>`;
	return html.replace(/<head>/i, `<head>${shim}`);
}
