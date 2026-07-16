// apps/web/src/lib/ticket-prefill.ts
const SUMMARY_MAX = 150;
const DESCRIPTION_MAX = 32_000;
const TRUNCATION_MARKER = "\n\n[truncated]";

// Summary seed: the first markdown heading if the report has one, else the
// first non-empty line. Light inline-markdown cleanup only; the user edits the
// result in the form before anything is sent.
export function prefillSummary(content: string): string {
	let firstLine = "";
	let heading = "";
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (!firstLine) firstLine = trimmed;
		const match = trimmed.match(/^#{1,6}\s+(.+)$/);
		if (match?.[1]) {
			heading = match[1].trim();
			break;
		}
	}
	const candidate = (heading || firstLine).replace(/[*_`]/g, "").trim();
	if (candidate.length <= SUMMARY_MAX) return candidate;
	return `${candidate.slice(0, SUMMARY_MAX - 3)}...`;
}

export function prefillDescription(content: string): string {
	if (content.length <= DESCRIPTION_MAX) return content;
	return content.slice(0, DESCRIPTION_MAX - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}
