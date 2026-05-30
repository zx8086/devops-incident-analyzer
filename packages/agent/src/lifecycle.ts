// agent/src/lifecycle.ts
//
// Agent-SESSION lifecycle (EPIC 7 / SIO-846). Declarative bootstrap/teardown
// driven by the loaded agent's hooks/hooks.yaml. Runs once per chat session
// (keyed by threadId): bootstrap warms live memory + the wiki index + the
// knowledge graph; teardown flushes the daily log, checkpoints decisions, and
// opens the memory PR.
//
// This is NOT the MCP-server PROCESS lifecycle. shared/src/bootstrap.ts's
// createMcpApplication owns OS-process concerns (OTel init, transport wiring,
// SIGINT/SIGTERM, process.exit) for each standalone MCP server. lifecycle.ts
// owns per-session agent concerns inside the web app. The two never call each
// other and run in different processes.

import type { BootstrapStep, TeardownStep } from "@devops-agent/gitagent-bridge";
import { getLogger, traceSpan } from "@devops-agent/observability";
import { appendDailyLog, type DailyLogEntry, readLiveMemory } from "./memory-writer.ts";
import { getAgent } from "./prompt-context.ts";

const logger = getLogger("agent:lifecycle");

// Optional integration seam for EPIC 6: the knowledge-graph package registers a
// connectivity warmer here so warm_knowledge_graph can run without lifecycle.ts
// importing the graph package (which is gated/optional). No-op until registered.
let graphWarmer: (() => Promise<void>) | null = null;
export function registerGraphWarmer(fn: () => Promise<void>): void {
	graphWarmer = fn;
}

// Optional integration seam for EPIC 1: the memory-pr package registers a PR
// opener here so the open_memory_pr teardown step can run without lifecycle.ts
// importing memory-pr. No-op until registered.
let memoryPrOpener: (() => Promise<void>) | null = null;
export function registerMemoryPrOpener(fn: () => Promise<void>): void {
	memoryPrOpener = fn;
}

export interface BootstrapResult {
	// Whichever context the bootstrap steps gathered, for the caller to inject
	// into the first-turn prompt. Empty when no relevant steps ran.
	liveMemoryContext?: string;
	wikiIndex?: string;
	stepsRun: BootstrapStep[];
}

export interface TeardownContext {
	// The final daily-log breadcrumb for this session, if the caller has one.
	dailyLogEntry?: DailyLogEntry;
}

async function runBootstrapStep(step: BootstrapStep, result: BootstrapResult): Promise<void> {
	switch (step) {
		case "load_live_memory": {
			const mem = readLiveMemory();
			result.liveMemoryContext = mem.context;
			break;
		}
		case "load_wiki_index": {
			result.wikiIndex = getAgent().memory?.wiki.indexMd;
			break;
		}
		case "warm_knowledge_graph": {
			if (graphWarmer) {
				try {
					await graphWarmer();
				} catch (error) {
					// Best-effort: a cold/unreachable graph degrades gracefully to
					// empty graph context downstream; it must never block a session.
					logger.warn(
						{ error: error instanceof Error ? error.message : String(error) },
						"warm_knowledge_graph failed; continuing without graph context",
					);
				}
			}
			break;
		}
		case "emit_session_start":
			// The span/log is emitted by runBootstrap's traceSpan wrapper; this step
			// is the explicit opt-in marker that a session-start signal is desired.
			break;
	}
}

// Runs the agent's bootstrap hooks in declared order. Returns the gathered
// context. No hooks configured -> returns an empty result without a span.
export async function runBootstrap(): Promise<BootstrapResult> {
	const hooks = getAgent().hooks;
	const steps = hooks?.bootstrap?.steps ?? [];
	const result: BootstrapResult = { stepsRun: [] };
	if (steps.length === 0) return result;

	return traceSpan("agent", "agent.session.bootstrap", async () => {
		for (const step of steps) {
			await runBootstrapStep(step, result);
			result.stepsRun.push(step);
		}
		logger.info({ steps: result.stepsRun }, "Agent session bootstrap complete");
		return result;
	});
}

async function runTeardownStep(step: TeardownStep, ctx: TeardownContext): Promise<void> {
	switch (step) {
		case "flush_daily_log":
			if (ctx.dailyLogEntry) appendDailyLog(ctx.dailyLogEntry);
			break;
		case "checkpoint_key_decisions":
			// Durable decisions are promoted via the PR flow (EPIC 1), batched into
			// the open_memory_pr step. Nothing to flush directly here.
			break;
		case "open_memory_pr":
			if (memoryPrOpener) {
				try {
					await memoryPrOpener();
				} catch (error) {
					logger.warn(
						{ error: error instanceof Error ? error.message : String(error) },
						"open_memory_pr failed; session teardown continues",
					);
				}
			}
			break;
		case "close_knowledge_graph":
			// Driver close is process-level; per-session teardown leaves the shared
			// embedded handle open. Reserved for an explicit shutdown path.
			break;
	}
}

// Runs the agent's teardown hooks in declared order. No hooks -> no-op.
export async function runTeardown(ctx: TeardownContext = {}): Promise<TeardownStep[]> {
	const hooks = getAgent().hooks;
	const steps = hooks?.teardown?.steps ?? [];
	if (steps.length === 0) return [];

	return traceSpan("agent", "agent.session.teardown", async () => {
		const run: TeardownStep[] = [];
		for (const step of steps) {
			await runTeardownStep(step, ctx);
			run.push(step);
		}
		logger.info({ steps: run }, "Agent session teardown complete");
		return run;
	});
}
