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
// The text is monitor-authored and untrusted. This only inserts `**` markers,
// which the existing markdown pipeline renders and DOMPurify sanitizes
// (`markdown.ts`, SIO-1042) -- no HTML is produced here, and any `**` already in
// the source is left alone.

// `(severity/family)` at the head of a line or list item: two lowercase words in
// parentheses. Anchored so a parenthetical mid-sentence is never matched.
const FAMILY = /^(\s*(?:[-*+]\s+|\d+\.\s+)?)\((\w+\/\w+)\)/;

// `label:` at the head of a line -- lowercase words and spaces only, so a
// resource name (which carries digits, dots or dashes) cannot match. Requires
// something after the colon, so a bare trailing colon heading is left alone.
const LABEL = /^(\s*(?:[-*+]\s+|\d+\.\s+)?)([a-z][a-z ]{0,30}):(\s)/;

/**
 * Bold the check family and summary labels in a monitor report.
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
				const [, lead, tag] = family;
				return `${lead}**(${tag})**${line.slice(family[0].length)}`;
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
