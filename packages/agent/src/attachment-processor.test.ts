// agent/src/attachment-processor.test.ts

import { describe, expect, test } from "bun:test";
import type { ImageBlock, PdfBlock, TextFileBlock } from "@devops-agent/shared";
import { AttachmentError, processAttachments } from "./attachment-processor.ts";

// 1x1 transparent PNG as base64 (smallest valid PNG)
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const makeImage = (overrides: Partial<ImageBlock> = {}): ImageBlock => ({
	type: "image",
	mimeType: "image/png",
	base64: TINY_PNG_BASE64,
	filename: "screenshot.png",
	sizeBytes: 100,
	...overrides,
});

const makePdf = (overrides: Partial<PdfBlock> = {}): PdfBlock => ({
	type: "pdf",
	base64: "JVBERi0xLjQK",
	filename: "runbook.pdf",
	sizeBytes: 200,
	...overrides,
});

const makeTextFile = (overrides: Partial<TextFileBlock> = {}): TextFileBlock => ({
	type: "text_file",
	content: "# Incident Runbook\n\nStep 1: Check logs.",
	filename: "runbook.md",
	sizeBytes: 50,
	...overrides,
});

describe("processAttachments", () => {
	test("processes a single image into an image_url content block", async () => {
		const result = await processAttachments([makeImage()]);

		expect(result.contentBlocks).toHaveLength(1);
		expect(result.contentBlocks[0]).toMatchObject({
			type: "image_url",
			image_url: {
				url: `data:image/png;base64,${TINY_PNG_BASE64}`,
			},
		});

		expect(result.metadata).toHaveLength(1);
		expect(result.metadata[0]).toMatchObject({
			filename: "screenshot.png",
			type: "image",
			mimeType: "image/png",
		});

		expect(result.warnings).toHaveLength(0);
	});

	test("processes a PDF into a document content block", async () => {
		const result = await processAttachments([makePdf()]);

		expect(result.contentBlocks).toHaveLength(1);
		const block = result.contentBlocks[0] as Record<string, unknown>;
		expect(block).toHaveProperty("source");

		expect(result.metadata[0]).toMatchObject({
			filename: "runbook.pdf",
			type: "pdf",
		});
	});

	test("warns on large PDFs (>50 pages)", async () => {
		const result = await processAttachments([makePdf({ pageCount: 75 })]);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("75 pages");
	});

	test("processes text files with code fence for structured formats", async () => {
		const yamlFile: TextFileBlock = {
			type: "text_file",
			content: "apiVersion: v1\nkind: Service",
			filename: "service.yaml",
			sizeBytes: 40,
		};

		const result = await processAttachments([yamlFile]);
		const block = result.contentBlocks[0] as { type: string; text: string };
		expect(block.type).toBe("text");
		expect(block.text).toContain("```yaml");
		expect(block.text).toContain("## Attached File: service.yaml");
	});

	test("handles multiple mixed attachments", async () => {
		const result = await processAttachments([makeImage(), makePdf(), makeTextFile()]);

		expect(result.contentBlocks).toHaveLength(3);
		expect(result.metadata).toHaveLength(3);
		expect(result.metadata.map((m) => m.type)).toEqual(["image", "pdf", "text"]);
	});

	test("rejects when too many attachments", async () => {
		const tooMany = Array.from({ length: 11 }, (_, i) => makeImage({ filename: `img${i}.png` }));

		await expect(processAttachments(tooMany)).rejects.toThrow(AttachmentError);
		await expect(processAttachments(tooMany)).rejects.toThrow("Too many attachments");
	});

	test("rejects when individual file exceeds size limit", async () => {
		const oversized = makeImage({ sizeBytes: 25 * 1024 * 1024 }); // 25 MB > 20 MB limit

		await expect(processAttachments([oversized])).rejects.toThrow(AttachmentError);
		await expect(processAttachments([oversized])).rejects.toThrow("exceeds");
	});

	test("rejects when total size exceeds limit", async () => {
		const bulky = Array.from({ length: 6 }, (_, i) =>
			makeImage({ filename: `img${i}.png`, sizeBytes: 10 * 1024 * 1024 }),
		);

		await expect(processAttachments(bulky)).rejects.toThrow(AttachmentError);
		await expect(processAttachments(bulky)).rejects.toThrow("Total attachment size");
	});

	test("processes empty attachment array", async () => {
		const result = await processAttachments([]);
		expect(result.contentBlocks).toHaveLength(0);
		expect(result.metadata).toHaveLength(0);
		expect(result.warnings).toHaveLength(0);
	});

	test("handles all supported image MIME types", async () => {
		const types = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

		for (const mimeType of types) {
			const result = await processAttachments([makeImage({ mimeType })]);
			const block = result.contentBlocks[0] as { type: string; image_url: { url: string } };
			expect(block.image_url.url).toStartWith(`data:${mimeType};base64,`);
		}
	});
});
