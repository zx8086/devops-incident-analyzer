// apps/web/src/lib/server/knowledge-graph-server.ts

import {
	classifyPortOccupant,
	isPortInUse,
	ownGraphPath,
	probeKnowledgeGraphIdentity,
	startKnowledgeGraphServer,
} from "@devops-agent/mcp-server-knowledge-graph";
import { getLogger } from "@devops-agent/observability";

// SIO-967: the knowledge-graph MCP server is mounted IN-PROCESS. Embedded lbug takes an
// exclusive file lock, so the graph can only be opened by ONE process -- and the agent
// pipeline's record* nodes already open it here. Running the server in this same process
// lets its kg_* tools reuse the single getGraphStore() singleton while still being reachable
// over localhost like every other MCP server. Gated on KNOWLEDGE_GRAPH_ENABLED; best-effort,
// so a start failure never blocks the app (SIO-986: embedded mode rethrows instead of exiting).
//
// SIO-1645: the started server lives on a PROCESS-wide globalThis slot, the same idiom as the
// mcp-bridge health poll (SIO-1113) and the skillflow scheduler (SIO-1468). Vite restarts its
// dev server in place on a root .env change: same PID, new SSR module runner, hot.dispose NOT
// run. The previous module graph's listener survives, so SIO-987's raw port probe found the
// process's OWN server and warned about a "standalone server" that did not exist. The slot is
// checked BEFORE any socket probe: same host:port in this process -> reuse. The old listener
// keeps dispatching into the module graph that created it (edits to the KG server's own tool
// code need a full dev-server restart, as before); its data is consistent because the store
// singleton is process-wide too (packages/knowledge-graph/src/store.ts). Nothing here ever
// closes the store, and app.shutdown() is never called in-process (it exits the process).
//
// SIO-987/SIO-1645: when the port is in use and this process holds no slot, GET /identity
// tells self / another process on the same store / another store / a non-KG service apart
// (classifyPortOccupant) instead of guessing "standalone". Binding is never attempted against
// a live listener (that produced a misleading EADDRINUSE + "Fatal" log).

const log = getLogger("agent:knowledge-graph-mcp");

// The minimum the slot needs from a started McpApplication (structural, so tests can fake it).
export interface KnowledgeGraphApp {
	transport: { listen?: unknown; closeAll(): Promise<void> };
}

// What one mount attempt decided: the URL the bridge may register (undefined = no kg_*
// tools) and our own started server, if any. A mount that found the port occupied or failed
// to bind reports app: null; a concurrent mount that awaited the same attempt adopts its URL.
interface MountOutcome {
	url: string | undefined;
	app: KnowledgeGraphApp | null;
}
interface KgServerSlot {
	key: string;
	outcome: Promise<MountOutcome>;
}
const KG_SERVER_SLOT_KEY = Symbol.for("devops-agent.web.knowledgeGraphServer");
function getSlot(): KgServerSlot | undefined {
	return (globalThis as Record<symbol, unknown>)[KG_SERVER_SLOT_KEY] as KgServerSlot | undefined;
}
function setSlot(slot: KgServerSlot | undefined): void {
	(globalThis as Record<symbol, unknown>)[KG_SERVER_SLOT_KEY] = slot;
}

interface MountLogger {
	info(fields: object, message: string): void;
	warn(fields: object, message: string): void;
}

// Every collaborator is injectable so the mount logic is unit-tested without sockets.
export interface MountDeps {
	env?: NodeJS.ProcessEnv;
	pid?: number;
	start?: () => Promise<KnowledgeGraphApp>;
	isPortInUse?: typeof isPortInUse;
	probe?: typeof probeKnowledgeGraphIdentity;
	graphPath?: () => string;
	log?: MountLogger;
}

// Per-module-graph view of the URL the bridge registers kg_* tools against. Re-derived by
// every mount() call; undefined when KG is disabled, the server failed to start, or the port's
// occupant must not have its tools registered.
let knowledgeGraphMcpUrl: string | undefined;
export function getKnowledgeGraphMcpUrl(): string | undefined {
	return knowledgeGraphMcpUrl;
}

