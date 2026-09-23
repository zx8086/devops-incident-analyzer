// apps/web/src/lib/app-css-animations.test.ts
import { describe, expect, test } from "bun:test";

// SIO-1879: every chat message wraps in `animate-slide-up-fade`. A `forwards` (or `both`) fill holds
// the last keyframe, leaving an identity transform on the wrapper, which makes it the containing
// block and stacking context for position:fixed descendants: the topology cards' "full-screen"
// expand dialogs then opened inside their message, under the app header. Measured in the running
// app: dialog top 148 px with the fill, 40 px (the intended inset) without it.
describe("app.css entry animation", () => {
	test("slide-up-fade does not hold its end state", async () => {
		const css = await Bun.file(new URL("../app.css", import.meta.url)).text();
		const value = css.match(/--animate-slide-up-fade:\s*([^;]+);/)?.[1];
		expect(value).toBeDefined();
		expect(value).toContain("slide-up-fade");
		expect(value).not.toMatch(/\b(forwards|both)\b/);
	});
});
