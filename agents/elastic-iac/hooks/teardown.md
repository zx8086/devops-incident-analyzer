# Teardown

Run at the end of every job, success or failure.

## Steps

1. Append a one-line entry to `memory/runtime/dailylog.md`:
   ```
   YYYY-MM-DD HH:MM | <skill or flow> | <cluster> | <MR url or "none"> | <result>
   ```

2. If a new MR was opened, append to `memory/runtime/context.md` under `## in-flight`:
   ```
   - !<iid>: <title> (<cluster>) — opened <date>, awaiting review
   ```

3. If a previously in-flight MR was merged or closed, move it from `## in-flight` to `## recently-shipped`.

4. Checkpoint key decisions. If this turn made a durable decision worth recalling
   in a future session (a gate raised, a risk accepted, a cluster-specific lesson,
   a non-obvious "why we did X"), record it via `recordKeyDecision` so it persists
   as a durable fact (agent-memory backend) or in `memory/runtime/key-decisions.md`
   (file backend). Routine status updates belong in the daily log, not here.

5. Do not write secrets, redacted log payloads, or cluster credentials to memory under any circumstance.
