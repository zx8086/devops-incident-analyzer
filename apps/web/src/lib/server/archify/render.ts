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

// Archify's own ajv schema + layout checks validate the payload, so it is passed through as-is
// and problems come back as structured diagnostics.
export async function renderDiagram(type: DiagramType, diagram: unknown): Promise<RenderResult> {
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
