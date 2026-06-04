// src/oauth/headless.ts

// True when MCP_OAUTH_HEADLESS=true OR stdout is not a TTY (catches accidental
// headless on a server where the operator forgot to set the env explicitly).
//
// SIO-897: MCP_OAUTH_FORCE_INTERACTIVE=true is a hard override set ONLY by the
// interactive seed CLIs. The seeders run through a nested `bun run --filter`
// chain that pipes stdout, so process.stdout.isTTY is false even at a real
// terminal -- the TTY check would otherwise mark them headless and the browser
// flow would never start. No MCP server sets this flag, so server-side headless
// detection (including the TTY safety net) is unchanged.
export function isHeadless(): boolean {
	if (process.env.MCP_OAUTH_FORCE_INTERACTIVE === "true") return false;
	return process.env.MCP_OAUTH_HEADLESS === "true" || process.stdout.isTTY === false;
}
