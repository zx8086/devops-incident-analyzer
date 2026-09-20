// Temporary end-to-end check: the REAL instrumentTools closure + the REAL completion,
// wired exactly as sub-agent.ts wires them. Only the tool transport is faked.
import { describe, expect, test } from "bun:test";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { completeEcsEnumeration } from "./aws-absence-completion.ts";
import { instrumentTools } from "./sub-agent-instrumentation.ts";

describe("SIO-1784 end to end through the real closure", () => {
  test("a lazily-enumerated estate is completed and the proof holds", async () => {
    const CLUSTERS = ["shared-services-prd", "elastic-prd", "open-telemetry-prd", "confluent-prd"];
    const listClusters = tool(async () => JSON.stringify({ clusterArns: CLUSTERS.map(c => `arn:aws:ecs:eu-central-1:1:cluster/${c}`) }),
      { name: "aws_ecs_list_clusters", description: "d", schema: z.object({}) });
    const listServices = tool(async () => JSON.stringify({ serviceArns: [] }),
      { name: "aws_ecs_list_services", description: "d", schema: z.object({ cluster: z.string(), cursor: z.string().optional() }) });

    const runSignals: { serviceAbsent: boolean; absenceBlockedBy?: string | null;
      observeEcsPage?: (t: string, c: unknown, a: unknown) => void } = { serviceAbsent: false };

    const log = { info: () => {}, warn: () => {} };
    const wrapped = instrumentTools([listClusters, listServices], {
      dataSourceId: "aws", log, awsAbsenceEarlyExit: true,
      focusServices: ["prana-import-export-service"], runSignals,
    } as never);
    const byName = new Map(wrapped.map(w => [w.name, w]));

    // The model lists clusters, then walks ONLY the first -- the live lazy case.
    await byName.get("aws_ecs_list_clusters")?.invoke({ id: "c", name: "aws_ecs_list_clusters", args: {}, type: "tool_call" });
    await byName.get("aws_ecs_list_services")?.invoke({ id: "s", name: "aws_ecs_list_services", args: { cluster: CLUSTERS[0] }, type: "tool_call" });

    expect(runSignals.serviceAbsent).toBe(false);
    expect(runSignals.absenceBlockedBy).toBe(`services-incomplete:${CLUSTERS.slice(1).join(",")}`);

    // Now the post-loop completion, via the UNINSTRUMENTED tools, as sub-agent.ts does.
    const walked = await completeEcsEnumeration({
      invoke: async (_n, args) => await listServices.invoke(args as { cluster: string }),
      observe: (t, c, a) => runSignals.observeEcsPage?.(t, c, a),
      blocker: () => runSignals.absenceBlockedBy,
    });

    expect(walked).toEqual(CLUSTERS.slice(1));
    expect(runSignals.absenceBlockedBy).toBeNull();
    expect(runSignals.serviceAbsent).toBe(true);
  });
});
