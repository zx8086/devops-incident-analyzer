// knowledge-graph/src/ladybug.integration.test.ts
//
// SIO-850: integration test against the REAL embedded LadybugDB engine. lbug is
// an OPTIONAL native dependency; this suite skips when it is not installed/built
// (bun blocks the package's native postinstall by default), so it is a no-op on
// machines that have not opted into the graph, and a real round-trip where they
// have. It caught the prepare()/execute() parameter-binding contract that the
// in-memory fake could not.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { priorRelationshipsForServices, topology } from "./reader.ts";
import { LadybugStore } from "./store.ts";
import { recordIncident, upsertEntities } from "./writer.ts";

// Detect whether the lbug native module is actually loadable (installed AND its
// entry points materialized). Skip the suite otherwise.
async function lbugLoadable(): Promise<boolean> {
	try {
		const specifier: string = "lbug";
		await import(specifier);
		return true;
	} catch {
		return false;
	}
}

const available = await lbugLoadable();
const dir = available ? mkdtempSync(join(tmpdir(), "lbug-it-")) : "";
afterAll(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!available)("LadybugStore (real embedded engine)", () => {
	test("init -> parameterized write -> read round-trip", async () => {
		const store = new LadybugStore(join(dir, "db"));
		await store.init();

		await upsertEntities(store, {
			services: ["svc-a", "svc-b"],
			dependencies: [{ from: "svc-a", to: "svc-b" }],
		});
		await recordIncident(store, { id: "inc-1", severity: "high", summary: "kafka lag", services: ["svc-a"] });

		// reader read-back
		expect(await priorRelationshipsForServices(store, ["svc-a"])).toEqual([{ from: "svc-a", to: "svc-b" }]);
		expect(await topology(store)).toContainEqual({ from: "svc-a", to: "svc-b" });

		// raw parameterized read
		const incidents = await store.run<{ id: string; severity: string }>(
			"MATCH (i:Incident {id: $id}) RETURN i.id AS id, i.severity AS severity",
			{ id: "inc-1" },
		);
		expect(incidents).toEqual([{ id: "inc-1", severity: "high" }]);

		await store.close();
	});

	test("MERGE is idempotent (re-running does not duplicate)", async () => {
		const store = new LadybugStore(join(dir, "db2"));
		await store.init();
		await upsertEntities(store, { services: ["svc-x"] });
		await upsertEntities(store, { services: ["svc-x"] });
		const rows = await store.run<{ n: number }>("MATCH (s:Service {name: $name}) RETURN count(s) AS n", {
			name: "svc-x",
		});
		expect(Number(rows[0]?.n)).toBe(1);
		await store.close();
	});
});
