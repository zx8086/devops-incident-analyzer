// apps/web/src/lib/stores/sse-buffer.test.ts
import { describe, expect, test } from "bun:test";
import type { StreamEvent } from "@devops-agent/shared";
import { parseSseChunks } from "./sse-buffer.ts";

function chunksOf(...strings: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const s of strings) controller.enqueue(encoder.encode(s));
			controller.close();
		},
	});
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<StreamEvent[]> {
	const out: StreamEvent[] = [];
	for await (const event of parseSseChunks(stream)) out.push(event);
	return out;
}

describe("parseSseChunks", () => {
	test("parses one event per data: line", async () => {
		const stream = chunksOf(
			`data: ${JSON.stringify({ type: "message", content: "hello" })}\n\n`,
			`data: ${JSON.stringify({ type: "node_start", nodeId: "classify" })}\n\n`,
		);
		const events = await collect(stream);
		expect(events).toEqual([
			{ type: "message", content: "hello" },
			{ type: "node_start", nodeId: "classify" },
		]);
	});

	test("reassembles events split across chunk boundaries", async () => {
		const payload = `data: ${JSON.stringify({ type: "message", content: "split" })}\n\n`;
		const mid = Math.floor(payload.length / 2);
		const events = await collect(chunksOf(payload.slice(0, mid), payload.slice(mid)));
		expect(events).toEqual([{ type: "message", content: "split" }]);
	});

	test("skips malformed JSON without throwing", async () => {
		const stream = chunksOf("data: {not-json}\n\n", `data: ${JSON.stringify({ type: "message", content: "ok" })}\n\n`);
		const events = await collect(stream);
		expect(events).toEqual([{ type: "message", content: "ok" }]);
	});

	test("ignores lines that do not start with 'data: '", async () => {
		const stream = chunksOf(`event: ping\n`, `data: ${JSON.stringify({ type: "message", content: "x" })}\n\n`);
		const events = await collect(stream);
		expect(events).toEqual([{ type: "message", content: "x" }]);
	});
});
