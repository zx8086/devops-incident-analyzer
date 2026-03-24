// shared/src/attachments.ts

import { z } from "zod";

// Claude on AWS Bedrock supports three inline content types:
//   - Images: image/jpeg, image/png, image/gif, image/webp
//   - PDFs:   application/pdf (via Converse API "document" block)
//   - Text:   plain text (for extracted .docx, .md, .txt content)
// .docx and .md files are converted to text server-side before entering the graph.

export const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

export const SUPPORTED_DOCUMENT_TYPES = ["application/pdf"] as const;

export const SUPPORTED_TEXT_EXTENSIONS = [".md", ".txt", ".log", ".json", ".yaml", ".yml"] as const;

export const SUPPORTED_CONVERT_EXTENSIONS = [".docx"] as const;

export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];
export type SupportedDocumentType = (typeof SUPPORTED_DOCUMENT_TYPES)[number];

export const ImageBlockSchema = z.object({
	type: z.literal("image"),
	mimeType: z.enum(SUPPORTED_IMAGE_TYPES),
	base64: z.string(),
	filename: z.string(),
	sizeBytes: z.number().positive(),
});

export const PdfBlockSchema = z.object({
	type: z.literal("pdf"),
	base64: z.string(),
	filename: z.string(),
	sizeBytes: z.number().positive(),
	pageCount: z.number().positive().optional(),
});

export const DocxBlockSchema = z.object({
	type: z.literal("docx"),
	base64: z.string(),
	filename: z.string(),
	sizeBytes: z.number().positive(),
});

export const TextFileBlockSchema = z.object({
	type: z.literal("text_file"),
	content: z.string(),
	filename: z.string(),
	sizeBytes: z.number().positive(),
});

export const AttachmentBlockSchema = z.discriminatedUnion("type", [
	ImageBlockSchema,
	PdfBlockSchema,
	DocxBlockSchema,
	TextFileBlockSchema,
]);

export type ImageBlock = z.infer<typeof ImageBlockSchema>;
export type PdfBlock = z.infer<typeof PdfBlockSchema>;
export type DocxBlock = z.infer<typeof DocxBlockSchema>;
export type TextFileBlock = z.infer<typeof TextFileBlockSchema>;
export type AttachmentBlock = z.infer<typeof AttachmentBlockSchema>;

export const AttachmentMetaSchema = z.object({
	filename: z.string(),
	type: z.enum(["image", "pdf", "text"]),
	mimeType: z.string().optional(),
	sizeBytes: z.number().positive(),
	pageCount: z.number().positive().optional(),
});

export type AttachmentMeta = z.infer<typeof AttachmentMetaSchema>;

/** Per-file size limits in bytes */
export const SIZE_LIMITS = {
	image: 20 * 1024 * 1024, // 20 MB (Claude limit)
	pdf: 30 * 1024 * 1024, // 30 MB
	docx: 10 * 1024 * 1024, // 10 MB
	text_file: 1 * 1024 * 1024, // 1 MB
} as const;

/** Maximum total attachment payload per request */
export const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024; // 50 MB

/** Maximum number of attachments per request */
export const MAX_ATTACHMENTS = 10;

/** Maximum PDF pages (Claude processes well up to ~100 pages) */
export const MAX_PDF_PAGES = 100;

export function isImageMimeType(mime: string): mime is SupportedImageType {
	return (SUPPORTED_IMAGE_TYPES as readonly string[]).includes(mime);
}

export function isSupportedTextExtension(filename: string): boolean {
	return SUPPORTED_TEXT_EXTENSIONS.some((ext) => filename.toLowerCase().endsWith(ext));
}

export function isSupportedConvertExtension(filename: string): boolean {
	return SUPPORTED_CONVERT_EXTENSIONS.some((ext) => filename.toLowerCase().endsWith(ext));
}

export function getAttachmentSizeLimit(type: AttachmentBlock["type"]): number {
	return SIZE_LIMITS[type];
}
