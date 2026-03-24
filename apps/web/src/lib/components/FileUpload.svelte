<script lang="ts">
import { MAX_ATTACHMENTS, type AttachmentBlock } from "@devops-agent/shared/src/attachments.ts";
import { fileToAttachmentBlock, formatBytes, validateFiles } from "$lib/utils/file-utils";

interface Props {
	attachments: AttachmentBlock[];
	disabled?: boolean;
}

let { attachments = $bindable([]), disabled = false }: Props = $props();

let dragActive = $state(false);
let errors = $state<string[]>([]);
let processing = $state(false);

let filePreviews = $state<{ file: File; previewUrl: string | null; status: "ready" | "processing" | "error" }[]>([]);

let fileInput: HTMLInputElement;

const ACCEPT = "image/jpeg,image/png,image/gif,image/webp,application/pdf,.docx,.md,.txt,.log,.json,.yaml,.yml";

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

		const previewEntry = { file, previewUrl, status: "processing" as const };
		filePreviews = [...filePreviews, previewEntry];

		try {
			const block = await fileToAttachmentBlock(file);
			attachments = [...attachments, block];

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
	attachments = attachments.filter((_, i) => i !== index);
	errors = [];
}

function clearAll() {
	for (const p of filePreviews) {
		if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
	}
	filePreviews = [];
	attachments = [];
	errors = [];
}

function handleDragOver(e: DragEvent) {
	e.preventDefault();
	if (!disabled) dragActive = true;
}

function handleDragLeave(e: DragEvent) {
	e.preventDefault();
	dragActive = false;
}

function handleDrop(e: DragEvent) {
	e.preventDefault();
	dragActive = false;
	if (disabled || !e.dataTransfer?.files) return;
	handleFiles(e.dataTransfer.files);
}

function handlePaste(e: ClipboardEvent) {
	if (disabled) return;
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
</script>

<svelte:window onpaste={handlePaste} />

<div class="w-full" class:opacity-50={disabled} class:pointer-events-none={disabled}>
	{#if filePreviews.length === 0}
		<button
			type="button"
			class="flex flex-col items-center gap-1.5 w-full py-5 px-4 border-[1.5px] border-dashed rounded-lg cursor-pointer transition-all duration-150 text-tommy-navy {dragActive ? 'border-tommy-navy/40 bg-tommy-navy/[0.08]' : 'border-tommy-navy/20 bg-tommy-navy/[0.03] hover:border-tommy-navy/40 hover:bg-tommy-navy/[0.08]'}"
			{disabled}
			ondragover={handleDragOver}
			ondragleave={handleDragLeave}
			ondrop={handleDrop}
			onclick={() => fileInput?.click()}
		>
			<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
				<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
				<polyline points="17 8 12 3 7 8" />
				<line x1="12" y1="3" x2="12" y2="15" />
			</svg>
			<span class="text-sm opacity-70">
				Drop files here, paste, or <span class="underline underline-offset-2">browse</span>
			</span>
			<span class="text-xs opacity-45">
				Images, PDFs, Word docs, Markdown, text files
			</span>
		</button>
	{:else}
		<div
			class="flex flex-wrap gap-2 py-2"
			ondragover={handleDragOver}
			ondragleave={handleDragLeave}
			ondrop={handleDrop}
			role="list"
		>
			{#each filePreviews as preview, index (preview.file.name + index)}
				<div
					class="flex items-center gap-2 py-1.5 px-2 border rounded-md max-w-[220px] {preview.status === 'error' ? 'border-red-600' : 'border-tommy-navy/20'} bg-tommy-navy/[0.03]"
					role="listitem"
				>
					<div class="relative w-9 h-9 rounded overflow-hidden shrink-0">
						{#if preview.previewUrl}
							<img src={preview.previewUrl} alt={preview.file.name} class="w-full h-full object-cover" />
						{:else}
							<div class="w-full h-full flex items-center justify-center bg-tommy-navy/[0.08] text-[0.625rem] font-semibold tracking-wider opacity-60">
								{#if preview.file.name.endsWith(".pdf")}
									<span>PDF</span>
								{:else if preview.file.name.endsWith(".docx")}
									<span>DOC</span>
								{:else}
									<span>TXT</span>
								{/if}
							</div>
						{/if}
						{#if preview.status === "processing"}
							<div class="absolute inset-0 flex items-center justify-center bg-black/40">
								<div class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
							</div>
						{/if}
					</div>

					<div class="flex flex-col min-w-0">
						<span class="text-[0.8125rem] whitespace-nowrap overflow-hidden text-ellipsis max-w-[140px]" title={preview.file.name}>
							{preview.file.name}
						</span>
						<span class="text-[0.6875rem] opacity-50">{formatBytes(preview.file.size)}</span>
					</div>

					<button
						type="button"
						class="flex items-center justify-center w-[22px] h-[22px] border-none rounded bg-transparent cursor-pointer opacity-40 transition-opacity duration-100 shrink-0 hover:opacity-80 hover:bg-tommy-navy/[0.08]"
						onclick={() => removeFile(index)}
						aria-label="Remove {preview.file.name}"
					>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				</div>
			{/each}

			{#if filePreviews.length < MAX_ATTACHMENTS}
				<button
					type="button"
					class="flex items-center gap-1 py-1.5 px-3 border-[1.5px] border-dashed border-tommy-navy/20 rounded-md bg-transparent cursor-pointer text-[0.8125rem] opacity-50 transition-all duration-100 hover:opacity-80 hover:border-tommy-navy/40"
					onclick={() => fileInput?.click()}
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
						<line x1="12" y1="5" x2="12" y2="19" />
						<line x1="5" y1="12" x2="19" y2="12" />
					</svg>
					Add file
				</button>
			{/if}
		</div>

		{#if filePreviews.length > 1}
			<button
				type="button"
				class="block mt-1 py-0.5 border-none bg-transparent text-xs opacity-40 cursor-pointer underline underline-offset-2 hover:opacity-70"
				onclick={clearAll}
			>
				Clear all
			</button>
		{/if}
	{/if}

	<input
		bind:this={fileInput}
		type="file"
		accept={ACCEPT}
		multiple
		hidden
		onchange={(e) => {
			const target = e.target as HTMLInputElement;
			if (target.files) handleFiles(target.files);
			target.value = "";
		}}
	/>

	{#if errors.length > 0}
		<div class="mt-2" role="alert">
			{#each errors as error, i (i)}
				<p class="text-[0.8125rem] text-red-600 my-0.5">{error}</p>
			{/each}
		</div>
	{/if}
</div>
