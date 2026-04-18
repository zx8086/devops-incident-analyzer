// apps/web/src/lib/stores/sse-buffer.ts

import type { StreamEvent } from "@devops-agent/shared";

export async function* parseSseChunks(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";

		for (const line of lines) {
			if (!line.startsWith("data: ")) continue;
			try {
				yield JSON.parse(line.slice(6)) as StreamEvent;
			} catch {
				// Malformed events are skipped, matching the existing store behavior
			}
		}
	}
}
