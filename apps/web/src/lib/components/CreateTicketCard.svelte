<script lang="ts">
// apps/web/src/lib/components/CreateTicketCard.svelte
import {
	type CreatedTicket,
	CreatedTicketSchema,
	type TicketAssignee,
	TicketAssigneeSchema,
	type TicketEpic,
	TicketEpicSchema,
	type TicketIssueType,
	TicketIssueTypeSchema,
	type TicketProject,
	TicketProjectSchema,
	type TicketProviderInfo,
} from "@devops-agent/shared";
import { z } from "zod";
import { prefillDescription, prefillSummary } from "$lib/ticket-prefill";
import Icon from "./Icon.svelte";

const ProjectsResponseSchema = z.object({ projects: z.array(TicketProjectSchema) });
const IssueTypesResponseSchema = z.object({ issueTypes: z.array(TicketIssueTypeSchema) });
const EpicsResponseSchema = z.object({ epics: z.array(TicketEpicSchema) });
const AssigneesResponseSchema = z.object({ assignees: z.array(TicketAssigneeSchema) });

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

let epics = $state<TicketEpic[]>([]);
let epicsLoading = $state(false);
let selectedEpicKey = $state("");

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
// Sequence tokens: responses can resolve out of order; only the latest request
// for each field may write state.
let projectsSeq = 0;
let assigneesSeq = 0;

const canSubmit = $derived(
	!submitting && !!provider && selectedProjectKey !== "" && selectedIssueType !== "" && summary.trim() !== "",
);

function errorFrom(data: unknown, status: number): string {
	if (data && typeof data === "object" && "error" in data) {
		const message = (data as { error?: unknown }).error;
		if (typeof message === "string") return message;
	}
	return `Request failed (${status})`;
}

async function fetchJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
	const res = await fetch(path);
	const data: unknown = await res.json();
	if (!res.ok) throw new Error(errorFrom(data, res.status));
	const parsed = schema.safeParse(data);
	if (!parsed.success) throw new Error("Unexpected response shape from the ticket API");
	return parsed.data;
}

async function loadProjects(query: string) {
	if (!provider) return;
	const seq = ++projectsSeq;
	projectsLoading = true;
	projectsError = null;
	try {
		const search = query.trim() ? `?query=${encodeURIComponent(query.trim())}` : "";
		const data = await fetchJson(`/api/tickets/${provider.id}/projects${search}`, ProjectsResponseSchema);
		if (seq !== projectsSeq) return;
		projects = data.projects;
	} catch (err) {
		if (seq !== projectsSeq) return;
		projects = [];
		projectsError = err instanceof Error ? err.message : "Failed to load projects";
	} finally {
		if (seq === projectsSeq) projectsLoading = false;
	}
}

async function loadIssueTypes(projectKey: string) {
	if (!provider) return;
	issueTypesLoading = true;
	try {
		const data = await fetchJson(
			`/api/tickets/${provider.id}/issue-types?projectKey=${encodeURIComponent(projectKey)}`,
			IssueTypesResponseSchema,
		);
		if (selectedProjectKey !== projectKey) return;
		issueTypes = data.issueTypes;
		const task = issueTypes.find((t) => t.name === "Task");
		selectedIssueType = task?.name ?? issueTypes[0]?.name ?? "";
	} catch (err) {
		if (selectedProjectKey !== projectKey) return;
		issueTypes = [];
		selectedIssueType = "";
		errorMessage = err instanceof Error ? err.message : "Failed to load issue types";
	} finally {
		if (selectedProjectKey === projectKey) issueTypesLoading = false;
	}
}

async function loadEpics(projectKey: string) {
	if (!provider) return;
	epicsLoading = true;
	try {
		const data = await fetchJson(
			`/api/tickets/${provider.id}/epics?projectKey=${encodeURIComponent(projectKey)}`,
			EpicsResponseSchema,
		);
		if (selectedProjectKey !== projectKey) return;
		epics = data.epics;
	} catch {
		// Best-effort: a failed epic load leaves the picker on "No epic".
		if (selectedProjectKey !== projectKey) return;
		epics = [];
	} finally {
		if (selectedProjectKey === projectKey) epicsLoading = false;
	}
}

async function loadAssignees(query: string) {
	if (!provider) return;
	const seq = ++assigneesSeq;
	assigneesLoading = true;
	try {
		const data = await fetchJson(
			`/api/tickets/${provider.id}/assignees?query=${encodeURIComponent(query)}`,
			AssigneesResponseSchema,
		);
		if (seq !== assigneesSeq) return;
		assigneeResults = data.assignees;
	} catch {
		if (seq !== assigneesSeq) return;
		assigneeResults = [];
	} finally {
		if (seq === assigneesSeq) assigneesLoading = false;
	}
}

function onProjectQueryInput() {
	clearTimeout(projectDebounce);
	projectDebounce = setTimeout(() => loadProjects(projectQuery), 300);
}

function onProjectChange() {
	issueTypes = [];
	selectedIssueType = "";
	epics = [];
	selectedEpicKey = "";
	if (selectedProjectKey) {
		loadIssueTypes(selectedProjectKey);
		loadEpics(selectedProjectKey);
	}
}

function onAssigneeQueryInput() {
	clearTimeout(assigneeDebounce);
	const query = assigneeQuery.trim();
	if (query.length < 2) {
		// Invalidate any in-flight search so a late response can't repopulate.
		assigneesSeq++;
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
				epicKey: selectedEpicKey || null,
			}),
		});
		const data: unknown = await res.json();
		if (!res.ok) throw new Error(errorFrom(data, res.status));
		const parsed = CreatedTicketSchema.safeParse(data);
		if (!parsed.success) throw new Error("Unexpected response shape from the ticket API");
		createdTicket = parsed.data;
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
				<label for="ticket-epic" class="block text-xs font-medium text-gray-600 mb-1">Epic</label>
				<select
					id="ticket-epic"
					bind:value={selectedEpicKey}
					disabled={epicsLoading || selectedProjectKey === ""}
					class="w-full text-sm border border-gray-300 rounded px-2 py-1 bg-white disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-tommy-accent-blue"
				>
					{#if selectedProjectKey === ""}
						<option value="">Select a project first</option>
					{:else}
						<option value="">{epicsLoading ? "Loading epics..." : "No epic"}</option>
					{/if}
					{#each epics as epic (epic.key)}
						<option value={epic.key}>{epic.summary} ({epic.key})</option>
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
