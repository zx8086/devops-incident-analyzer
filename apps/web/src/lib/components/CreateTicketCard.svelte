<script lang="ts">
// apps/web/src/lib/components/CreateTicketCard.svelte
import type {
	CreatedTicket,
	TicketAssignee,
	TicketIssueType,
	TicketProject,
	TicketProviderInfo,
} from "@devops-agent/shared";
import { prefillDescription, prefillSummary } from "$lib/ticket-prefill";
import Icon from "./Icon.svelte";

let {
	content,
	providers,
	onClose,
}: {
	content: string;
	providers: TicketProviderInfo[];
	onClose: () => void;
} = $props();

// Single provider today; a picker appears here once a second provider ships.
const provider = $derived(providers[0]);

let projects = $state<TicketProject[]>([]);
let projectsLoading = $state(false);
let projectsError = $state<string | null>(null);
let projectQuery = $state("");
let selectedProjectKey = $state("");

let issueTypes = $state<TicketIssueType[]>([]);
let issueTypesLoading = $state(false);
let selectedIssueType = $state("");

let assigneeQuery = $state("");
let assigneeResults = $state<TicketAssignee[]>([]);
let assigneesLoading = $state(false);
let selectedAssignee = $state<TicketAssignee | null>(null);

// Deliberate initial-value capture: the prefill seeds the editable fields once
// per card mount; later prop changes must not clobber user edits.
// svelte-ignore state_referenced_locally
let summary = $state(prefillSummary(content));
// svelte-ignore state_referenced_locally
let description = $state(prefillDescription(content));

let submitting = $state(false);
let createdTicket = $state<CreatedTicket | null>(null);
let errorMessage = $state<string | null>(null);

let projectDebounce: ReturnType<typeof setTimeout> | undefined;
let assigneeDebounce: ReturnType<typeof setTimeout> | undefined;

const canSubmit = $derived(
	!submitting && !!provider && selectedProjectKey !== "" && selectedIssueType !== "" && summary.trim() !== "",
);

