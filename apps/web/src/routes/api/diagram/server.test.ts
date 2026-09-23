// apps/web/src/routes/api/diagram/server.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { APPLICATION_TOPOLOGY_MAX_NODES, NETWORK_TOPOLOGY_MAX_NODES } from "@devops-agent/agent";
import { APPLICATION_FIXTURE } from "$lib/server/archify/fixtures";
import { POST } from "./+server.ts";

type Event = Parameters<typeof POST>[0];
const call = (body: unknown) =>
	POST({
		request: new Request("http://localhost/api/diagram", { method: "POST", body: JSON.stringify(body) }),
	} as Event);

// SvelteKit's error() throws an HttpError carrying the status.
async function status(body: unknown): Promise<number> {
	try {
		return (await call(body)).status;
	} catch (thrown) {
		return (thrown as { status: number }).status;
	}
}

const valid = { view: "application", theme: "light", topology: APPLICATION_FIXTURE };

describe("POST /api/diagram", () => {
	afterEach(() => {
		delete process.env.ARCHIFY_DIAGRAMS_ENABLED;
	});

	test("404 while the flag is off, even for a valid body", async () => {
		expect(await status(valid)).toBe(404);
	});

	test("400 when the topology fails its schema", async () => {
		process.env.ARCHIFY_DIAGRAMS_ENABLED = "true";
		expect(await status({ ...valid, topology: { nodes: "nope" } })).toBe(400);
		expect(await status({ ...valid, view: "network" })).toBe(400); // application topology under the network view
	});

	// Greptile P1 on #904: the route enforces the builders' caps. Checked AT the cap as well as one
	// past it, so an off-by-one in the bound fails here rather than rejecting a real capped topology.
	test("400 one node past the application builder cap, accepted at the cap", async () => {
		process.env.ARCHIFY_DIAGRAMS_ENABLED = "true";
		const services = (n: number) =>
			Array.from({ length: n }, (_, i) => ({ id: `svc:s${i}`, kind: "service" as const, name: `s${i}` }));
		const atCap = { ...APPLICATION_FIXTURE, nodes: services(APPLICATION_TOPOLOGY_MAX_NODES), edges: [] };
		const pastCap = { ...atCap, nodes: services(APPLICATION_TOPOLOGY_MAX_NODES + 1) };
		expect(await status({ ...valid, topology: pastCap })).toBe(400);
		expect(await status({ ...valid, topology: atCap })).not.toBe(400);
	}, 60_000);

	test("400 one node past the network builder cap", async () => {
		process.env.ARCHIFY_DIAGRAMS_ENABLED = "true";
		const nodes = Array.from({ length: NETWORK_TOPOLOGY_MAX_NODES + 1 }, (_, i) => ({
			id: `eni-${i}`,
			kind: "eni" as const,
		}));
		const topology = { builtAtTurn: 1, sources: ["aws"], nodes, edges: [] };
		expect(await status({ view: "network", theme: "light", topology })).toBe(400);
	});

	test("413 for a body over the byte cap even when every field is schema-valid", async () => {
		process.env.ARCHIFY_DIAGRAMS_ENABLED = "true";
		const huge = { ...APPLICATION_FIXTURE, nodes: [{ id: "svc:x", kind: "service", name: "x".repeat(600_000) }] };
		expect(await status({ ...valid, topology: huge })).toBe(413);
	});

	test("returns embeddable HTML in the requested theme", async () => {
		process.env.ARCHIFY_DIAGRAMS_ENABLED = "true";
		const response = await call(valid);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		const html = await response.text();
		expect(html).toContain("setAttribute('data-embed','true')");
		expect(html).toContain("var light=true");
	}, 30_000);
});
