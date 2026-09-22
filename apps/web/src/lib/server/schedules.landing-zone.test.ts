// apps/web/src/lib/server/schedules.landing-zone.test.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { SCHEDULE_NODE_HANDLERS } from "./schedules.ts";

const ROOT = join(import.meta.dir, "../../../../..");

describe("Landing Zone GitLab import schedule", () => {
	test("is disabled by default and binds its distinct sweep node", () => {
		const schedule = parse(readFileSync(join(ROOT, "schedules/lz-gitlab-import-sweep.yaml"), "utf8")) as Record<string, unknown>;
		const workflow = parse(
			readFileSync(join(ROOT, "agents/landing-zone-terraform/workflows/gitlab-import-sweep.yaml"), "utf8"),
		) as { steps: Array<{ node?: string }> };

		expect(schedule).toMatchObject({
			id: "lz-gitlab-import-sweep",
			workflow: "gitlab-import-sweep",
			enabled: false,
		});
		expect(workflow.steps.map((step) => step.node)).toEqual(["lz-gitlab-import-sweep"]);
		expect(SCHEDULE_NODE_HANDLERS.nodes).toHaveProperty("lz-gitlab-import-sweep");
	});
});
