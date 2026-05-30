# Teardown

Run once at session end (explicit "end session" signal or idle timeout), never
on every turn.

At session end:

1. Append a dated entry to `memory/runtime/dailylog.md` summarizing the session
   (request ids, services, datasources, severity, confidence). This is an audit
   breadcrumb; it is written directly and always PII-redacted.
2. Promote any durable decision from the session to `memory/runtime/key-decisions.md`.
   Promotions are human-in-the-loop: stage the change on a branch and open a PR
   for review. Never write learned knowledge directly to the tracked file.
3. Stage any `memory/wiki/` deltas and include them in the same review PR. Never
   auto-merge; never commit secrets.

The expensive, irreversible step (opening the memory PR) runs only at genuine
session end, not per turn.
