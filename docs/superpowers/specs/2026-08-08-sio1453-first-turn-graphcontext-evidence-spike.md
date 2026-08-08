# SIO-1453 spike: is there real evidence for a first-turn-only graphContext injection?

Research note. No code changes. See
[SIO-1453](https://linear.app/siobytes/issue/SIO-1453/spike-first-turn-only-graphcontext-injection-for-sub-agent-dispatch).

## Question (step 1 of the ticket's deliverable)

[SIO-1445](https://linear.app/siobytes/issue/SIO-1445/spike-evaluate-per-domain-graphcontext-slice-in-sub-agent-dispatch)
rejected an always-on per-turn `graphContext` slice on cost grounds, but flagged a
cheaper first-turn-only variant as worth checking *if there's evidence a sub-agent
actually re-derives something the KG already knows*. SIO-1445 found none in its own
review. This spike's job, per its own scoping, is to check real incident data for that
evidence **before** designing any plumbing -- and to no-go and close without
implementation if nothing turns up.

## Method

Read the full 32-entry human-curated incident-replay eval dataset
(`packages/agent/src/eval/incident-replay-dataset.ts`), derived from real Jira epic
DEVOPS-1354 tickets with `referenceFindings` recorded per datasource by the actual
investigation that ran. This is the closest thing this repo has to "real incident
traces with recorded per-sub-agent findings" -- stronger evidence than trying to
reverse-engineer LangSmith spans (a first attempt at pulling 20 recent traces returned
only MCP health-check probes: `prompt_tokens: 0`, `readOnlyHint: true`, no
conversational content -- not useful for this question).

## Finding: the evidence exists, but it points the other way

**Over half the dataset (roughly 20 of 32 tickets) belongs to an explicitly
cross-referenced incident family** -- a later ticket's own investigation cites an
earlier ticket's confirmed root cause or shared failure signature:

| Family | Tickets |
|---|---|
| Capella private-endpoint connectivity | DEVOPS-1353 -> 1375 -> 1407 |
| styles-v3 / images-v2 co-spike | DEVOPS-1386 <-> 1387 (sibling, cross-referenced both ways) |
| localcore-service assignment chain | DEVOPS-1389, 1390, 1391 -> 1410 (cites all three) |
| S3 IAM gap | DEVOPS-1392 (bucket identified, not queried) -> 1398 (confirms the actual gap) |
| VariantEventConsumer / SeasonsClient 404 | DEVOPS-1393, 1396, 1397 (shared DLQ, shared root cause) |
| Season-data-gap (platform-wide) | DEVOPS-1385, 1389, 1395, 1396, 1397, 1405, 1408, 1411 (8 tickets, each newer one enumerates the priors) |
| Couchbase timeout burst | DEVOPS-1412 -> 1413 (sibling deep-dive) |

This is real, concrete evidence that sub-agent investigations routinely need
"what happened in a prior, related incident" -- exactly the shape of question
`graphContext`'s similar-incidents/root-cause data exists to answer.

**But every one of these cross-references was surfaced by the `atlassian` sub-agent's
own live tool calls** (`atlassian_search` / `atlassian_searchJiraIssuesUsingJql`,
`agents/incident-analyzer/tools/atlassian-api.yaml:80-97`), not by a KG slice --
because none exists in production dispatch today. Representative quotes straight from
`referenceFindings.atlassian` in the dataset:

> "DEVOPS-1353 documented the same Capella endpoint and the same source IP in a prior
> incident resolved 2026-07-15 with a recorded root cause of an ECS security-group
> allowlist gap" (DEVOPS-1407's atlassian finding)
>
> "Five prior linked Jira tickets (DEVOPS-1385, 1389, 1395, 1396, 1397) document the
> same failure class since 2026-07-09" (DEVOPS-1408's atlassian finding)
>
> "DEVOPS-1392 (filed 2026-07-21, Backlog, unassigned) identified the bucket via the
> task definition environment variable but explicitly listed it as an uninvestigated
> gap without querying it" (DEVOPS-1398's atlassian finding)

**Caveat on what this evidence actually proves.** `referenceFindings` is a
human-curated ground-truth record of what a *good* investigation found for each
ticket, not a captured trace of a live agent's tool calls, iteration count, or
whether a specific run re-derived something versus finding it in one search. This
dataset shows the correlation is reliably *findable* via `atlassian_search` /
`atlassian_searchJiraIssuesUsingJql` (`agents/incident-analyzer/tools/atlassian-api.yaml:80-97`)
plus a follow-up read (`atlassian_fetch` or `atlassian_getJiraIssue` for full ticket
content, not JQL search alone) -- and that the reference answer for each of these
~20 tickets routes through exactly that path. It does **not** establish how many live
searches a real run needed, what that cost in latency, or that a real run ever
produced a worse or slower answer without it. No live agent trace was available to
confirm operational behavior (the LangSmith pull in Method above returned only
health-check probes). The claim below is therefore: **no demonstrated gap in this
dataset** for the search-plus-read flow to fill -- not a claim that the flow's
cost/behavior has been measured.

## Why this changes the conclusion (not just confirms SIO-1445's no-go)

SIO-1445 no-go'd the full per-turn slice on **cost** grounds (uncached tokens x ReAct
iterations) while leaving the **value case open** ("plausible but unverified"). This
spike narrows that open question, but not in the direction the ticket's framing
implied. The value case is not shown to be missing a capability -- this dataset's
ground-truth answers are consistently reachable via the atlassian sub-agent's existing
search-plus-read tool flow, across 20+ real incidents, with no counterexample of that
flow falling short. A `graphContext` slice injected into every sub-agent's dispatch
would be a second, narrower, KG-backed path to information the search-plus-read flow
can already retrieve more completely (full ticket content on demand vs.
`graphContext`'s similar-incidents field, capped to 3 entries with a ~100-200 char
summary each, per SIO-1445 section 2) -- not a fix for a demonstrated shortfall.

There is one narrower case this doesn't fully cover: `graphContext`'s
`priorRelationshipsForServices` (`ServiceDependency[]`, direct `DEPENDS_ON` graph edges)
is structurally different from anything Jira search returns -- it's topology, not
incident history. No entry in this dataset shows a sub-agent needing that specific
signal and failing to get it (service dependency reasoning in the dataset comes from
direct AWS/GitLab investigation of the actual call chain, e.g. DEVOPS-1391's
localcore-service -> customer-assignments-service -> upstream trace), so this remains
unevidenced too, but it is a distinct enough claim from "similar prior incidents" that
a future ticket could isolate it if a real gap ever surfaces.

## Go/no-go

**No-go.** Do not design or build the first-turn-only injection mechanism. The premise
this spike was gated on -- "is there real evidence a sub-agent re-derives something
`graphContext` already knows" -- resolves to: the *category* of value (cross-incident
correlation) is real, and this dataset shows no case where the atlassian sub-agent's
existing search-plus-read tool flow fell short of what a `graphContext` slice could
have supplied. That's a "no demonstrated gap" finding, not a measured cost/behavior
comparison (see the caveat above) -- but it's enough to answer the spike's actual gate:
there is no dataset-backed case for building a second, narrower path to information
the existing tool flow already reaches.

Per the ticket's own step 4 ("if no evidence found in step 1: no-go, document why,
close without implementation"): evidence of the *category* of value was found, but no
evidence of a gap the proposed mechanism would fill -- the existing search-plus-read
flow is present and, per this dataset, sufficient for every case observed.

## What (if anything) would change this

If a future incident shows the atlassian sub-agent's live search *missing* a
correlation that `graphContext` would have surfaced (e.g. a KG-recorded root cause for
an incident that predates or falls outside Jira's own search reach, or a topology
relationship no sub-agent currently derives), that would be new, different evidence --
worth its own narrowly-scoped ticket at that point, not a re-opening of this one.
