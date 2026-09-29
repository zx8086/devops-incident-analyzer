// packages/agent/src/reflect/candidates.ts
//
// SIO-1893 (reflect A5): turn the analysis's `create` portfolio items into
// candidate drafts in the SIO-1892 harvest file shape, so `learn:ingest`
// records them as kind:skill candidates for the SIO-1891 review pane. Pure:
// the analysis is already an artefact of the pipeline, and every string here
// is PII-redacted before it can reach a candidate fact.
import { redactPiiContent } from "@devops-agent/shared";
import type { Analysis, Finding, PortfolioItem } from "./aggregate.ts";

// A reaction signal implicates the turn: a create item whose sessions also
// carry one is filed rejected with task_success 0, never as a live candidate.
const NEGATIVE_REACTIONS: ReadonlySet<string> = new Set([
	"user-correction",
	"user-redo",
	"user-handoff",
	"user-abandon",
]);

export interface ReflectCandidateDraft {
	kind: "skill";
	skill_name: string;
	title: string;
	applicability: string;
	body: string;
	evidence: { ref: string; excerpt: string }[];
	source: "reflect";
	learned_from: string;
	status: "candidate" | "rejected";
	task_success: "" | "0";
	task_success_source: "" | "reflect";
}

export interface ReflectCandidatesOutput {
	generated_at: string;
	window: Analysis["window"];
	candidates: ReflectCandidateDraft[];
	skipped: { item: string; reason: string }[];
}

const TITLE_MAX = 80;
const EXCERPT_MAX = 400;

function cap(s: string, n: number): string {
	return s.length <= n ? s : `${s.slice(0, n - 3).trimEnd()}...`;
}

function sentence(s: string): string {
	const t = s.trim().replace(/\s+/g, " ");
	if (!t) return t;
	const up = t.charAt(0).toUpperCase() + t.slice(1);
	return /[.!?]$/.test(up) ? up : `${up}.`;
}

export function slug(parts: string[]): string {
	const s = parts
		.join("-")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");
	return s.slice(0, 60).replace(/-+$/g, "") || "reflect-lesson";
}

function findingFor(item: PortfolioItem, analysis: Analysis): Finding | undefined {
	if (item.finding) return analysis.findings.find((f) => f.id === item.finding);
	// Older analyses carry no link: fall back to the finding sharing the item's first evidence.
	const first = item.evidence[0];
	return first
		? analysis.findings.find((f) => f.evidence.some((e) => e.session === first.session && e.message === first.message))
		: undefined;
}

function reactedSessions(analysis: Analysis): Set<string> {
	const out = new Set<string>();
	for (const f of analysis.findings) if (NEGATIVE_REACTIONS.has(f.kind)) for (const s of f.sessions) out.add(s);
	return out;
}

export function reflectCandidates(analysis: Analysis, stamp: string): ReflectCandidatesOutput {
	const reacted = reactedSessions(analysis);
	const out: ReflectCandidatesOutput = {
		generated_at: analysis.generatedAt,
		window: analysis.window,
		candidates: [],
		skipped: [],
	};
	for (const item of analysis.portfolio) {
		if (item.action !== "create") {
			out.skipped.push({ item: item.id, reason: `action ${item.action} has no candidate rule yet` });
			continue;
		}
		const finding = findingFor(item, analysis);
		if (!finding) {
			out.skipped.push({ item: item.id, reason: "no finding links to this item" });
			continue;
		}
		if (item.evidence.length === 0) {
			out.skipped.push({ item: item.id, reason: "no evidence" });
			continue;
		}
		const r = (s: string) => redactPiiContent(s);
		const tool = item.evidence.find((e) => e.tool)?.tool ?? null;
		const subject = tool ?? "an unattributed tool";
		const negative = finding.sessions.some((s) => reacted.has(s));
		const learnedFrom = `reflect:${stamp}:${finding.id}`;
		out.candidates.push({
			kind: "skill",
			skill_name: slug(["reflect", tool ?? finding.kind, finding.id]),
			title: cap(r(sentence(finding.summary)), TITLE_MAX),
			applicability: r(`When ${subject} fails as in: ${sentence(finding.summary)}`),
			body: r(
				[
					`Do: add a skill that owns ${subject}: name the datasource it belongs to, the call that fails, and the check that prevents the failure.`,
					`Why: ${sentence(item.reason)} Recurred in ${item.recurrence} session(s) (${finding.count} occurrence(s), severity ${finding.severity}).`,
					`Confirm with: the next reflect window no longer lists ${subject} under tool-failure.`,
				].join("\n"),
			),
			evidence: item.evidence.slice(0, 5).map((e) => ({
				ref: `${learnedFrom}:${e.session}#${e.message}`,
				excerpt: cap(r(e.excerpt), EXCERPT_MAX),
			})),
			source: "reflect",
			learned_from: learnedFrom,
			status: negative ? "rejected" : "candidate",
			task_success: negative ? "0" : "",
			task_success_source: negative ? "reflect" : "",
		});
	}
	return out;
}
