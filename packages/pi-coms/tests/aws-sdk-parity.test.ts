// packages/pi-coms/tests/aws-sdk-parity.test.ts
// SIO-1654: the monitor's AWS SDK clients live in the nested scripts/package.json
// (non-workspace, SIO-1632) and the analyzer's live in packages/mcp-server-aws.
// Neither install sees the other, so the major versions are pinned to each other
// here. It is a ratchet: when it goes red, align the two lists on purpose.
import { describe, expect, test } from "bun:test";
import root from "../../../package.json" with { type: "json" };
import mcpAws from "../../mcp-server-aws/package.json" with { type: "json" };
import monitor from "../scripts/package.json" with { type: "json" };

function major(range: string, name: string): string {
	const m = /(\d+)\./.exec(range);
	if (!m?.[1]) throw new Error(`unparseable version range for ${name}: ${range}`);
	return m[1];
}

describe("AWS SDK major-version parity (SIO-1654)", () => {
	const monitorDeps = monitor.dependencies as Record<string, string>;
	const analyzerDeps = mcpAws.dependencies as Record<string, string>;

	test("the monitor declares its nine AWS SDK clients", () => {
		const clients = Object.keys(monitorDeps).filter((n) => n.startsWith("@aws-sdk/client-"));
		expect(clients.length).toBe(9);
	});

	test("every monitor client shares the analyzer's AWS SDK major", () => {
		const reference = analyzerDeps["@aws-sdk/client-sts"];
		if (!reference) throw new Error("mcp-server-aws no longer depends on @aws-sdk/client-sts");
		const expected = major(reference, "@aws-sdk/client-sts");
		for (const [name, range] of Object.entries(monitorDeps)) {
			if (!name.startsWith("@aws-sdk/client-")) continue;
			expect({ name, major: major(range, name) }).toEqual({ name, major: expected });
		}
	});

	test("the monitor's zod major matches the root catalog", () => {
		const catalog = root.workspaces.catalog as Record<string, string>;
		const rootZod = catalog.zod;
		const monitorZod = monitorDeps.zod;
		if (!rootZod || !monitorZod) throw new Error("zod missing from the root catalog or scripts/package.json");
		expect(major(monitorZod, "zod")).toBe(major(rootZod, "zod"));
	});
});
