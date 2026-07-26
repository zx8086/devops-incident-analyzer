// agent/src/sub-agent-reasoning-block-guard.test.ts
//
// SIO-1216: @langchain/aws@0.1.15 (and 1.3.x up to 1.3.7) serialized a Bedrock
// Converse reasoning block back onto the wire without validating reasoningText.text
// was a non-empty string. Claude Sonnet 5 (always-on adaptive thinking) can produce
// a signature-only reasoning block on a ReAct loop replay; Bedrock's Converse API
// rejects that with "Member must not be null" for reasoningContent.reasoningText.text.
// Fixed upstream in @langchain/aws@1.4.3 (langchain-ai/langchainjs#11200). This is a
// live-dependency assertion, not a mock -- it fails loudly if the catalog pin ever
// regresses to a version that reintroduces the bug, since no unit-level mock of
// ChatBedrockConverse can reproduce a real Bedrock API validation error.
import { describe, expect, test } from "bun:test";

describe("@langchain/aws reasoning-block guard (SIO-1216)", () => {
	test("installed @langchain/aws version is at least 1.4.3", async () => {
		const pkg = await import("@langchain/aws/package.json", { with: { type: "json" } });
		const version = (pkg.default as { version: string }).version;
		// Strip prerelease/build metadata (e.g. "1.4.3-beta.1", "1.4.3+build5") before
		// parsing, so a prerelease of a fixed version doesn't fail this guard.
		const core = version.split(/[-+]/)[0] ?? version;
		const parts = core.split(".").map(Number);
		const major = parts[0] ?? 0;
		const minor = parts[1] ?? 0;
		const patch = parts[2] ?? 0;
		const atLeast143 = major > 1 || (major === 1 && (minor > 4 || (minor === 4 && patch >= 3)));
		expect(atLeast143).toBe(true);
	});
});
