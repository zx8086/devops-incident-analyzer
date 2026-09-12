---
name: paginate-before-concluding
description: Establish that an AWS enumeration is complete before stating a count, an "all X" claim, or a negative finding -- walk every continuation token, recognise a byte-truncation marker that carries no token, and distinguish a definitive fully-paginated negative from an unverified empty result.
---

# Skill: Paginate Before Concluding

## Purpose
A count, a completeness claim, and a negative finding are the three answers
most often wrong for the same reason: the first page was mistaken for the whole
result. AWS list and describe calls cap their output, so a reply that names a
number without establishing completeness is an unverified claim, not a finding.

## Procedure
1. Decide first whether the question actually needs completeness. A count
   ("how many"), a universal ("all", "any", "none", "every"), or a negative
   ("there is no X") does. A single named resource does not; read it directly
   and skip the rest of this skill.
2. Run the enumeration, then inspect the response envelope for a continuation
   token before reading the items: `NextToken`, `NextMarker`, `Marker`,
   `PaginationToken`, or a service-specific equivalent.
3. If a token is present, walk EVERY page, carrying the token forward until the
   response returns none. Accumulate as you go; do not reason from page one
   while later pages are outstanding.
4. If output is truncated but NO token came back, the result was cut by size,
   not paged. Do NOT re-invoke the same call unchanged -- it returns the same
   bytes. Tighten a filter, narrow the resource scope, or shrink the page size
   until the response either completes or starts returning a token.
5. Confirm the walk was error-free. A page that failed mid-walk means the
   enumeration is incomplete, whatever the accumulated items say; report that
   rather than the partial count.
6. Only now state the answer, naming what made it complete: the number of
   pages walked, or that the first response carried no token.

## Rules
- Absence is data, but only after complete enumeration. A complete, fully
  paginated, error-free enumeration that finds nothing is a definitive negative
  finding: report it and stop.
- Do NOT re-verify a settled negative with log queries. An empty Logs Insights
  result cannot distinguish absence from a badly chosen window, so it weakens a
  finding that enumeration already settled.
- An empty result with no enumeration check is an unverified claim. Say what
  was checked, or check it.
- If every compute probe comes back empty, inventory the account before
  concluding anything. An account with no workloads by design is characterized,
  not reported as broken.
- When the enumeration spans many pages and the answer is an aggregate rather
  than the items themselves, prefer the ctx_* tools if they are present: run
  the walk and derive the count or grouping there, so only the derived answer
  enters the reply. Their absence changes nothing about this procedure.
- Evidence names the command and the completeness basis, for example
  "per `aws ec2 describe-instances`, 3 pages walked to exhaustion", not
  "per a describe call".
