// apps/web/src/routes/api/diagram/+server.ts
import { createHash } from "node:crypto";
import { ApplicationTopologySchema, NetworkTopologySchema } from "@devops-agent/shared";
import { error, json } from "@sveltejs/kit";
import { z } from "zod";
import { isArchifyEnabled } from "$lib/server/archify/flag";
import { embedHtml, type RenderResult, renderDiagram } from "$lib/server/archify/render";
import { applicationToArchify, networkToArchify } from "$lib/server/archify/to-archify";
import type { RequestHandler } from "./$types";

// SIO-1876: renders a message's topology as an Archify diagram for the card's Diagram tab.
// The topology comes back from the browser, so it is re-validated here like any client input.
const BodySchema = z.discriminatedUnion("view", [
	z.object({ view: z.literal("network"), theme: z.enum(["light", "dark"]), topology: NetworkTopologySchema }),
	z.object({ view: z.literal("application"), theme: z.enum(["light", "dark"]), topology: ApplicationTopologySchema }),
]);
type Body = z.infer<typeof BodySchema>;

type Rendered = RenderResult & { ms: number };

// The converter is deterministic, so a result (failure included) is cached by input. Keyed without
// the theme: the same HTML serves both, and the theme is applied per response.
// ponytail: unbounded per-process map, add an LRU cap if it shows up in memory.
const cache = new Map<string, Promise<Rendered>>();

async function render(body: Body): Promise<Rendered> {
	const started = performance.now();
	const diagram = body.view === "network" ? networkToArchify(body.topology) : applicationToArchify(body.topology);
	return { ...(await renderDiagram("architecture", diagram)), ms: Math.round(performance.now() - started) };
}

export const POST: RequestHandler = async ({ request }) => {
	if (!isArchifyEnabled()) error(404, "Not found");
	const parsed = BodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "body must be { view, theme, topology } with a valid topology");
	const body = parsed.data;

	const key = createHash("sha256")
		.update(`${body.view}|${JSON.stringify(body.topology)}`)
		.digest("hex");
	let pending = cache.get(key);
	if (!pending) {
		pending = render(body);
		cache.set(key, pending);
		// A crash (CLI missing, temp dir unwritable) is environmental, not deterministic: do not cache it.
		pending.catch(() => cache.delete(key));
	}
	const result = await pending;

	const headers = { "x-archify-ms": String(result.ms) };
	if (!result.ok) return json({ error: result.error, diagnostics: result.diagnostics }, { status: 422, headers });
	return new Response(embedHtml(result.html, body.theme), {
		headers: { ...headers, "content-type": "text/html; charset=utf-8" },
	});
};

// The cards ask once whether to show their Diagram tab; the flag itself stays server-side.
export const GET: RequestHandler = () => json({ enabled: isArchifyEnabled() });
