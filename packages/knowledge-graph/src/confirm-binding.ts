// knowledge-graph/src/confirm-binding.ts
//
// SIO-1103: `knowledge-graph:confirm-binding` -- the OPERATOR path for asserting a
// telemetry binding by hand (discoveredBy: "human", confidence: 1.0). Deliberately a
// CLI, NOT an LLM-callable kg_* tool: the curated kg_* surface is read-only by design
// and the incident agent has no kg_* tools, so a write tool would break both invariants
// (see docs/architecture/knowledge-graph.md). A human binding is never auto-invalidated
// by the staleness lifecycle (P5) -- it is only flagged for review.
//
//   bun run src/confirm-binding.ts --service orders --kind logGroup \
//     --resourceId /ecs/orders-prd [--datasource aws] [--locator prod] [--alias prices-api]
//
// Writes the graph binding (via the same recordServiceBinding as the agent) and, when
// LIVE_MEMORY_BACKEND=agent-memory, the durable kg-binding fact so `knowledge-graph:
// rebuild` can replay it. On the file backend it writes graph-only and warns.

import {
	type AgentMemoryUserRef,
	createFetchAgentMemoryClient,
	normalize,
	resolveAgentMemoryConfig,
} from "@devops-agent/shared";
import { type BindingKind, BindingKindSchema } from "./schema.ts";
import { getGraphStore, isKnowledgeGraphEnabled } from "./store.ts";
import { recordServiceBinding } from "./writer.ts";

const INCIDENT_USER = "incident-analyzer";
const CONFIRM_SESSION = "kg-confirm-binding";

interface ConfirmArgs {
	service: string;
	kind: BindingKind;
	resourceId: string;
	datasource: string;
	locator?: string;
	aliasRaw?: string;
}

function flag(argv: string[], name: string): string | undefined {
	const i = argv.indexOf(`--${name}`);
	if (i === -1) return undefined;
	const value = argv[i + 1];
	if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
	return value;
}

// The datasource a kind belongs to, so the operator need not pass --datasource for the
// common kinds (it composes the TelemetrySource id `<datasource>:<kind>:<resourceId>`).
const KIND_DATASOURCE: Record<string, string> = {
	serviceName: "elastic",
	logGroup: "aws",
	ecsService: "aws",
	scope: "couchbase",
	topic: "kafka",
	consumerGroup: "kafka",
	konnectControlPlane: "konnect",
	konnectService: "konnect",
	gitlabProject: "gitlab",
	jiraProject: "atlassian",
	confluenceSpace: "atlassian",
};

function parseArgs(argv: string[]): ConfirmArgs {
	const service = flag(argv, "service");
	const kind = flag(argv, "kind");
	const resourceId = flag(argv, "resourceId");
	if (!service || !kind || !resourceId) {
		throw new Error("required: --service <name> --kind <bindingKind> --resourceId <id>");
	}
	const parsedKind = BindingKindSchema.safeParse(kind);
	if (!parsedKind.success) {
		throw new Error(`--kind must be one of: ${BindingKindSchema.options.join(", ")}`);
	}
	const datasource = flag(argv, "datasource") ?? KIND_DATASOURCE[parsedKind.data];
	if (!datasource) throw new Error(`--datasource is required for kind ${parsedKind.data}`);
	return {
		service,
		kind: parsedKind.data,
		resourceId,
		datasource,
		locator: flag(argv, "locator"),
		aliasRaw: flag(argv, "alias"),
	};
}

async function writeDurableFact(a: ConfirmArgs, serviceNormalized: string): Promise<boolean> {
	if (process.env.LIVE_MEMORY_BACKEND !== "agent-memory") return false;
	const config = resolveAgentMemoryConfig();
	if (!config.enabled) return false;
	const client = createFetchAgentMemoryClient(config);
	const ref: AgentMemoryUserRef = { userId: INCIDENT_USER, sessionId: CONFIRM_SESSION };
	await client.ensureUser(INCIDENT_USER, "incident-analyzer");
	await client.ensureSession(INCIDENT_USER, CONFIRM_SESSION);
	await client.addFacts(
		ref,
		[`Human-confirmed telemetry binding: ${a.service} observed in ${a.datasource} as ${a.kind}=${a.resourceId}`],
		{
			annotations: {
				kind: "kg-binding",
				service: a.service,
				service_normalized: serviceNormalized,
				binding_kind: a.kind,
				resource_id: a.resourceId,
				locator: a.locator ?? "",
				datasource: a.datasource,
				discovered_by: "human",
				confidence: "1",
			},
		},
	);
	return true;
}

async function main(): Promise<void> {
	if (!isKnowledgeGraphEnabled()) {
		process.stdout.write("knowledge-graph confirm-binding: KNOWLEDGE_GRAPH_ENABLED is not set; nothing to do.\n");
		return;
	}
	const args = parseArgs(process.argv.slice(2));
	const serviceNormalized = normalize(args.service);
	const store = await getGraphStore();
	await recordServiceBinding(store, {
		service: args.service,
		serviceNormalized,
		aliasRaw: args.aliasRaw,
		datasource: args.datasource,
		kind: args.kind,
		resourceId: args.resourceId,
		locator: args.locator,
		confidence: 1.0,
		discoveredBy: "human",
		evidence: "human-confirmed",
	});
	const factWritten = await writeDurableFact(args, serviceNormalized);
	process.stdout.write(
		`knowledge-graph confirm-binding: recorded ${args.service} -> ${args.datasource}:${args.kind}:${args.resourceId} (human, confidence 1.0).\n` +
			(factWritten
				? "  durable kg-binding fact written (rebuildable).\n"
				: "  file backend (LIVE_MEMORY_BACKEND != agent-memory): graph-only, NOT rebuildable from Couchbase.\n"),
	);
}

if (import.meta.main) {
	main().catch((error) => {
		process.stderr.write(
			`knowledge-graph confirm-binding failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exit(1);
	});
}

export { parseArgs };