async function fetchJson<T>(path: string): Promise<T> {
	const res = await fetch(path);
	const data = await res.json();
	if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Request failed (${res.status})`);
	return data as T;
}

async function loadProjects(query: string) {
	if (!provider) return;
	projectsLoading = true;
	projectsError = null;
	try {
		const search = query.trim() ? `?query=${encodeURIComponent(query.trim())}` : "";
		const data = await fetchJson<{ projects: TicketProject[] }>(`/api/tickets/${provider.id}/projects${search}`);
		projects = data.projects ?? [];
	} catch (err) {
		projects = [];
		projectsError = err instanceof Error ? err.message : "Failed to load projects";
	} finally {
		projectsLoading = false;
	}
}

async function loadIssueTypes(projectKey: string) {
	if (!provider) return;
	issueTypesLoading = true;
	try {
		const data = await fetchJson<{ issueTypes: TicketIssueType[] }>(
			`/api/tickets/${provider.id}/issue-types?projectKey=${encodeURIComponent(projectKey)}`,
		);
		issueTypes = data.issueTypes ?? [];
		const task = issueTypes.find((t) => t.name === "Task");
		selectedIssueType = task?.name ?? issueTypes[0]?.name ?? "";
	} catch (err) {
		issueTypes = [];
		selectedIssueType = "";
		errorMessage = err instanceof Error ? err.message : "Failed to load issue types";
	} finally {
		issueTypesLoading = false;
	}
}

async function loadAssignees(query: string) {
	if (!provider) return;
	assigneesLoading = true;
	try {
		const data = await fetchJson<{ assignees: TicketAssignee[] }>(
			`/api/tickets/${provider.id}/assignees?query=${encodeURIComponent(query)}`,
		);
		assigneeResults = data.assignees ?? [];
	} catch {
		assigneeResults = [];
	} finally {
		assigneesLoading = false;
	}
}

function onProjectQueryInput() {
	clearTimeout(projectDebounce);
	projectDebounce = setTimeout(() => loadProjects(projectQuery), 300);
}

function onProjectChange() {
	issueTypes = [];
	selectedIssueType = "";
	if (selectedProjectKey) loadIssueTypes(selectedProjectKey);
}

function onAssigneeQueryInput() {
	clearTimeout(assigneeDebounce);
	const query = assigneeQuery.trim();
	if (query.length < 2) {
		assigneeResults = [];
		return;
	}
	assigneeDebounce = setTimeout(() => loadAssignees(query), 300);
}

async function submit() {
	if (!canSubmit || !provider) return;
	submitting = true;
	errorMessage = null;
	try {
		const res = await fetch(`/api/tickets/${provider.id}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				projectKey: selectedProjectKey,
				issueTypeName: selectedIssueType,
				summary: summary.trim(),
				description,
				assigneeId: selectedAssignee?.id ?? null,
			}),
		});
		const data = await res.json();
		if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Request failed (${res.status})`);
		createdTicket = data as CreatedTicket;
	} catch (err) {
		errorMessage = err instanceof Error ? err.message : "Failed to create the ticket";
	} finally {
		submitting = false;
	}
}

$effect(() => {
	loadProjects("");
});
</script>

{#if createdTicket}
	<div class="rounded-lg border border-green-200 bg-green-50 px-3 py-2 mt-2" role="dialog" aria-label="Ticket created">
		<div class="flex items-center gap-2 text-sm">
			<Icon name="check" class="w-4 h-4 text-green-600" />
			<span class="font-medium text-green-800">Ticket created: {createdTicket.key}</span>
			{#if createdTicket.url}
				<a href={createdTicket.url} target="_blank" rel="noopener noreferrer" class="text-tommy-navy underline ml-auto">
					View
				</a>
			{/if}
			<button
				onclick={onClose}
				class="text-xs text-gray-500 hover:text-gray-700 {createdTicket.url ? '' : 'ml-auto'}"
			>
				Close
			</button>
		</div>
	</div>
{:else if provider}
	<div class="rounded-lg border border-gray-200 bg-white px-3 py-3 mt-2 shadow-sm" role="dialog" aria-label="Create ticket">
		<div class="flex items-center gap-2 mb-3">
			<Icon name="ticket" class="w-4 h-4 text-tommy-navy" />
			<span class="text-sm font-semibold text-tommy-navy">Create {provider.label} ticket</span>
			<button onclick={onClose} class="ml-auto p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors" aria-label="Close">
				<Icon name="x" class="w-3.5 h-3.5" />
			</button>
		</div>

		<div class="space-y-3">
			<div>
				<label for="ticket-project" class="block text-xs font-medium text-gray-600 mb-1">Project</label>
				<input
					type="text"
					bind:value={projectQuery}
					oninput={onProjectQueryInput}
					placeholder="Search projects..."
					class="w-full text-sm border border-gray-300 rounded px-2 py-1 mb-1 focus:outline-none focus:ring-1 focus:ring-tommy-accent-blue"
				/>
				<select
					id="ticket-project"
					bind:value={selectedProjectKey}
					onchange={onProjectChange}
					disabled={projectsLoading}
					class="w-full text-sm border border-gray-300 rounded px-2 py-1 bg-white disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-tommy-accent-blue"
				>
					<option value="" disabled>{projectsLoading ? "Loading projects..." : "Select a project"}</option>
					{#each projects as project (project.id)}
						<option value={project.key}>{project.name} ({project.key})</option>
					{/each}
				</select>
				{#if projectsError}
					<p class="text-xs text-red-600 mt-1">{projectsError}</p>
				{/if}
			</div>

			<div>
				<label for="ticket-issue-type" class="block text-xs font-medium text-gray-600 mb-1">Issue type</label>
				<select
					id="ticket-issue-type"
					bind:value={selectedIssueType}
					disabled={issueTypesLoading || selectedProjectKey === ""}
					class="w-full text-sm border border-gray-300 rounded px-2 py-1 bg-white disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-tommy-accent-blue"
				>
					{#if selectedProjectKey === ""}
						<option value="" disabled>Select a project first</option>
					{:else if issueTypesLoading}
						<option value="" disabled>Loading issue types...</option>
					{/if}
					{#each issueTypes as issueType (issueType.id)}
						<option value={issueType.name}>{issueType.name}</option>
					{/each}
				</select>
			</div>

			<div>
				<label for="ticket-assignee" class="block text-xs font-medium text-gray-600 mb-1">Assignee</label>
				<div class="flex items-center gap-2 mb-1">
					<span class="text-xs px-2 py-0.5 rounded-full border {selectedAssignee ? 'border-tommy-accent-blue/40 bg-blue-50 text-tommy-navy' : 'border-gray-200 bg-gray-50 text-gray-600'}">
						{selectedAssignee ? selectedAssignee.displayName : "Unassigned"}
					</span>
					{#if selectedAssignee}
						<button onclick={() => (selectedAssignee = null)} class="text-xs text-gray-500 hover:text-gray-700 underline">
							Unassign
						</button>
					{/if}
				</div>
				<input
					id="ticket-assignee"
					type="text"
					bind:value={assigneeQuery}
					oninput={onAssigneeQueryInput}
					placeholder="Search people (min 2 characters)..."
					class="w-full text-sm border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-tommy-accent-blue"
				/>
				{#if assigneesLoading}
					<p class="text-xs text-gray-400 mt-1">Searching...</p>
				{:else if assigneeResults.length > 0}
					<ul class="border border-gray-200 rounded mt-1 max-h-32 overflow-y-auto divide-y divide-gray-100">
						{#each assigneeResults as assignee (assignee.id)}
							<li>
								<button
									onclick={() => {
										selectedAssignee = assignee;
										assigneeQuery = "";
										assigneeResults = [];
									}}
									class="w-full text-left text-sm px-2 py-1 hover:bg-gray-50 transition-colors"
								>
									{assignee.displayName}
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>

			<div>
				<label for="ticket-summary" class="block text-xs font-medium text-gray-600 mb-1">Summary</label>
				<input
					id="ticket-summary"
					type="text"
					bind:value={summary}
					maxlength="255"
					class="w-full text-sm border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-tommy-accent-blue"
				/>
			</div>

			<div>
				<label for="ticket-description" class="block text-xs font-medium text-gray-600 mb-1">Description</label>
				<textarea
					id="ticket-description"
					bind:value={description}
					rows="5"
					class="w-full text-xs font-mono border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-tommy-accent-blue"
				></textarea>
			</div>

			{#if errorMessage}
				<p class="text-xs text-red-600" role="alert">{errorMessage}</p>
			{/if}

			<div class="flex gap-2">
				<button
					onclick={submit}
					disabled={!canSubmit}
					class="px-3 py-1 text-xs font-medium rounded bg-tommy-navy text-white hover:bg-tommy-navy/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
				>
					{submitting ? "Creating..." : "Create ticket"}
				</button>
				<button
					onclick={onClose}
					disabled={submitting}
					class="px-3 py-1 text-xs font-medium rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition-colors"
				>
					Cancel
				</button>
			</div>
		</div>
	</div>
{/if}
