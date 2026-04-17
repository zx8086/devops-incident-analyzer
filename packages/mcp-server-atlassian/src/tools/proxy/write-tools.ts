// src/tools/proxy/write-tools.ts

export const WRITE_TOOL_PATTERNS = [
	/^create/i,
	/^update/i,
	/^delete/i,
	/^add.*(?:Comment|Attachment)/i,
	/^transition/i,
	/^assign/i,
	/^move/i,
];

export function isWriteTool(name: string): boolean {
	return WRITE_TOOL_PATTERNS.some((re) => re.test(name));
}
