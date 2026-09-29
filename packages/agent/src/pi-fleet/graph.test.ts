// agent/src/pi-fleet/graph.test.ts
// SIO-1888: the console's system message is assembled per call so the per-thread
// recall reaches every turn. The section builder is stubbed; the seam under test
// is that it is read at call time and lands in the leading SystemMessage.
import { describe, expect, mock, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";

let section = "";
mock.module("../agent-live-memory.ts", () => ({
	buildAgentLiveMemorySection: (agentName: string) => `${section}<${agentName}>`,
}));

import { PI_FLEET_AGENT_NAME, withFleetLiveMemory } from "./graph.ts";

describe("withFleetLiveMemory (SIO-1888)", () => {
	test("prepends one SystemMessage carrying the persona prompt plus the console's memory section", () => {
		section = "\n\n---\n\n## Live Memory\n\nrecalled fleet fact";
		const history = [new HumanMessage("what is eu-oit-dev doing?"), new AIMessage("checking")];
		const out = withFleetLiveMemory("PERSONA RULES", history);
		expect(out).toHaveLength(3);
		const sys = out[0];
		expect(sys).toBeInstanceOf(SystemMessage);
		const text = String(sys?.content);
		expect(text.startsWith("PERSONA RULES")).toBe(true);
		expect(text).toContain("recalled fleet fact");
		expect(text).toContain(`<${PI_FLEET_AGENT_NAME}>`);
		expect(out.slice(1)).toEqual(history);
	});

	test("is read on every call, not captured once at graph build", () => {
		section = "first";
		expect(String(withFleetLiveMemory("P", [])[0]?.content)).toContain("first");
		section = "second";
		const text = String(withFleetLiveMemory("P", [])[0]?.content);
		expect(text).toContain("second");
		expect(text).not.toContain("first");
	});
});
