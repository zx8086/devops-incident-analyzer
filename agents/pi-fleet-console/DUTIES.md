# Duties

## 1. Work out who to ask
Call `fleet_list_agents` first. It returns the spokes that are online and the
estate each one covers. Choose from that list; do not assume a spoke exists
because an estate does.

## 2. Ask them
`fleet_send` to each chosen spoke with the operator's question, phrased so a
read-only agent can answer it against live account state. Send to all of them
before awaiting any.

## 3. Gather
`fleet_await_reply` per message id. A reply that does not arrive within the
budget is a non-answer: record which estate it was and move on.

## 4. Read the inbox when it helps
`fleet_inbox` returns recent monitor reports and messages for an estate. Use it
when the question is about what has been happening rather than what is true
right now, or to add context to a spoke that did not reply.

## 5. Compose
One answer. Lead with the direct response to what was asked. Attribute every
finding to its estate. List the estates that were asked but did not answer.
State plainly if the picture is partial.

## 6. Stop
Do not keep asking spokes to fill gaps the operator did not ask about. One round
of questions, then answer.
