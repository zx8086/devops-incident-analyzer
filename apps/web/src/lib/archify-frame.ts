// apps/web/src/lib/archify-frame.ts

// SIO-1878: the Diagram tab's iframe takes the diagram's own aspect ratio instead of a fixed
// 28rem, so a wide two-column map is not left with half the frame empty and a tall one is not cut
// off. The embedded diagram container pads 0.5rem (8px) on each side.
const PAD = 16;
export const MIN_FRAME_PX = 192;
export const MAX_FRAME_PX = 640;
const FALLBACK_FRAME_PX = 448;

// viewBox is the "width height" pair from the x-archify-viewbox header; frameWidth is the iframe's
// rendered width. Past MAX_FRAME_PX the diagram is scaled down to fit (the embed CSS caps it at the
// frame height), which keeps a very tall map on screen instead of making the card enormous.
export function diagramFrameHeight(viewBox: string | null, frameWidth: number): number {
	const [w, h] = (viewBox ?? "").split(" ").map(Number);
	if (!w || !h || !(frameWidth > 0)) return FALLBACK_FRAME_PX;
	const natural = ((frameWidth - PAD) * h) / w + PAD;
	return Math.round(Math.min(MAX_FRAME_PX, Math.max(MIN_FRAME_PX, natural)));
}
