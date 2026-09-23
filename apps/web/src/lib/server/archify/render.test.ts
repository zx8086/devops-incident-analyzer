// apps/web/src/lib/server/archify/render.test.ts
import { describe, expect, test } from "bun:test";
import { APPLICATION_FIXTURE } from "./fixtures.ts";
import { embedHtml, RendererBusyError, remember, renderDiagram, rendererLoad, svgViewBox } from "./render.ts";
import { applicationToArchify } from "./to-archify.ts";

describe("renderDiagram admission (Greptile P1 on #904)", () => {
	test("a burst runs 2, queues 8, refuses the rest as busy, and returns every slot", async () => {
		const diagram = applicationToArchify(APPLICATION_FIXTURE);
		const calls = Array.from({ length: 12 }, () => renderDiagram("architecture", diagram));

		// Admission is synchronous, so the counts are exact before any render starts.
		expect(rendererLoad()).toEqual({ active: 2, queued: 8 });

		const settled = await Promise.allSettled(calls);
		const refused = settled.filter((s) => s.status === "rejected");
		expect(refused).toHaveLength(2);
		for (const r of refused) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(RendererBusyError);
		const rendered = settled.filter((s) => s.status === "fulfilled" && s.value.ok);
		expect(rendered).toHaveLength(10);

		// Slot hand-over must not leak or double-free.
		expect(rendererLoad()).toEqual({ active: 0, queued: 0 });
	}, 60_000);
});

describe("remember", () => {
	test("evicts the oldest entries past the cap and keeps the newest", () => {
		const cache = new Map<string, number>();
		for (let i = 0; i < 5; i++) remember(cache, `k${i}`, i, 3);
		expect([...cache.keys()]).toEqual(["k2", "k3", "k4"]);
	});
});

describe("embed sizing (SIO-1878)", () => {
	test("embedHtml caps the SVG at the frame height, and svgViewBox reads the diagram size", async () => {
		const result = await renderDiagram("architecture", applicationToArchify(APPLICATION_FIXTURE));
		if (!result.ok) throw new Error(result.error);
		const html = embedHtml(result.html, "dark");
		// Archify's embed CSS hides overflow, so without this cap a tall diagram is clipped.
		expect(html).toContain("max-height:calc(100vh - 1rem)");
		expect(html.indexOf("max-height:calc(100vh")).toBeLessThan(html.indexOf("</head>"));
		const box = svgViewBox(result.html);
		expect(box?.width).toBeGreaterThan(0);
		expect(box?.height).toBeGreaterThan(0);
		expect(svgViewBox('<svg role="img">')).toBeNull();
	}, 30_000);
});
