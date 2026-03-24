// apps/web/src/lib/composables/file-attachments.svelte.ts

import { type AttachmentBlock, MAX_ATTACHMENTS } from "@devops-agent/shared/src/attachments.ts";
import { fileToAttachmentBlock, validateFiles } from "$lib/utils/file-utils";

export interface FilePreview {
	file: File;
	previewUrl: string | null;
	status: "ready" | "processing" | "error";
}

interface FileAttachmentsOptions {
	getAttachments: () => AttachmentBlock[];
	setAttachments: (v: AttachmentBlock[]) => void;
}

const ACCEPT = "image/jpeg,image/png,image/gif,image/webp,application/pdf,.docx,.md,.txt,.log,.json,.yaml,.yml";

export function createFileAttachments(options: FileAttachmentsOptions) {
	let filePreviews = $state<FilePreview[]>([]);
	let errors = $state<string[]>([]);
	let processing = $state(false);
	let fileInput = $state<HTMLInputElement | undefined>(undefined);

	async function handleFiles(fileList: FileList | File[]) {
		const files = Array.from(fileList);
		if (files.length === 0) return;

		errors = [];

		if (filePreviews.length + files.length > MAX_ATTACHMENTS) {
			errors = [`Maximum ${MAX_ATTACHMENTS} files allowed`];
			return;
		}

		const validation = validateFiles(files);
		if (!validation.valid) {
			errors = validation.errors;
			return;
		}

		processing = true;

		for (const file of files) {
			const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
			const previewEntry: FilePreview = { file, previewUrl, status: "processing" };
			filePreviews = [...filePreviews, previewEntry];

			try {
				const block = await fileToAttachmentBlock(file);
				options.setAttachments([...options.getAttachments(), block]);
				filePreviews = filePreviews.map((p) => (p.file === file ? { ...p, status: "ready" as const } : p));
			} catch (err) {
				filePreviews = filePreviews.map((p) => (p.file === file ? { ...p, status: "error" as const } : p));
				errors = [...errors, `${file.name}: ${(err as Error).message}`];
			}
		}

		processing = false;
	}

	function removeFile(index: number) {
		const preview = filePreviews[index];
		if (preview?.previewUrl) {
			URL.revokeObjectURL(preview.previewUrl);
		}
		filePreviews = filePreviews.filter((_, i) => i !== index);
		const attachments = options.getAttachments();
		options.setAttachments(attachments.filter((_, i) => i !== index));
		errors = [];
	}

	function clearAll() {
		for (const p of filePreviews) {
			if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
		}
		filePreviews = [];
		options.setAttachments([]);
		errors = [];
	}

	function handlePaste(e: ClipboardEvent) {
		const items = e.clipboardData?.items;
		if (!items) return;

		const files: File[] = [];
		for (const item of items) {
			if (item.kind === "file") {
				const file = item.getAsFile();
				if (file) files.push(file);
			}
		}
		if (files.length > 0) {
			e.preventDefault();
			handleFiles(files);
		}
	}

	function triggerPicker() {
		fileInput?.click();
	}

	function handleFileInputChange(e: Event) {
		const target = e.target as HTMLInputElement;
		if (target.files) handleFiles(target.files);
		target.value = "";
	}

	return {
		get filePreviews() {
			return filePreviews;
		},
		get errors() {
			return errors;
		},
		get processing() {
			return processing;
		},
		get fileInput() {
			return fileInput;
		},
		set fileInput(el: HTMLInputElement | undefined) {
			fileInput = el;
		},
		handleFiles,
		removeFile,
		clearAll,
		handlePaste,
		triggerPicker,
		handleFileInputChange,
		ACCEPT,
	};
}
