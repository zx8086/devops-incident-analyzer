// apps/web/src/routes/api/diagram/server.test.ts
import { afterEach, describe, expect, test } from "bun:test";
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
