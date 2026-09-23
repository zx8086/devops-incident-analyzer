// apps/web/src/lib/archify-frame.test.ts
import { describe, expect, test } from "bun:test";
import { diagramFrameHeight, MAX_FRAME_PX, MIN_FRAME_PX } from "./archify-frame.ts";

describe("diagramFrameHeight (SIO-1878)", () => {
	test("takes the diagram's aspect ratio at the frame's width, plus the container padding", () => {
		// 390px frame, 16px padding: 374px drawn width; a 620x772 viewBox draws 374*772/620 = 465.7 tall.
		expect(diagramFrameHeight("620 772", 390)).toBe(482);
	});

	test("is clamped so a wide map keeps some height and a tall one does not take over the page", () => {
		expect(diagramFrameHeight("2000 100", 390)).toBe(MIN_FRAME_PX);
		expect(diagramFrameHeight("600 6000", 390)).toBe(MAX_FRAME_PX);
	});

	test("falls back to the old fixed height with no viewBox or before the frame is measured", () => {
		expect(diagramFrameHeight(null, 390)).toBe(448);
		expect(diagramFrameHeight("620 772", 0)).toBe(448);
		expect(diagramFrameHeight("garbage", 390)).toBe(448);
	});
});
