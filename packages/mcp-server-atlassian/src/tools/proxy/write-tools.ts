// src/tools/proxy/write-tools.ts

// SIO-1183 (SIO-1181 audit F4): editJiraIssue and addWorklogToJiraIssue leaked through the
// read-only filter -- no /^edit/ pattern, and the add-pattern did not cover Worklog.
export const WRITE_TOOL_PATTERNS = [
	/^create/i,
	/^update/i,
	/^edit/i,
	/^delete/i,
	/^add.*(?:Comment|Attachment|Worklog)/i,
	/^transition/i,
	/^assign/i,
	/^move/i,
];

export function isWriteTool(name: string): boolean {
	return WRITE_TOOL_PATTERNS.some((re) => re.test(name));
}
