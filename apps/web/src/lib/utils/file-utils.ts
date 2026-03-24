// apps/web/src/lib/utils/file-utils.ts

import {
	type AttachmentBlock,
	MAX_ATTACHMENTS,
	MAX_TOTAL_ATTACHMENT_BYTES,
	SIZE_LIMITS,
	SUPPORTED_IMAGE_TYPES,
	type SupportedImageType,
} from "@devops-agent/shared/src/attachments.ts";

export async function fileToAttachmentBlock(file: File): Promise<AttachmentBlock> {
	const base64 = await readFileAsBase64(file);

	if (isImageType(file.type)) {
		return {
			type: "image",
			mimeType: file.type as SupportedImageType,
			base64,
			filename: file.name,
			sizeBytes: file.size,
		};
	}

	if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
		return {
			type: "pdf",
			base64,
			filename: file.name,
			sizeBytes: file.size,
		};
	}

	if (
		file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
		file.name.toLowerCase().endsWith(".docx")
	) {
		return {
			type: "docx",
			base64,
			filename: file.name,
			sizeBytes: file.size,
		};
	}

	if (isTextFile(file.name)) {
		const content = await readFileAsText(file);
		return {
			type: "text_file",
			content,
			filename: file.name,
			sizeBytes: file.size,
		};
	}

	throw new FileValidationError(`Unsupported file type: ${file.type || file.name.split(".").pop()}`);
}

export interface ValidationResult {
	valid: boolean;
	errors: string[];
}

export function validateFiles(files: File[]): ValidationResult {
	const errors: string[] = [];

	if (files.length > MAX_ATTACHMENTS) {
		errors.push(`Too many files: ${files.length} (max ${MAX_ATTACHMENTS})`);
	}

	const totalSize = files.reduce((sum, f) => sum + f.size, 0);
	if (totalSize > MAX_TOTAL_ATTACHMENT_BYTES) {
		errors.push(`Total size ${formatBytes(totalSize)} exceeds limit of ${formatBytes(MAX_TOTAL_ATTACHMENT_BYTES)}`);
	}

	for (const file of files) {
		const type = detectAttachmentType(file);
		if (!type) {
			errors.push(`${file.name}: unsupported file type`);
			continue;
		}

		const limit = SIZE_LIMITS[type];
		if (file.size > limit) {
			errors.push(`${file.name} (${formatBytes(file.size)}) exceeds ${type} limit of ${formatBytes(limit)}`);
		}
	}

	return { valid: errors.length === 0, errors };
}

type AttachmentType = "image" | "pdf" | "docx" | "text_file";

function detectAttachmentType(file: File): AttachmentType | null {
	if (isImageType(file.type)) return "image";
	if (file.type === "application/pdf" || file.name.endsWith(".pdf")) return "pdf";
	if (
		file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
		file.name.endsWith(".docx")
	)
		return "docx";
	if (isTextFile(file.name)) return "text_file";
	return null;
}

function isImageType(mime: string): boolean {
	return (SUPPORTED_IMAGE_TYPES as readonly string[]).includes(mime);
}

const TEXT_EXTENSIONS = [".md", ".txt", ".log", ".json", ".yaml", ".yml"];
function isTextFile(filename: string): boolean {
	const lower = filename.toLowerCase();
	return TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function readFileAsBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = reader.result as string;
			// Strip the data URI prefix: "data:image/png;base64," -> raw base64
			const base64 = result.split(",")[1];
			if (!base64) {
				reject(new Error(`Failed to read ${file.name} as base64`));
				return;
			}
			resolve(base64);
		};
		reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
		reader.readAsDataURL(file);
	});
}

function readFileAsText(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
		reader.readAsText(file);
	});
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function getFileIcon(file: File): string {
	const type = detectAttachmentType(file);
	switch (type) {
		case "image":
			return "image";
		case "pdf":
			return "file-text";
		case "docx":
			return "file-type";
		case "text_file":
			return "file-code";
		default:
			return "file";
	}
}

export class FileValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FileValidationError";
	}
}
