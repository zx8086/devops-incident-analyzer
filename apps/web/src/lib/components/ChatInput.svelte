<script lang="ts">
// apps/web/src/lib/components/ChatInput.svelte
import { type AttachmentBlock, MAX_ATTACHMENTS } from "@devops-agent/shared/src/attachments.ts";
import { createFileAttachments } from "$lib/composables/file-attachments.svelte";
import { formatBytes } from "$lib/utils/file-utils";
import Icon from "./Icon.svelte";

let {
	onSend,
	isStreaming = false,
	onStop,
	attachments = $bindable([]),
}: {
	onSend: (msg: string) => void;
	isStreaming?: boolean;
	onStop?: () => void;
	attachments?: AttachmentBlock[];
} = $props();

let value = $state("");
let textarea: HTMLTextAreaElement;

const fileAttach = createFileAttachments({
	getAttachments: () => attachments,
	setAttachments: (v) => {
		attachments = v;
	},
});

function handleKeydown(e: KeyboardEvent) {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		submit();
	}
}

function submit() {
	const trimmed = value.trim();
	if (!trimmed || isStreaming) return;
	onSend(trimmed);
	value = "";
	if (textarea) textarea.style.height = "auto";
}

function autoResize() {
	if (!textarea) return;
	textarea.style.height = "auto";
	textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
}
</script>

<svelte:window onpaste={(e) => { if (!isStreaming) fileAttach.handlePaste(e); }} />

<div class="p-4">
	<div class="max-w-4xl mx-auto flex flex-col gap-2">
		{#if fileAttach.filePreviews.length > 0}
			<div class="flex flex-wrap gap-2" role="list">
				{#each fileAttach.filePreviews as preview, index (preview.file.name + index)}
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
							onclick={() => fileAttach.removeFile(index)}
							aria-label="Remove {preview.file.name}"
						>
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
								<line x1="18" y1="6" x2="6" y2="18" />
								<line x1="6" y1="6" x2="18" y2="18" />
							</svg>
						</button>
					</div>
				{/each}

				{#if fileAttach.filePreviews.length > 1}
					<button
						type="button"
						class="flex items-center py-1.5 px-2 border-none bg-transparent text-xs opacity-40 cursor-pointer underline underline-offset-2 hover:opacity-70"
						onclick={() => fileAttach.clearAll()}
					>
						Clear all
					</button>
				{/if}
			</div>
		{/if}

		<div class="flex items-end gap-2">
			<button
				type="button"
				onclick={() => fileAttach.triggerPicker()}
				disabled={isStreaming || fileAttach.filePreviews.length >= MAX_ATTACHMENTS}
				class="shrink-0 flex items-center justify-center w-10 h-10 rounded-lg border border-gray-300 text-gray-500 hover:bg-tommy-navy/[0.05] hover:border-tommy-navy/30 hover:text-tommy-navy transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
				aria-label="Attach files"
			>
				<Icon name="plus" class="w-[18px] h-[18px]" />
			</button>

			<textarea
				bind:this={textarea}
				bind:value
				oninput={autoResize}
				onkeydown={handleKeydown}
				placeholder="Describe the incident or ask a question..."
				rows="1"
				disabled={isStreaming}
				class="flex-1 resize-none rounded-lg border border-gray-300 px-4 py-3 text-sm focus:border-tommy-accent-blue focus:outline-none focus:ring-1 focus:ring-tommy-accent-blue disabled:opacity-50"
			></textarea>

			{#if isStreaming}
				<button onclick={onStop} class="rounded-lg bg-tommy-red p-3 text-white hover:bg-red-600 transition-colors">
					<Icon name="stop" class="w-[18px] h-[18px]" />
				</button>
			{:else}
				<button onclick={submit} disabled={!value.trim()} class="rounded-lg bg-tommy-navy p-3 text-white hover:bg-tommy-dark-navy transition-colors disabled:opacity-30">
					<Icon name="send" class="w-[18px] h-[18px]" />
				</button>
			{/if}
		</div>

		<input
			bind:this={fileAttach.fileInput}
			type="file"
			accept={fileAttach.ACCEPT}
			multiple
			hidden
			onchange={fileAttach.handleFileInputChange}
		/>

		{#if fileAttach.errors.length > 0}
			<div role="alert">
				{#each fileAttach.errors as error, i (i)}
					<p class="text-[0.8125rem] text-red-600 my-0.5">{error}</p>
				{/each}
			</div>
		{/if}
	</div>
</div>