function isAddrInUse(err: unknown): boolean {
	return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "EADDRINUSE";
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export async function mountKnowledgeGraphServer(deps: MountDeps = {}): Promise<void> {
	const env = deps.env ?? process.env;
	const logger = deps.log ?? log;
	if (env.KNOWLEDGE_GRAPH_ENABLED !== "true" && env.KNOWLEDGE_GRAPH_ENABLED !== "1") {
		knowledgeGraphMcpUrl = undefined;
		return;
	}
	const host = env.KNOWLEDGE_GRAPH_MCP_HOST ?? "127.0.0.1";
	const port = Number(env.KNOWLEDGE_GRAPH_MCP_PORT ?? "9087");
	const probeHost = host === "0.0.0.0" ? "127.0.0.1" : host;
	const key = `${probeHost}:${port}`;
	const url = `http://${probeHost}:${port}`;
	knowledgeGraphMcpUrl = url;

	// 1. Slot check FIRST, before any socket probe: same process, same host:port -> reuse.
	const existing = getSlot();
	if (existing?.key === key) {
		const outcome = await existing.outcome;
		if (outcome.app) {
			logger.info({ url }, "reusing in-process knowledge-graph MCP server from previous module graph");
		}
		knowledgeGraphMcpUrl = outcome.url;
		return;
	}
	if (existing) {
		// The host:port changed between restarts (the .env edit itself). Release the old
		// listener only -- never the store (SIO-954: close() is a no-op by design anyway).
		logger.info(
			{ from: existing.key, to: key },
			"knowledge-graph MCP host:port changed; closing previous in-process listener",
		);
		setSlot(undefined);
		existing.outcome
			.then((outcome) => outcome.app?.transport.closeAll())
			.catch((err: unknown) =>
				logger.warn({ error: errorMessage(err) }, "closing previous knowledge-graph listener failed"),
			);
	}

	// 2. Reserve the slot with the whole attempt BEFORE the first await, so a second mount in the
	// same tick (or two fast restarts) awaits this attempt instead of racing it to the bind.
	const slot: KgServerSlot = { key, outcome: attemptMount({ deps, logger, probeHost, port, url }) };
	setSlot(slot);
	const outcome = await slot.outcome;
	knowledgeGraphMcpUrl = outcome.url;
	// Only a running server of ours is worth keeping: a later mount after an occupied port or a
	// failed bind must probe again (the occupant may be gone by then).
	if (!outcome.app && getSlot() === slot) setSlot(undefined);
}

// One attempt to own the port. Never rejects: every failure is a verdict on the URL.
async function attemptMount(ctx: {
	deps: MountDeps;
	logger: MountLogger;
	probeHost: string;
	port: number;
	url: string;
}): Promise<MountOutcome> {
	const { deps, logger, probeHost, port, url } = ctx;
	const classify = async (): Promise<MountOutcome> => {
		const verdict = classifyPortOccupant(await (deps.probe ?? probeKnowledgeGraphIdentity)({ host: probeHost, port }), {
			pid: deps.pid ?? process.pid,
			graphPath: (deps.graphPath ?? ownGraphPath)(),
		});
		logger[verdict.level]({ url, occupant: verdict.occupant }, verdict.message);
		return { url: verdict.registerTools ? url : undefined, app: null };
	};

	// Something else listens: identify it rather than guess, and never try to bind over it.
	if (await (deps.isPortInUse ?? isPortInUse)(probeHost, port)) return classify();

	try {
		const app = await (deps.start ?? startKnowledgeGraphServer)();
		logger.info({ url }, "in-process knowledge-graph MCP server started");
		return { url, app };
	} catch (err) {
		// Lost the probe-to-bind race: classify the occupant instead of a generic failure.
		if (isAddrInUse(err)) return classify();
		logger.warn(
			{ error: errorMessage(err) },
			"in-process knowledge-graph MCP server failed to start; kg_* tools unavailable",
		);
		return { url: undefined, app: null };
	}
}

export function _resetKnowledgeGraphServerSlotForTest(): void {
	setSlot(undefined);
	knowledgeGraphMcpUrl = undefined;
}
