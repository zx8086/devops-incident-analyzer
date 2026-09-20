// packages/agent/src/reflect/report.ts
//
// SIO-1834 (A4): the markdown is RENDERED from the analysis object, never written beside
// it, so the two cannot disagree. Edit the JSON (or the code), never the markdown.
import type { Analysis } from "./aggregate.ts";

function table(headers: string[], rows: string[][]): string[] {
	if (!rows.length) return [];
	return [
		`| ${headers.join(" | ")} |`,
		`|${headers.map(() => "---").join("|")}|`,
		...rows.map((row) => `| ${row.join(" | ")} |`),
	];
}

export function renderMarkdown(analysis: Analysis): string {
	const lines: string[] = [];
	const { stats, window } = analysis;

	lines.push("# Skill reflection report", "");
	lines.push(`Window: ${window.hours}h (${window.since} to ${window.until})`);
	lines.push(`Generated: ${analysis.generatedAt}`, "");
	lines.push(
		`${stats.sessions} sessions (${stats.headless} headless), ${stats.signals} signals, ` +
			`${stats.high} high. ${stats.findings} findings, ${stats.portfolio} portfolio moves.`,
		"",
	);

	// Surfaced before the findings: a reader who does not know the quality lane was starved
	// will read its silence as a clean bill of health.
	if (analysis.notes.length) {
		lines.push("## Read this first", "");
		for (const note of analysis.notes) lines.push(`- ${note}`);
		lines.push("");
	}

	lines.push("## Datasources in use", "");
	const dsRows = analysis.datasources.map((d) => [
		d.name,
		String(d.sessions),
		String(d.high),
		String(d.medium),
		String(d.low),
	]);
	lines.push(...(table(["Datasource", "Sessions", "High", "Medium", "Low"], dsRows) ?? []));
	if (!dsRows.length) lines.push("_No datasource carried a signal in this window._");
	lines.push("");

	lines.push("## Findings", "");
	if (!analysis.findings.length) {
		lines.push(`_No gap recurred in ${2} or more sessions._`, "");
	} else {
		for (const finding of analysis.findings) {
			lines.push(
				`### ${finding.id} -- ${finding.kind}: ${finding.summary}`,
				"",
				`- **Datasource:** ${finding.datasource ?? "_none -- nothing owns this gap_"}`,
				`- **Class:** ${finding.class}`,
				`- **Severity:** ${finding.severity}`,
				`- **Recurrence:** ${finding.recurrence} sessions (${finding.count} occurrences)`,
			);
			if (finding.change) lines.push(`- **Change:** ${finding.change}`);
			lines.push("", "Evidence:", "");
			for (const item of finding.evidence) {
				const tool = item.tool ? `\`${item.tool}\` ` : "";
				lines.push(`- ${tool}(run \`${item.session}\`, message ${item.message}): ${item.excerpt}`);
			}
			lines.push("");
		}
	}

	if (analysis.retries.length) {
		lines.push("## Cross-session retries", "");
		lines.push(
			...table(
				["Earlier", "Later", "Gap (h)", "Overlap"],
				analysis.retries.map((r) => [`\`${r.earlier}\``, `\`${r.later}\``, String(r.hours), String(r.overlap)]),
			),
		);
		lines.push("");
	}

	lines.push("## Portfolio", "");
	if (!analysis.portfolio.length) {
		lines.push("_No create/merge/split/delete candidate._", "");
	} else {
		for (const item of analysis.portfolio) {
			lines.push(
				`- **${item.id} ${item.action}**: ${item.reason} (${item.recurrence} sessions)` +
					(item.datasources.length ? ` -- ${item.datasources.join(", ")}` : ""),
			);
		}
		lines.push("");
	}

	lines.push("---", "");
	lines.push(
		"_Every finding is a lead, not a verdict. Open the run it cites and confirm the gap before acting on it._",
	);

	return `${lines.join("\n")}\n`;
}
