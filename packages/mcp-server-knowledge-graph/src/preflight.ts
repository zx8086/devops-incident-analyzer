// src/preflight.ts
import { connect as netConnect } from "node:net";
import { graphPath } from "@devops-agent/knowledge-graph";
import type { IdentityCard } from "@devops-agent/shared";
import { z } from "zod";

// SIO-1645: the web app's pre-flight for mounting the knowledge-graph MCP server in-process.
// SIO-987's raw TCP probe could only answer "something listens" and hard-coded the verdict
// "a standalone server" -- which was wrong the day it mattered: after a Vite in-place restart
// (root .env change: same PID, new SSR module runner) the listener was the process's OWN
// previous module graph. The server publishes GET /identity (pid, role, upstreamFingerprint =
// resolved graph path), which is exactly the evidence needed to tell self / another process on
// the same store / another store / a non-KG service apart. The classifier is pure so every row
// is unit-tested without sockets; the two I/O helpers below are the only network code.

const KNOWLEDGE_GRAPH_ROLE: IdentityCard["role"] = "knowledge-graph-mcp";

// Only the fields the verdict needs; passthrough so a newer card is never rejected.
const ProbedIdentitySchema = z
	.object({
		instanceId: z.string(),
		role: z.string(),
		pid: z.number().int(),
		upstreamFingerprint: z.string(),
	})
	.passthrough();
export type ProbedIdentity = z.infer<typeof ProbedIdentitySchema>;

export type PortProbeResult = { kind: "identity"; card: ProbedIdentity } | { kind: "unavailable"; reason: string };

export type PortOccupant = "self" | "kg-same-store" | "kg-other-store" | "non-kg" | "unknown";

export interface PortOccupantVerdict {
	occupant: PortOccupant;
	// true -> keep the KG URL so the MCP bridge registers the listener's kg_* tools.
	registerTools: boolean;
	level: "info" | "warn";
	message: string;
}

// The SIO-987 wording, kept verbatim for the two cases where it is still the right advice.
const LOCK_OUT_WARNING =
	"a knowledge-graph server is already running on this port. The agent writes the graph IN-PROCESS and " +
	"will be LOCKED OUT by another process's exclusive lbug lock -- graph writes will fail silently. Stop the " +
	"other server; the agent starts the KG itself when KNOWLEDGE_GRAPH_ENABLED=true. Registering the existing " +
	"instance's read-only kg_* tools for now.";

export function classifyPortOccupant(
	probe: PortProbeResult,
	own: { pid: number; graphPath: string },
): PortOccupantVerdict {
	if (probe.kind === "unavailable") {
		return {
			occupant: "unknown",
			registerTools: true,
			level: "warn",
			message: `could not identify the listener on this port (/identity: ${probe.reason}); ${LOCK_OUT_WARNING}`,
		};
	}
	const { card } = probe;
	if (card.role !== KNOWLEDGE_GRAPH_ROLE) {
		return {
			occupant: "non-kg",
			registerTools: false,
			level: "warn",
			message: `port occupied by a non-KG service (role=${card.role}, pid=${card.pid}); not registering its tools. Free the port or set KNOWLEDGE_GRAPH_MCP_PORT.`,
		};
	}
	if (card.pid === own.pid) {
		return {
			occupant: "self",
			registerTools: true,
			level: "info",
			message: "listener is this process's own knowledge-graph MCP server (previous module graph); reusing it",
		};
	}
	// Plain string comparison on purpose: a relative KNOWLEDGE_GRAPH_PATH in the other process
	// cannot be resolved from here, and "different" fails safe (its tools are not registered).
	if (card.upstreamFingerprint === own.graphPath) {
		return {
			occupant: "kg-same-store",
			registerTools: true,
			level: "warn",
			message: `${LOCK_OUT_WARNING} (pid=${card.pid}, instanceId=${card.instanceId})`,
		};
	}
	return {
		occupant: "kg-other-store",
		registerTools: false,
		level: "warn",
		message: `a knowledge-graph server in another process (pid=${card.pid}) serves a DIFFERENT store (${card.upstreamFingerprint}); its kg_* tools would read a different graph than this process writes, so they are not registered. Stop it or set KNOWLEDGE_GRAPH_MCP_PORT.`,
	};
}

// The graph path this process's store resolves to -- the same graphPath() the store and the
// identity fingerprint use (SIO-1167), so the same-store comparison cannot drift.
export function ownGraphPath(): string {
	return graphPath(process.env);
}

// SIO-987: is a TCP server already listening on host:port? A successful connect means yes.
// Resolves false on connect refused/timeout. Short timeout so module-load is not delayed. Never throws.
export function isPortInUse(host: string, port: number, timeoutMs = 300): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = netConnect({ host, port });
		const done = (inUse: boolean) => {
			socket.destroy();
			resolve(inUse);
		};
		socket.setTimeout(timeoutMs);
		socket.once("connect", () => done(true));
		socket.once("timeout", () => done(false));
		socket.once("error", () => done(false)); // ECONNREFUSED -> nothing listening
	});
}

// GET /identity on an existing listener. Never throws: a timeout, a non-2xx (an older server
// without the route, or a non-MCP service) or an unparseable card all report "unavailable".
export async function probeKnowledgeGraphIdentity(opts: {
	host: string;
	port: number;
	timeoutMs?: number;
}): Promise<PortProbeResult> {
	try {
		const res = await fetch(`http://${opts.host}:${opts.port}/identity`, {
			signal: AbortSignal.timeout(opts.timeoutMs ?? 1_000),
		});
		if (!res.ok) return { kind: "unavailable", reason: `identity returned ${res.status}` };
		const parsed = ProbedIdentitySchema.safeParse(await res.json());
		return parsed.success
			? { kind: "identity", card: parsed.data }
			: { kind: "unavailable", reason: "identity card failed validation" };
	} catch (err) {
		return { kind: "unavailable", reason: err instanceof Error ? err.message : String(err) };
	}
}
