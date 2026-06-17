// agent/src/memory-writer.ts
//
// Live agent memory (EPIC 3 / SIO-845). Durable, human-readable, git-tracked
// state under memory/runtime/. This is deliberately NOT the LangGraph
// checkpointer: the checkpointer holds per-thread transient graph state for
// resume/interrupt; live memory persists knowledge and decisions across
// sessions and threads.
//
// This module is the single writer for memory/runtime/*. Writes are append-only
// (O_APPEND), redacted via redactPiiContent, and gated behind LIVE_MEMORY_ENABLED
// so dev/test never mutate the tracked files unless explicitly turned on.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "@devops-agent/observability";
import { createHashChainDestination, redactPiiContent } from "@devops-agent/shared";
import { dailyLogTtlSeconds, enqueueFact, enqueueMessage, selectedBackend } from "./memory-backend.ts";
import { getAgentsDir } from "./paths.ts";

const logger = getLogger("agent:memory-writer");

export interface LiveMemory {
	context?: string;
	keyDecisions?: string;
	dailyLog?: string;
}

export interface DailyLogEntry {
	requestId: string;
	services: string[];
	severity?: string;
	confidence?: number;
	datasources: string[];
	summary?: string;
}

export interface KeyDecision {
	requestId: string;
	decision: string;
	rationale?: string;
}

// Base agent dir is overridable for hermetic tests; production callers use the
// resolved agents dir.
function runtimeDir(baseDir?: string): string {
	return join(baseDir ?? getAgentsDir(), "memory", "runtime");
}

function isEnabled(): boolean {
	const v = process.env.LIVE_MEMORY_ENABLED;
	return v === "true" || v === "1";
}

// SIO-845: when LIVE_MEMORY_IMMUTABLE is set, dailylog appends are wrapped in the
// shared hash-chain so the audit log is tamper-evident (recordkeeping.immutable).
function immutableEnabled(): boolean {
	const v = process.env.LIVE_MEMORY_IMMUTABLE;
	return v === "true" || v === "1";
}

function readIfExists(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	return readFileSync(path, "utf-8");
}

// Reads the durable runtime memory for injection into the session prompt.
// Returns an empty object when live memory is disabled or absent.
export function readLiveMemory(baseDir?: string): LiveMemory {
	if (!isEnabled()) return {};
	const dir = runtimeDir(baseDir);
	return {
		context: readIfExists(join(dir, "context.md")),
		keyDecisions: readIfExists(join(dir, "key-decisions.md")),
		dailyLog: readIfExists(join(dir, "dailylog.md")),
	};
}

// Appends one structured, human-readable line to dailylog.md. Audit breadcrumb;
// writes directly (not PR-gated) but always redacted. No-op when disabled.
export function appendDailyLog(entry: DailyLogEntry, baseDir?: string): void {
	if (!isEnabled()) return;

	// Agent Memory backend: a dailylog breadcrumb is a conversational message
	// block with a short TTL (it decays). Redaction runs before the block leaves
	// the process. Enqueue is fire-and-forget; the lifecycle teardown drains it.
	if (selectedBackend() === "agent-memory") {
		const services = entry.services.length > 0 ? entry.services.join(", ") : "none";
		const summary = entry.summary ? redactPiiContent(entry.summary) : "";
		const assistant = [
			`req=${entry.requestId}`,
			`services=[${services}]`,
			`datasources=[${entry.datasources.join(", ") || "none"}]`,
			entry.severity ? `severity=${entry.severity}` : "",
			typeof entry.confidence === "number" ? `confidence=${entry.confidence.toFixed(2)}` : "",
			summary ? `-- ${summary}` : "",
		]
			.filter((p) => p.length > 0)
			.join(" ");
		enqueueMessage(
			{ user_content: summary || "incident investigation", assistant_content: assistant },
			new Date().toISOString(),
			dailyLogTtlSeconds(),
		);
		logger.info({ requestId: entry.requestId, backend: "agent-memory" }, "Appended dailylog entry");
		return;
	}

	const path = join(runtimeDir(baseDir), "dailylog.md");
	const date = new Date().toISOString();

	if (immutableEnabled()) {
		// Hash-chained JSON line for tamper-evidence. createHashChainDestination
		// re-seeds per call, so include the prior content's last hash is out of
		// scope here; the chain is verifiable within a single appended batch.
		const sink = createHashChainDestination({ write: (data) => appendFileSync(path, data) });
		const record = JSON.stringify({
			ts: date,
			requestId: entry.requestId,
			services: entry.services,
			severity: entry.severity,
			confidence: entry.confidence,
			datasources: entry.datasources,
			summary: entry.summary ? redactPiiContent(entry.summary) : undefined,
		});
		sink.write(`${record}\n`);
		logger.info({ requestId: entry.requestId, immutable: true }, "Appended dailylog entry");
		return;
	}

	const services = entry.services.length > 0 ? entry.services.join(", ") : "none";
	const datasources = entry.datasources.length > 0 ? entry.datasources.join(", ") : "none";
	const parts = [`- ${date}`, `req=${entry.requestId}`, `services=[${services}]`, `datasources=[${datasources}]`];
	if (entry.severity) parts.push(`severity=${entry.severity}`);
	if (typeof entry.confidence === "number") parts.push(`confidence=${entry.confidence.toFixed(2)}`);
	if (entry.summary) parts.push(`-- ${redactPiiContent(entry.summary)}`);
	appendFileSync(path, `${parts.join(" ")}\n`);
	logger.info({ requestId: entry.requestId }, "Appended dailylog entry");
}

// Appends a durable decision to key-decisions.md. NOTE: per the plan, durable
// learnings are PR-gated (EPIC 1). This direct appender exists for the writer's
// API completeness and for tests; the runtime path routes promotions through
// the memory-pr package once EPIC 1 lands.
export function recordKeyDecision(decision: KeyDecision, baseDir?: string): void {
	if (!isEnabled()) return;

	// Agent Memory backend: a key decision is a durable semantic fact (no TTL).
	// Redaction runs before the fact leaves the process.
	if (selectedBackend() === "agent-memory") {
		const fact = decision.rationale
			? `${redactPiiContent(decision.decision)} (rationale: ${redactPiiContent(decision.rationale)})`
			: redactPiiContent(decision.decision);
		enqueueFact(fact, new Date().toISOString());
		logger.info({ requestId: decision.requestId, backend: "agent-memory" }, "Recorded key decision");
		return;
	}

	const path = join(runtimeDir(baseDir), "key-decisions.md");
	const date = new Date().toISOString();
	const lines = [`## ${date} (${decision.requestId})`, "", redactPiiContent(decision.decision)];
	if (decision.rationale) lines.push("", `Rationale: ${redactPiiContent(decision.rationale)}`);
	appendFileSync(path, `\n${lines.join("\n")}\n`);
	logger.info({ requestId: decision.requestId }, "Recorded key decision");
}
