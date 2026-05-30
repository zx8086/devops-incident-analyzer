// knowledge-graph/src/migrate.ts
//
// SIO-850: `knowledge-graph:migrate` applies the schema; `:seed` loads the
// service topology so the graph is non-empty day one. Both require
// KNOWLEDGE_GRAPH_ENABLED=true and an installed `lbug` (embedded; no server).

import { getGraphStore, isKnowledgeGraphEnabled } from "./store.ts";
import { upsertEntities } from "./writer.ts";

// Service dependency edges distilled from
// agents/incident-analyzer/knowledge/systems-map/service-dependencies.md.
const SEED_DEPENDENCIES = [
	{ from: "konnect-gateway", to: "backend-services" },
	{ from: "backend-services", to: "couchbase" },
	{ from: "backend-services", to: "kafka" },
	{ from: "kafka", to: "downstream-consumers" },
	{ from: "backend-services", to: "elasticsearch" },
];

async function migrate(): Promise<void> {
	const store = await getGraphStore();
	await store.init();
	process.stdout.write("knowledge-graph: schema applied.\n");
}

async function seed(): Promise<void> {
	const store = await getGraphStore();
	await store.init();
	await upsertEntities(store, {
		services: ["konnect-gateway", "backend-services", "couchbase", "kafka", "elasticsearch", "downstream-consumers"],
		dependencies: SEED_DEPENDENCIES,
	});
	process.stdout.write(`knowledge-graph: seeded ${SEED_DEPENDENCIES.length} dependency edges.\n`);
}

async function main(): Promise<void> {
	if (!isKnowledgeGraphEnabled()) {
		process.stdout.write("knowledge-graph: KNOWLEDGE_GRAPH_ENABLED is not set; nothing to do.\n");
		return;
	}
	const command = process.argv[2];
	if (command === "seed") {
		await seed();
	} else {
		await migrate();
	}
	const store = await getGraphStore();
	await store.close();
}

main().catch((error) => {
	process.stderr.write(`knowledge-graph migrate failed: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
