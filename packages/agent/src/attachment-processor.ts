// agent/src/attachment-processor.ts

import { getLogger } from "@devops-agent/observability";
import {
	type AttachmentBlock,
	type AttachmentMeta,
	type DocxBlock,
	type ImageBlock,
	MAX_ATTACHMENTS,
	MAX_TOTAL_ATTACHMENT_BYTES,
	type PdfBlock,
	SIZE_LIMITS,
	type TextFileBlock,
} from "@devops-agent/shared";
import type { MessageContentComplex } from "@langchain/core/messages";
import mammoth from "mammoth";

const logger = getLogger("agent:attachment-processor");

export interface ProcessedAttachments {
	contentBlocks: MessageContentComplex[];
	metadata: AttachmentMeta[];
	warnings: string[];
}

export async function processAttachments(attachments: AttachmentBlock[]): Promise<ProcessedAttachments> {
	const contentBlocks: MessageContentComplex[] = [];
	const metadata: AttachmentMeta[] = [];
	const warnings: string[] = [];

	if (attachments.length > MAX_ATTACHMENTS) {
		throw new AttachmentError(`Too many attachments: ${attachments.length} (max ${MAX_ATTACHMENTS})`);
	}

	const totalBytes = attachments.reduce((sum, a) => sum + a.sizeBytes, 0);
	if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
		throw new AttachmentError(
			`Total attachment size ${formatBytes(totalBytes)} exceeds limit of ${formatBytes(MAX_TOTAL_ATTACHMENT_BYTES)}`,
		);
	}

	for (const attachment of attachments) {
		const limit = SIZE_LIMITS[attachment.type];
		if (attachment.sizeBytes > limit) {
			throw new AttachmentError(
				`${attachment.filename} (${formatBytes(attachment.sizeBytes)}) exceeds ${attachment.type} limit of ${formatBytes(limit)}`,
			);
		}

		switch (attachment.type) {
			case "image":
				contentBlocks.push(processImage(attachment));
				metadata.push({
					filename: attachment.filename,
					type: "image",
					mimeType: attachment.mimeType,
					sizeBytes: attachment.sizeBytes,
				});
				break;

			case "pdf":
				contentBlocks.push(processPdf(attachment));
				metadata.push({
					filename: attachment.filename,
					type: "pdf",
					sizeBytes: attachment.sizeBytes,
					pageCount: attachment.pageCount,
				});
				if (attachment.pageCount && attachment.pageCount > 50) {
					warnings.push(
						`${attachment.filename} has ${attachment.pageCount} pages -- Claude processes up to ~100 pages; consider extracting relevant sections.`,
					);
				}
				break;

			case "docx": {
				const { block, extractedLength } = await processDocx(attachment);
				contentBlocks.push(block);
				metadata.push({
					filename: attachment.filename,
					type: "text",
					sizeBytes: attachment.sizeBytes,
				});
				if (extractedLength > 100_000) {
					warnings.push(
						`${attachment.filename} extracted ${extractedLength.toLocaleString()} characters -- large documents may consume significant context window.`,
					);
				}
				break;
			}

			case "text_file":
				contentBlocks.push(processTextFile(attachment));
				metadata.push({
					filename: attachment.filename,
					type: "text",
					sizeBytes: attachment.sizeBytes,
				});
				break;
		}
	}

	return { contentBlocks, metadata, warnings };
}

// ChatBedrockConverse translates image_url content blocks to Bedrock's ImageBlock format
function processImage(img: ImageBlock): MessageContentComplex {
	return {
		type: "image_url",
		image_url: {
			url: `data:${img.mimeType};base64,${img.base64}`,
		},
	};
}

// ChatBedrockConverse (v0.1.4+) supports the "document" content type
// which maps to Bedrock's DocumentBlock for native PDF processing
function processPdf(pdf: PdfBlock): MessageContentComplex {
	return {
		type: "document" as "image_url", // LangChain type gap -- ChatBedrockConverse handles at API layer
		source: {
			type: "base64",
			media_type: "application/pdf",
			data: pdf.base64,
		},
		metadata: {
			name: sanitizeDocumentName(pdf.filename),
		},
	} as unknown as MessageContentComplex;
}

async function processDocx(docx: DocxBlock): Promise<{ block: MessageContentComplex; extractedLength: number }> {
	const buffer = Buffer.from(docx.base64, "base64");
	const { value: text, messages } = await mammoth.extractRawText({ buffer });

	if (messages.length > 0) {
		logger.warn({ filename: docx.filename, warnings: messages.map((m) => m.message) }, "mammoth extraction warnings");
	}

	const content = [`## Attached Document: ${docx.filename}`, "", text.trim()].join("\n");

	return {
		block: { type: "text", text: content },
		extractedLength: text.length,
	};
}

function processTextFile(file: TextFileBlock): MessageContentComplex {
	const ext = file.filename.split(".").pop() ?? "txt";
	const content = [
		`## Attached File: ${file.filename}`,
		"",
		ext === "json" || ext === "yaml" || ext === "yml"
			? `\`\`\`${ext}\n${file.content.trim()}\n\`\`\``
			: file.content.trim(),
	].join("\n");

	return { type: "text", text: content };
}

// Bedrock requires: alphanumeric, whitespace, hyphens, parens, brackets, max 200 chars
function sanitizeDocumentName(filename: string): string {
	const base = filename.replace(/\.[^.]+$/, "");
	return base.replace(/[^a-zA-Z0-9\s\-()[\]]/g, "_").slice(0, 200);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export class AttachmentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AttachmentError";
	}
}
