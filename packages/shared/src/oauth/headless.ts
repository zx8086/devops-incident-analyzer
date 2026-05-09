// src/oauth/headless.ts

// True when MCP_OAUTH_HEADLESS=true OR stdout is not a TTY (catches accidental
// headless on a server where the operator forgot to set the env explicitly).
export function isHeadless(): boolean {
	return process.env.MCP_OAUTH_HEADLESS === "true" || process.stdout.isTTY === false;
}
