// shared/src/pii-redactor.ts

interface PiiPattern {
	readonly name: string;
	readonly regex: RegExp;
	readonly replacement: string;
}

const PII_PATTERNS: readonly PiiPattern[] = [
	{
		name: "ssn",
		regex: /\b\d{3}-\d{2}-\d{4}\b/g,
		replacement: "[SSN_REDACTED]",
	},
	{
		name: "credit_card",
		regex: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{1,7}\b/g,
		replacement: "[CC_REDACTED]",
	},
	{
		name: "email",
		regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
		replacement: "[EMAIL_REDACTED]",
	},
	{
		// Require at least one separator so bare 10-digit identifiers (ES node
		// suffixes, sequence IDs) are not mistaken for phone numbers — especially
		// when text is redacted chunk-by-chunk during SSE streaming, where a
		// lookbehind on `^` would otherwise match arbitrary token boundaries.
		name: "us_phone",
		regex:
			/(?:\+?1[-.\s])?(?:\(\d{3}\)\s?\d{3}[-.\s]?\d{4}|\b\d{3}[-.\s]\d{3}[-.\s]?\d{4}\b|\b\d{3}[-.\s]?\d{3}[-.\s]\d{4}\b)/g,
		replacement: "[PHONE_REDACTED]",
	},
	{
		name: "ipv4",
		regex: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
		replacement: "[IP_REDACTED]",
	},
];

// Corporate / directory domains where email addresses are already public to the
// user (e.g. Jira ticket assignees). Emails matching these domains are restored
// after pattern redaction so the rendered output stays consistent with what the
// user can see directly in the source ticket.
function getAllowedEmailDomains(): string[] {
	const raw = process.env.PII_REDACTION_ALLOWED_DOMAINS;
	if (!raw) return [];
	return raw
		.split(",")
		.map((d) => d.trim().toLowerCase())
		.filter((d) => d.length > 0);
}

export function redactPiiContent(text: string): string {
	const allowedDomains = getAllowedEmailDomains();

	// Preserve allowlisted emails by swapping them for sentinels before pattern
	// redaction, then restoring after. Sentinels use a form that cannot match
	// any PII pattern (no @ sign, no digit runs).
	const preserved = new Map<string, string>();
	let prepared = text;
	if (allowedDomains.length > 0) {
		const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
		prepared = text.replace(emailRegex, (match) => {
			const domain = match.slice(match.indexOf("@") + 1).toLowerCase();
			if (!allowedDomains.some((d) => domain === d || domain.endsWith(`.${d}`))) {
				return match;
			}
			const sentinel = `PIIALLOWED${preserved.size}XENDX`;
			preserved.set(sentinel, match);
			return sentinel;
		});
	}

	let result = prepared;
	for (const pattern of PII_PATTERNS) {
		result = result.replace(pattern.regex, pattern.replacement);
	}

	for (const [sentinel, original] of preserved) {
		result = result.split(sentinel).join(original);
	}

	return result;
}
