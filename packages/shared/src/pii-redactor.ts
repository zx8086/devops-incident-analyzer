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

export function redactPiiContent(text: string): string {
	let result = text;
	for (const pattern of PII_PATTERNS) {
		result = result.replace(pattern.regex, pattern.replacement);
	}
	return result;
}
