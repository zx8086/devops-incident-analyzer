// apps/web/src/lib/components/StreamingProgress.test.ts

import { describe, expect, test } from "bun:test";
import { render } from "svelte/server";
import StreamingProgress from "./StreamingProgress.svelte";

describe("StreamingProgress.svelte", () => {
	test("renders Landing Zone phases instead of incident phases", () => {
		const { body } = render(StreamingProgress, {
			props: {
				variant: "landing-zone",
				activeNodes: new Map([["resolveScope", 1]]),
				completedNodes: new Map([["classifyRequest", { duration: 25 }]]),
			},
		});

		expect(body).toContain("Resolving repository");
		expect(body).toContain("Request classified");
		expect(body).toContain("Selecting PVH knowledge");
		expect(body).not.toContain("Normalizing");
		expect(body).not.toContain("Querying");
	});
});
