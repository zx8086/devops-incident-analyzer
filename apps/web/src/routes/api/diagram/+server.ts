// apps/web/src/routes/api/diagram/+server.ts
import { createHash } from "node:crypto";
import {
	APPLICATION_TOPOLOGY_MAX_EDGES,
	APPLICATION_TOPOLOGY_MAX_NODES,
	NETWORK_TOPOLOGY_MAX_EDGES,
	NETWORK_TOPOLOGY_MAX_NODES,
} from "@devops-agent/agent";
import { ApplicationTopologySchema, NetworkTopologySchema } from "@devops-agent/shared";
import { error, json } from "@sveltejs/kit";
import { z } from "zod";
import { isArchifyEnabled } from "$lib/server/archify/flag";
import { embedHtml, RendererBusyError, type RenderResult, remember, renderDiagram } from "$lib/server/archify/render";
import { applicationToArchify, networkToArchify } from "$lib/server/archify/to-archify";
import type { RequestHandler } from "./$types";

// SIO-1876: renders a message's topology as an Archify diagram for the card's Diagram tab.
// The topology comes back from the browser, so it is re-validated here like any client input,
// and (Greptile P1 on #904) bounded: the route is unauthenticated and the shared schemas carry
// no size limits, so it enforces the builders' own caps -- a topology bigger than any builder can
// emit is not one this route needs to draw.
const BodySchema = z.discriminatedUnion("view", [
	z.object({
		view: z.literal("network"),
		theme: z.enum(["light", "dark"]),
		topology: NetworkTopologySchema.extend({
			nodes: NetworkTopologySchema.shape.nodes.max(NETWORK_TOPOLOGY_MAX_NODES),
			edges: NetworkTopologySchema.shape.edges.max(NETWORK_TOPOLOGY_MAX_EDGES),
		}),
	}),
	z.object({
		view: z.literal("application"),
		theme: z.enum(["light", "dark"]),
		topology: ApplicationTopologySchema.extend({
			nodes: ApplicationTopologySchema.shape.nodes.max(APPLICATION_TOPOLOGY_MAX_NODES),
			edges: ApplicationTopologySchema.shape.edges.max(APPLICATION_TOPOLOGY_MAX_EDGES),
		}),
	}),
]);
type Body = z.infer<typeof BodySchema>;

// A capped live topology serializes to ~85 KB (200 network nodes); the count caps do not bound
// string lengths, so the raw body is capped too.
const MAX_BODY_BYTES = 512 * 1024;
// Each entry holds ~0.8-1 MB of HTML, so this bounds the cache at roughly 50 MB.
const MAX_CACHED = 50;

type Rendered = RenderResult & { ms: number };

// The converter is deterministic, so a result (failure included) is cached by input. Keyed without
// the theme: the same HTML serves both, and the theme is applied per response.
const cache = new Map<string, Promise<Rendered>>();

async function render(body: Body): Promise<Rendered> {
	const started = performance.now();
	const diagram = body.view === "network" ? networkToArchify(body.topology) : applicationToArchify(body.topology);
	return { ...(await renderDiagram("architecture", diagram)), ms: Math.round(performance.now() - started) };
}

// Greptile P1 (round 2 on #904): the limit must hold WHILE reading. request.text() buffers the whole
// body first, and adapter-auto guarantees no upstream BODY_SIZE_LIMIT (vite dev has none), so the
// stream is read chunk by chunk and cancelled the moment it passes the cap. A declared
// Content-Length over the cap is refused before a single byte is read.
async function readCapped(request: Request, max: number): Promise<string | null> {
	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > max) return null;
	if (!request.body) return "";
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

export const POST: RequestHandler = async ({ request }) => {
	if (!isArchifyEnabled()) error(404, "Not found");
	const raw = await readCapped(request, MAX_BODY_BYTES);
	if (raw === null) error(413, `body exceeds ${MAX_BODY_BYTES} bytes`);
	let payload: unknown = null;
	try {
		payload = JSON.parse(raw);
	} catch {}
	const parsed = BodySchema.safeParse(payload);
	if (!parsed.success)
		error(400, "body must be { view, theme, topology } with a valid topology within the builder caps");
	const body = parsed.data;

	const key = createHash("sha256")
		.update(`${body.view}|${JSON.stringify(body.topology)}`)
		.digest("hex");
	let pending = cache.get(key);
	if (!pending) {
		pending = render(body);
		remember(cache, key, pending, MAX_CACHED);
		// A crash or a busy refusal is not deterministic: do not cache it.
		pending.catch(() => cache.delete(key));
	}
	let result: Rendered;
	try {
		result = await pending;
	} catch (err) {
		if (err instanceof RendererBusyError) error(503, err.message);
		throw err;
	}

	const headers = { "x-archify-ms": String(result.ms) };
	if (!result.ok) return json({ error: result.error, diagnostics: result.diagnostics }, { status: 422, headers });
	return new Response(embedHtml(result.html, body.theme), {
		headers: { ...headers, "content-type": "text/html; charset=utf-8" },
	});
};

// The cards ask once whether to show their Diagram tab; the flag itself stays server-side.
export const GET: RequestHandler = () => json({ enabled: isArchifyEnabled() });
