// apps/web/src/lib/digest-emphasis.ts
// SIO-1720: a monitor report is a wall of same-weight lines. Two things carry the
// structure an operator scans for -- the check family on a finding line
// ((critical/alarm), (warn/logs), ...) and the label on a summary line
// (findings:, alarms:, spend yesterday:) -- so those are emphasised and nothing
// else is.
//
// Deliberately NOT "everything before the first colon": on a finding line that
// span is the family tag PLUS a 40-60 character resource name, so the emphasis
// would land on the noise rather than the class.
//
// SIO-1722: the family tag is now a coloured severity badge rather than bold
// text, so severity is legible at a glance instead of being read word by word.
// The badge is the ONLY HTML this file emits, and it is emitted from a fixed
// template whose only variable parts are (a) a severity matched against the
// SEVERITY allowlist below and (b) a family matched by /^\w+$/ -- so no
// monitor-authored character ever reaches the markup. Everything else stays a
// `**` marker for the existing markdown pipeline, which DOMPurify still
// sanitizes (`markdown.ts`, SIO-1042).

// `(severity/family)` at the head of a line or list item: two lowercase words in
// parentheses. Anchored so a parenthetical mid-sentence is never matched.
const FAMILY = /^(\s*(?:[-*+]\s+|\d+\.\s+)?)\((\w+)\/(\w+)\)/;

// `label:` at the head of a line -- lowercase words and spaces only, so a
// resource name (which carries digits, dots or dashes) cannot match. Requires
// something after the colon, so a bare trailing colon heading is left alone.
const LABEL = /^(\s*(?:[-*+]\s+|\d+\.\s+)?)([a-z][a-z ]{0,30}):(\s)/;

// Red / amber / slate, keyed on the severity words the monitors actually write.
// An unknown severity falls through to the old bold-text path rather than
// rendering an uncoloured badge, so a new monitor severity degrades visibly.
const SEVERITY: Record<string, string> = {
	critical: "bg-tommy-red-ui text-white",
	error: "bg-tommy-red-ui text-white",
	warn: "bg-amber-400 text-amber-950",
	warning: "bg-amber-400 text-amber-950",
	info: "bg-gray-200 text-gray-700",
};

function badge(severity: string, family: string): string {
	const tone = SEVERITY[severity];
	if (!tone || !/^\w+$/.test(family)) return `**(${severity}/${family})**`;
	return (
		`<span class="mr-1 inline-block rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${tone}">${severity}</span>` +
		`<span class="mr-1 text-[10px] uppercase tracking-wide text-gray-500">${family}</span>`
	);
}

/**
 * Badge the check severity and bold summary labels in a monitor report.
 *
 * Returns the text unchanged when it contains no recognisable structure, so a
 * plain spoke reply passes straight through.
 */
export function emphasiseDigest(text: string): string {
	if (!text) return text;
	return text
		.split("\n")
		.map((line) => {
			// A line already carrying emphasis is left as the monitor wrote it.
			if (line.includes("**")) return line;
			const family = line.match(FAMILY);
			if (family) {
				const lead = family[1] ?? "";
				const severity = family[2] ?? "";
				const name = family[3] ?? "";
				const rest = line.slice(family[0].length);
				// The badge already carries its own trailing margin, so the space the
				// monitor wrote after the tag is dropped -- but only on the badge path.
				// The bold-text fallback is plain markdown and still needs it.
				return SEVERITY[severity]
					? `${lead}${badge(severity, name)}${rest.replace(/^\s+/, "")}`
					: `${lead}${badge(severity, name)}${rest}`;
			}
			const label = line.match(LABEL);
			if (label) {
				const [, lead, name, trailing] = label;
				return `${lead}**${name}:**${trailing}${line.slice(label[0].length)}`;
			}
			return line;
		})
		.join("\n");
}
