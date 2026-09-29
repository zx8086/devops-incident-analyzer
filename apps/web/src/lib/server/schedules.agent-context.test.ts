// apps/web/src/lib/server/schedules.agent-context.test.ts
// SIO-1887 (Greptile PR #915): scheduled sweeps run outside any HTTP request, so
// they must open their own request context naming the agent they act for, or
// their live-memory writes fall to the writer's incident-analyzer default.
import { describe, expect, test } from "bun:test";
import { getCurrentRequestContext } from "@devops-agent/shared";
import { SCHEDULE_AGENTS, SCHEDULE_NODE_HANDLERS, underScheduleAgent } from "./schedules.ts";

describe("scheduled sweeps carry their agent on the request context (SIO-1887)", () => {
	test("the sweep body sees the declared agent and a schedule-scoped thread id", async () => {
		let seen: ReturnType<typeof getCurrentRequestContext>;
		const run = underScheduleAgent("iac-gitlab-import-sweep", async () => {
			seen = getCurrentRequestContext();
			return "done";
		});
		expect(getCurrentRequestContext()).toBeUndefined();
		await expect(run()).resolves.toBe("done");
		expect(seen?.agentName).toBe("elastic-iac");
		expect(seen?.threadId).toBe("schedule:iac-gitlab-import-sweep");
		expect(seen?.runId).toBeTruthy();
	});

	test("every registered sweep declares an agent, and the IaC sweeps are elastic-iac", () => {
		const handlerIds = Object.keys(SCHEDULE_NODE_HANDLERS.nodes).sort();
		expect(Object.keys(SCHEDULE_AGENTS).sort()).toEqual(handlerIds);
		expect(SCHEDULE_AGENTS["iac-reconcile-sweep"]).toBe("elastic-iac");
		expect(SCHEDULE_AGENTS["iac-gitlab-import-sweep"]).toBe("elastic-iac");
		expect(SCHEDULE_AGENTS["lz-gitlab-import-sweep"]).toBe("landing-zone-terraform");
	});
});
