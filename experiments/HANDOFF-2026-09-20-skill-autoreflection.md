# HANDOFF 2026-09-20 -- Skill autoreflection pipeline (port from xskills)

| Field | Value |
|---|---|
| Date | 2026-09-20 |
| Ticket | None yet. Create a Linear issue from this doc before implementation starts (see Workflow). |
| Source repo | `/Users/Simon.Owusu@Tommy.com/WebstormProjects/xskills`, branch `main`, HEAD `cded11d` (v5.31.0) |
| Target repo | `/Users/Simon.Owusu@Tommy.com/WebstormProjects/devops-incident-analyzer` (https://github.com/zx8086/devops-incident-analyzer), branch `main`, HEAD `7dbcf5f7` |
| Suggested branch | `feat/skill-autoreflection` |
| Source skills | `skills/x-autoreflection`, `skills/x-autoreflection-analysis`, `skills/x-autoreflection-heal` |

## TL;DR

The three xskills skills form one pipeline that answers two questions from run transcripts: "which existing skill should be improved, and how?" and "is there a recurring gap that no skill owns, so a new skill is needed?". A deterministic scanner turns each transcript into evidence-backed **signals** attributed to an owning skill. An aggregator groups signals across sessions into ranked **findings** (improve) and **portfolio moves** (create, merge, split, delete). A healer turns approved findings into exact find/replace edits that are checked and reverted on failure. Scripts find evidence; a human or LLM judges it; nothing is applied without a pick. Success in the target repo is: one command produces an `analysis.json` + `analysis.md` for a time window, its gate exits 0, and the report names the skills to improve and the gaps to create skills for.

The source is about 3,900 lines of dependency-free ESM (`node:fs`, `node:path`, `node:child_process` only). It runs under Bun unchanged. Most of the port is replacing eight x-skills-specific conventions (section 11), not rewriting logic.

This repo already has two of the pieces: `skill-learner.ts` proposes new skills from successful turns, and `skill-outcome.ts` keeps a per-skill confidence counter. What it lacks is the evidence layer between them: why a skill is weak, which line to change, whether a gap recurs across runs, and whether a recurring failure is owned by no skill at all. Section 12 scopes the work as that gap-fill. The main blocker is that run transcripts are not stored locally; the recommended source is LangSmith traces through `langsmith-fetch` (decision D1).

## Context -- how this came to be

xskills is a skill pack for coding-agent CLIs. It treats a session as a test run of the skills it used: the transcript is the only place where a skill's instructions visibly fail in practice. v5.31.0 (`710de5d feat: detect below-expectation sessions via quality anchors, implicit signals, and skill evals`) added the second evidence family, quality anchors, so a session that ran clean but disappointed the user is still detected.

The request is to reuse this mechanism in devops-incident-analyzer to decide whether to create new skills or improve existing ones. This document is written to be codebase-agnostic: sections 1-10 describe the mechanism and quote the code; section 11 lists what is x-skills specific; section 12 maps it onto the target repo.

Not read for this document, referenced only: `check-reflection.mjs` (328 lines), `save-reflection.mjs`, `check-questions.mjs`, `derive.mjs`, `references/questions.md`, and ten of the twelve host adapters. Everything quoted below was read in full.

## 1. Architecture

```
  transcripts (any store)
        |
        v
  [1] READ      adapter.list(ctx) / adapter.read(session, ctx)  ->  normalizeSession()
        |           one normalized session JSON per run
        v
  [2] SCAN      scanSession(session, {skillNames})               deterministic, no LLM
        |           signals[] = friction + quality anchors, each with suspects + evidence
        |      (optional 2b: classifyTurns -> model labels user turns -> user-pushback signals)
        v
  [3] AGGREGATE aggregate(scans) + anchorsForScans(scans)        deterministic, no LLM
        |           findings[] ranked by recurrence, portfolio[] (create/delete),
        |           retries[], select[] (reading order), audit (one quiet session)
        |           -> analysis.json (truth) + analysis.md (rendered from it)
        v
  [4] JUDGE     human/LLM opens each target file, keeps / re-grades / drops each lead
        v
  [5] HEAL      mintPlan(analysis) -> fill find/replace/check -> lint plan
                -> user picks ids -> applyItem: edit, run check, revert on failure -> ledger.jsonl
```

Design rules that make it work. Keep these when porting:

| Rule | Why |
|---|---|
| R1. The script finds, the judge decides. Severity is mechanical. | `high` means "a failing call names a skill" or "the user reacted to a skill's reply", not "the skill is at fault". |
| R2. Evidence or silence. Every signal carries a message index and an excerpt. | Proposals quote a message, a `file:line`, or a command. No "could be clearer". |
| R3. Recurrence, not volume. Findings rank by distinct sessions. | One session is a hypothesis. The same gap in three sessions is a defect. |
| R4. Rates need denominators. | A skill that ran 174 times and one that ran 6 are not comparable by count. |
| R5. A shortfall outranks friction. | A user who asked again or gave up is stronger evidence than a failed command. |
| R6. The measure is never edited with the measured. | A self-improving loop that can edit its own detector will report a perfect score. |
| R7. Deltas, not rewrites. `find` must match exactly once. | Wholesale prompt rewrites lose the one line that mattered. |
| R8. Portfolio moves are proposed, never applied. | Create, merge, split, delete are human decisions. |

## 2. Data contracts

These five shapes are the agnostic core. Everything else is a function between them. Zod sketches are given because the target uses Zod; field names match the source exactly.

### 2.1 Raw adapter output (what an adapter returns)

Source: `skills/x-autoreflection/scripts/hosts/index.mjs:5-13`, `hosts/shared.mjs:182-203`.

```ts
const RawPart = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("reasoning"), thinking: z.string() }),
  z.object({ type: z.literal("tool_call"), tool_call_id: z.string().nullable(), name: z.string(), input: z.string().describe("JSON-encoded tool arguments, kept whole") }),
  z.object({ type: z.literal("tool_result"), tool_call_id: z.string().nullable(), name: z.string().nullable(), content: z.string() }),
  z.object({ type: z.literal("finish"), reason: z.string().nullable().describe("'canceled' marks a user interrupt") }),
]);

const RawSession = z.object({
  meta: z.object({
    host: z.string(), id: z.string(), uuid: z.string().nullable(), title: z.string().nullable(),
    created: z.string().nullable(), modified: z.string().nullable(),
    headless: z.boolean().describe("true when a script, not a person, drove the run; excluded from anchors"),
    skills: z.array(z.object({ name: z.string(), loaded_at: z.string().nullable() })),
  }),
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]), created: z.string().nullable(),
    model: z.string().optional(), provider: z.string().optional(),
    parts: z.array(RawPart),
  })),
});
```

### 2.2 Normalized session (scanner input)

Source: `read-session.mjs:21-90`. `normalizeSession` adds `index` per message, renames `tool_call_id` to `id`, moves `thinking` to `text`, and clips. Clipping rule: tool results and reasoning are clipped to 600 characters keeping 60% head and 40% tail, because the error is at the head and the exit code at the tail. Prose and tool-call input are never clipped: the scanner parses the input JSON, and an elided sentence both cites badly and breaks the question detector.

```js
// read-session.mjs:14-19
function clip(text, limit) {
  const value = String(text ?? "");
  if (!limit || value.length <= limit) return value;
  const head = Math.ceil(limit * 0.6);
  return `${value.slice(0, head)}…${value.slice(value.length - (limit - head))}`;
}
```

Result shape: `{ source: {host,id,uuid,title,created,modified,headless,model,models}, skills: [{name, loadedAt}], messages: [{index, role, created, model?, provider?, parts}] }`. `source.model` is the model that gave the most assistant replies; `models` is the per-model reply count (`read-session.mjs:56-62`). The model is recorded because a skill is a prompt tuned on a model, so "regressed under model X only" must be askable.

### 2.3 Scan (one per session)

Source: `scan-session.mjs:566-606`.

```ts
const Evidence = z.object({ message: z.number().describe("message index"), tool: z.string().nullable(), excerpt: z.string() });
const Signal = z.object({
  id: z.string().regex(/^S\d+$/), kind: z.string(), severity: z.enum(["high", "medium", "low"]),
  summary: z.string(), count: z.number(),
  suspects: z.array(z.string()).describe("skill names; for a quality anchor this is the single owner"),
  evidence: z.array(Evidence).max(3),
});
const Scan = z.object({
  source: RawSession.shape.meta.partial().nullable(),
  request: z.object({ message: z.number(), created: z.string().nullable(), text: z.string() }).nullable()
    .describe("first user turn of >= 8 words; used for cross-session retry matching"),
  lastOwner: z.string().nullable(),
  stats: z.record(z.number()),
  skills: z.object({ loaded: z.array(z.string()), used: z.array(z.string()), unused: z.array(z.string()), mentioned: z.array(z.string()) }),
  checks: z.array(z.object({ skill: z.string(), script: z.string(), calls: z.number(), passes: z.number(), refusals: z.number(), fails: z.number() })),
  graphs: z.array(z.object({ skill: z.string(), calls: z.number(), illegalMoves: z.number(), prematureTransitions: z.number() })),
  writes: z.array(z.object({ path: z.string(), message: z.number() })),
  signals: z.array(Signal), notes: z.array(z.string()),
});
```

`stats` keys: `messages, userMessages, assistantMessages, toolCalls, toolResults, panels, toolFailures, expectedExits, repeats, corrections, reprompts, proseQuestions, redoRequests, handoffs, rejections, interrupts, silentScripts, pushback, abandons`.

### 2.4 Analysis report (one per window)

Source: `analyze.mjs:70-224, 319-327`. Schema id `x-autoreflection-analysis/1`.

```jsonc
{
  "schema": "x-autoreflection-analysis/1",
  "generatedAt": "2026-09-18 14:00",
  "window": { "hours": 24, "since": "...", "until": "..." },
  "stats": { "sessions": 41, "skillsTouched": 9, "signals": 128, "high": 12, "findings": 5, "portfolio": 2 },
  "skills": [ { "name": "x-plan", "sessions": 5, "loaded": 3, "used": 5, "unused": 0, "high": 2, "medium": 3, "low": 0 } ],
  "findings": [ { "id": "F1", "kind": "tool-failure", "class": "doc-command-drift", "skill": "x-epic",
                  "severity": "high", "recurrence": 3, "count": 5, "summary": "...", "change": "...",
                  "sessions": ["s1","s2","s3"], "evidence": [ { "session": "s1", "message": 12, "excerpt": "..." } ] } ],
  "retries":   [ { "earlier": "crush:9bb1", "later": "claude:5fe2", "hours": 0.4, "overlap": 0.97, "excerpt": "..." } ],
  "select":    [ { "session": "crush:9bb1", "reason": "user-handoff", "owner": "x-plan", "model": "...", "anchors": [] } ],
  "recurring": [ { "owner": "x-anal", "sessions": ["...","..."], "reason": "tool-rejected" } ],
  "audit":     { "session": "crush:327d", "model": "...", "owner": null },
  "portfolio": [ { "id": "PF1", "action": "delete", "skills": ["x-triage"], "reason": "loaded but never used in 3 sessions", "evidence": [] } ],
  "notes": ["..."]
}
```

### 2.5 Heal plan and ledger

Source: `heal.mjs:143-163, 221-223`. Schema id `x-autoreflection-heal/1`.

```jsonc
{ "schema": "x-autoreflection-heal/1", "analysis": "<path>", "generatedAt": "...",
  "items": [ { "id": "F1", "skill": "x-epic", "class": "doc-command-drift",
               "target": "skills/x-epic/SKILL.md", "find": "`--topic`", "replace": "`--slug`",
               "check": "node skills/x-skill-lint/scripts/lint.mjs", "auto": true,
               "watch": "(quality classes only) skill, model, rate that should fall, window",
               "change": "...", "evidence": [] } ] }
```

Ledger line (`heal-ledger.jsonl`, append-only): `{ "at": ISO, "id": "F1", "status": "applied|reverted|stale|ambiguous|skipped|would-apply", "detail": "...", "watch"?: "..." }`.

## 3. Stage 1 -- reading transcripts

An adapter is an object with `id`, `label`, `detect(ctx)`, `list(ctx) -> {sessions, warnings}`, `read(session, ctx) -> RawSession`. `ctx` is `{ now, hours, projectLookbackHours, env, run }`; `run(command, args, {cwd})` returns stdout and throws on failure, so a test drives an adapter by stubbing `run` alone (`hosts/index.mjs:5-13`).

Behaviours to keep:

- A missing store reports `absent`, a failing one `unreadable`, never silence (`hosts/index.mjs:47-53`). An empty window must say which stores were looked at.
- A session whose timestamp cannot be parsed is dropped from a window, not guessed as recent (`hosts/shared.mjs:41-46`).
- A JSONL line that does not parse is skipped, because a live session ends mid-line (`hosts/shared.mjs:104-119`).
- Listing reads only the first 64 KB / 40 lines of a transcript (`hosts/shared.mjs:126-147`).

The Claude Code adapter is the reference implementation and is directly reusable if the target's skills are exercised through Claude Code sessions. Full file: `hosts/claude.mjs` (145 lines). The three non-obvious facts it encodes:

```js
// hosts/claude.mjs:70-99 -- skill loads and headless detection
const SKILL_BODY_RE = /^Base directory for this skill:\s*\S*\/skills\/([A-Za-z0-9._:-]+)/;

function skillLoadsIn(record) {
  const blocks = [].concat(record?.message?.content ?? []);
  return blocks
    .flatMap((block) => {
      if (block?.type === "tool_use" && block.name === "Skill" && block.input?.skill) return [String(block.input.skill)];
      const text = typeof block === "string" ? block : block?.type === "text" ? String(block.text ?? "") : "";
      const match = text.match(SKILL_BODY_RE);
      return match ? [match[1]] : [];
    })
    .map((name) => ({ name, loaded_at: record.timestamp ?? null }));
}

export function isHeadless(records) {
  return records.some((record) => record?.entrypoint === "sdk-cli");
}
```

Anthropic-shaped content blocks (`text`, `thinking`, `tool_use`, `tool_result`) map to parts in `hosts/shared.mjs:182-203`. Any store that holds messages, tool calls and tool results can be adapted with a function of that size.

## 4. Stage 2 -- the scanner

Entry point: `scanSession(session, { skillNames, skillsSource, turns })` at `scan-session.mjs:566`. `skillNames` is the list of skill directories on disk; when given, every suspect list is filtered to known skills (`keep`, line 569), which removes false attributions from arbitrary `x-...` strings.

### 4.1 Signal catalogue

Friction signals (a step failed, repeated, or was corrected):

| Kind | Detector | Severity | Suspects |
|---|---|---|---|
| `tool-failure` | tool result matches `/^(?:Exit code\|exit status) ([1-9]\d*)\s*$/m`, or an edit result contains `old_string not found in file`, or its first non-empty line matches `/^(Error:\|Error \[\|fatal:\|panic:)/` (`failureOf`, lines 132-150) | `high` if any suspect, else `medium` if count > 1, else `low` | skills named in the call input or in the assistant text up to 3 messages before |
| `expected-exit` | same exit marker, but every status-reporting command is in `EXPECTED_NONZERO` (`diff, cmp, grep, egrep, fgrep, test, git diff, git grep`) or `NEUTRAL` (`cd, echo, export, set, true, printf, pwd`) | `low`, never a finding | same |
| `repeat-call` | same tool name and byte-identical input, 2+ times | `medium` if > 2, else `low` | skills named in the input |
| `user-correction` | user text matches `CORRECTION_RE` and has > 2 words | `high` | all loaded skills |
| `user-reprompt` | user text of <= 3 words matching `REPROMPT_RE` ("continue", "go on", "try again") | `medium` if > 1, else `low` | all loaded skills |
| `prose-question` | assistant turn without a `question` tool call whose last line, after stripping code fences, ends in `?` and is <= 120 chars | `medium` | all loaded skills |
| `skill-unused` | skill is in `loaded` but not in `used` | `low` | the unused skills |

Quality anchors (nothing failed, the session still fell short). Source: `reactions.mjs`.

| Kind | Detector | Severity | Suspect |
|---|---|---|---|
| `user-redo` | user turn after the opening request, > 3 words, matches `REDO_RE` | `high` | owner at that message |
| `user-handoff` | same, matches `HANDOFF_RE` | `high` | owner |
| `tool-rejected` | tool result starts with the host's refusal notice (`REJECTED_RE`) | `high` if owner known, else `medium` | owner |
| `skill-script-silent` | a skill's own script exited 0, printed nothing, stdout not redirected | `high` | the script's skill |
| `user-pushback` | a model labelled the turn `pushback\|redo\|handoff\|verify-ask` and no phrase detector caught it | `medium`, marked unvalidated | owner |
| `interrupt` | `finish.reason === "canceled"` or user text starts `[Request interrupted by user` | `low`, context only, never a finding | owner |
| `user-abandon` | session ends on an assistant answer that asks nothing, after real work | `low`, weak signal | owner |
| `cross-session-retry` | computed across sessions, see section 6 | n/a | earlier session's `lastOwner` |
| `user-handedit` | a file the agent wrote was modified after the session by no other session (`anchors.mjs:128-153`) | `medium`, weak signal | `lastOwner` |
| `user-dissatisfied` | two or more distinct weak kinds on one session (`user-abandon, user-handedit, user-pushback, user-reprompt`) | composite | `lastOwner` |

The phrase lists, verbatim:

```js
// scan-session.mjs:15-18
const CORRECTION_RE = /^(no|nope|wrong|not quite|actually|i said|i meant|that's not|thats not|stop|don't|dont|again|still)\b[,\s]/i;
const REPROMPT_RE = /^(continue|go on|try again|retry|proceed|keep going|next|again)\b[.!]?$/i;

// reactions.mjs:11-19
export const REDO_RE =
  /\b(once again|another (full )?(round|pass|go)|one more time|re-?do|start over|from scratch|do it (again|properly|right)|again check|check again|jeszcze raz|ponownie|od nowa)\b/i;
export const HANDOFF_RE =
  /\b(another agent|other agent|pass it to|hand (it )?off|as (an? )?(llm )?prompt|i'?ll do it myself|i will do it myself|never ?mind|forget it|i give up)\b/i;
const REJECTED_RE = /^(The user doesn't want to proceed with this tool use|User (denied|rejected)|Permission denied by (the )?user)/i;
```

`reactions.mjs:6` states each phrase detector "was measured precise on a week of real sessions". They are tuned to that author's sessions (note the Polish phrases). Re-measure on target transcripts before trusting them.

### 4.2 Expected-exit logic

A naive "non-zero exit is a failure" rule floods the report. The rule used: the exit is expected only when every command that could have reported the status is an expected-nonzero or neutral command, so a `grep` at the end of an `&&` chain does not excuse a `node` script that failed before it.

```js
// scan-session.mjs:83-118
export function statusCommands(commandText) {
  return String(commandText ?? "")
    .split(/&&|\|\||;|\n/)
    .map((chain) => chain.trim())
    .filter((chain) => chain && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(chain))
    .map((chain) => {
      const stages = chain.split("|").map((stage) => stage.trim()).filter(Boolean);
      return stages[stages.length - 1] ?? "";   // a pipeline's status is its last stage's
    })
    .filter(Boolean);
}

export function isExpectedExit(command) {
  const commands = statusCommands(command);
  if (!commands.length) return false;
  return commands.every((segment) => {
    const word = commandWord(segment);           // "git diff" counts as one word
    return NEUTRAL.includes(word) || EXPECTED_NONZERO.includes(word);
  });
}
```

### 4.3 Used versus mentioned

A skill counts as **used** only in the session's own words, tool calls and files. Tool results and injected skill bodies do not count. Without this, one `ls skills/` marks every skill used and `skill-unused` can never fire.

```js
// scan-session.mjs:181-208
const INJECTED_SKILL_BODY_RE = /^Base directory for this skill:/;

function isOwnWords(part, message) {
  if (part.type === "tool_result") return false;
  return !(message.role === "user" && part.type === "text" && INJECTED_SKILL_BODY_RE.test(part.text ?? ""));
}

function collectSkills(session, keep) {
  const loaded = session.skills.map((skill) => skill.name);
  const parts = session.messages.flatMap((message) => message.parts.map((part) => ({ part, message })));
  const used = new Set(parts.filter(({ part, message }) => isOwnWords(part, message)).flatMap(({ part }) => namesIn(part, keep)));
  const mentioned = new Set(parts.flatMap(({ part }) => namesIn(part, keep)));
  return { loaded, used: [...used].sort(), unused: loaded.filter((name) => !used.has(name)), mentioned: [...mentioned].sort() };
}
```

### 4.4 Attribution: suspects versus owner

Two different rules, and the difference matters.

- **Friction** uses proximity: skills named in the failing call's input or in the assistant text within 3 messages before it (`recordFailure`, lines 389-396). User-text signals blame every loaded skill, which is deliberately coarse.
- **Quality anchors** use an **owner timeline**: the skill in charge at that message, meaning the last skill that was invoked through the `Skill` tool, had its body injected, or had one of its files touched by a tool call's `command`, `file_path`, `path` or `edits[].file_path`. Written file content is excluded, because it can mention any skill's path without the session using that skill.

```js
// reactions.mjs:76-109
function targetsOf(input) {
  const edits = Array.isArray(input.edits) ? input.edits.map((edit) => edit?.file_path) : [];
  return [input.command, input.file_path, input.path, ...edits].filter((value) => typeof value === "string");
}

function skillsActiveIn(message, keep) {
  return message.parts.flatMap((part) => {
    if (part.type === "tool_call") {
      const input = inputOf(part);
      const invoked = part.name === "Skill" && typeof input.skill === "string" ? [input.skill] : [];
      const touched = targetsOf(input).flatMap((target) => [...target.matchAll(/skills\/(x-[a-z0-9-]+)\//g)].map((match) => match[1]));
      return keep([...invoked, ...touched]);
    }
    if (message.role === "user" && part.type === "text") {
      const match = String(part.text ?? "").match(SKILL_BODY_RE);
      return match ? keep([match[1]]) : [];
    }
    return [];
  });
}

export function ownerTimeline(messages, keep = (names) => names) {
  return messages.flatMap((message) => skillsActiveIn(message, keep).map((skill) => ({ index: message.index, skill })));
}

export function ownerAt(timeline, index, fallback = null) {
  const before = timeline.filter((event) => event.index <= index);
  return before.length ? before[before.length - 1].skill : fallback;
}
```

Fallback owner: the single loaded skill, when exactly one was loaded (`reactions.mjs:240`).

### 4.5 The user's own turns

Hosts inject text into the user role (skill bodies, caveats, system reminders, task notifications). Those are filtered out before any user-reaction detector runs (`INJECTED_RE`, `reactions.mjs:27-28`, `userTurns` at 59-64). Redo and handoff are read only after the opening request, so a session that opens by re-asking earlier work is not blamed for it; that case is `cross-session-retry`.

### 4.6 Skill self-checks (conformance input)

`scanSkillScripts` (`scan-session.mjs:254-319`) records, per skill, how many of its own check scripts passed, were refused, or failed. It matches commands against `skills/<name>/scripts/<file>.(mjs|js|cjs)` and treats files named `check-*`, `validate-*`, `commit`, `lint`, `scenario`, `save-*`, `scan-session` as checks. This is the only place a skill is judged by its own contract rather than by a nearby failing command. It is convention-based; the source comment at 222-226 says a per-skill `checks.json` would be the better design.

### 4.7 Optional model pass (stage 2b)

`classify-turns.mjs` builds a prompt, any model answers, the script parses the answers. The skill carries no API key and no provider. Input per turn: the user text (400 chars) plus the last 300 chars of the assistant reply before it. Only user turns after the opening request with >= 4 words are sent. Seven classes: `pushback, redo, handoff, verify-ask, clarify, neutral, positive`; the first four are negative. Output format is one line per message, `<number> <class>`; a line naming no known class is dropped, never guessed (`parseAnswers`, lines 79-88). The full rubric is at `classify-turns.mjs:30-42`. Results enter the scan as `user-pushback` and stay unvalidated (section 8.3).

## 5. Stage 3 -- aggregation into findings and portfolio

Entry point: `aggregate(scans, {hours})` at `analyze.mjs:70`. Pure function, testable with synthetic scans.

**Grouping.** Signals group by `(kind, primary suspect)` where the primary suspect is `suspects[0]`. `skill-unused` groups per skill, not per suspect list. `expected-exit` and `interrupt` are skipped as non-gaps (`NON_GAP_KINDS`, line 60).

**Recurrence** is the number of distinct session ids in the group. **Count** is the sum of signal counts. Group severity is the maximum seen.

**Ranking** (`analyze.mjs:190-196`): recurrence descending, then severity (`high 3, medium 2, low 1`), then count, then id.

**Class and change hint.** Each kind maps to an improvement class and a one-line change hint:

```js
// analyze.mjs:23-36
export const CLASS_BY_KIND = {
  "tool-failure": "doc-command-drift",
  "repeat-call": "missing-check",
  "user-correction": "missing-gate",
  "user-reprompt": "stopping-point",
  "prose-question": "panel-rule",
  "user-redo": "missing-expectation",
  "user-handoff": "missing-expectation",
  "user-pushback": "missing-expectation",
  "tool-rejected": "ritual-cost",
  "skill-script-silent": "silent-success",
};
```

**Portfolio: the create-or-improve decision.** This is the part that answers "new skill or improve existing":

```js
// analyze.mjs:148-186 (condensed)
if (group.kind === "skill-unused") {
  if (recurrence >= DELETE_MIN_RECURRENCE /* 2 */) portfolio.push({ action: "delete", skills: [group.skill],
    reason: `loaded but never used in ${recurrence} session(s)` });
  continue;
}
// ... finding is pushed ...
// A failure no skill names is a gap no skill covers: a create candidate.
if (!group.skill && (group.kind === "tool-failure" || group.kind === "user-correction") && recurrence >= 2) {
  portfolio.push({ action: "create", skills: [],
    reason: `recurring ${group.kind} names no skill, so no skill owns this gap` });
}
```

| Outcome | Mechanical rule | Source |
|---|---|---|
| Improve existing skill | any finding whose `skill` is set | `analyze.mjs:161-175` |
| Create new skill | recurring (>= 2 sessions) `tool-failure` or `user-correction` with no suspect skill | `analyze.mjs:178-186` |
| Delete skill | `skill-unused` for the same skill in >= 2 sessions | `analyze.mjs:148-158` |
| Merge or split | none. No scan signal can tell that a skill mixes two jobs. Recorded by hand after reading the skills. | `x-autoreflection-analysis/SKILL.md:134-137` |

Known ceiling: the create rule only sees failures and corrections. A recurring request that no skill triggered on, and that did not fail, is invisible to it. The daily audit pick (section 6) exists to catch that class by human reading.

**Output.** `writeReport` writes the JSON and renders the markdown from the same object, so they cannot drift (`analyze.mjs:407-415`). Never edit the markdown by hand.

## 6. Cross-session anchors

Source: `anchors.mjs`. Pure functions over scans; headless sessions are excluded (`anchorsForScans`, line 240).

**Cross-session retry.** A later session that opens with most of an earlier session's request marks the earlier one as having fallen short. Text is lowercased, URLs and punctuation removed, split into 3-word shingles. Overlap is measured against the shorter text.

```js
// anchors.mjs:44-59
export function shingles(text, size = 3) {
  const words = String(text ?? "").toLowerCase().replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  return new Set(words.slice(0, Math.max(0, words.length - size + 1)).map((_, i) => words.slice(i, i + size).join(" ")));
}

export function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  return [...small].filter((gram) => large.has(gram)).length / small.size;
}
```

Thresholds: overlap >= 0.5, gap <= 48 hours, and an opener whose first 60 characters appear in >= 3 sessions is treated as an automation template and excluded (`anchors.mjs:11-16, 63-69`).

**Reading order.** `selectSessions` picks at most 4 sessions (`cap`): anchored sessions sorted by `SELECT_ORDER`, one per owning skill, then friction-only sessions. The other sessions of the same owner collapse into one `recurring` line.

```js
// anchors.mjs:24-33
export const SELECT_ORDER = ["user-handoff", "cross-session-retry", "tool-rejected", "user-redo",
  "user-handedit", "user-dissatisfied", "skill-script-silent", "user-pushback"];
```

`user-pushback` joins the order only after its detector is validated (section 8.3).

**Audit pick.** One interactive session per day with no anchor and >= 2 user messages, chosen by a hash seeded with the date so the pick is stable across reruns (`anchors.mjs:204-219`). It is the only way to learn what the detectors miss. Findings from it are recorded with the id `manual`.

## 7. Judgement layer (the part that is prose, not code)

The SKILL.md files instruct the agent, or a person, to do what no script can verify.

**Verify every signal against the real file** (`x-autoreflection/SKILL.md:151-179`). For each `high` and each plausible `medium` signal: open the file it points at, then record one verdict. **keep**: the file really is wrong or unhelpful; quote the offending `file:line`. **re-grade**: real friction, but not that skill's fault. **drop**: the transcript misled the scanner; record why so the next reflection does not re-litigate it. A gap found by reading rather than from a signal takes the id `manual`. Low signals answered together take the id `group`; a grouped verdict never satisfies a `high` signal.

**Judge a quality anchor with one narrow question** (`references/quality-judge.md`). Never ask "what went wrong in this session?"; that question always finds something. Start at the anchor's message, read the reply the user reacted to, open what the session produced, and answer: *which line of the request, or of the owner's SKILL.md or expectations file, did the reply before this turn not meet?* Quote both sides. If no line says it, the finding is "the skill never said it". Name the failure mode from the codebook so the same mode across sessions reads as one defect:

| Mode | Usual class |
|---|---|
| rule not applied | `rule-not-applied` |
| intent misread | `missing-expectation` |
| overclaim ("done", "verified" beyond the trace) | `unbacked-report` |
| shallow or premature | `depth-floor` |
| no verification after last change | `missing-gate` |
| input the user named was never read | `unbacked-report` |
| ritual over outcome (a step the situation did not need) | `ritual-cost` |
| silent success | `silent-success` |

Also from that file: say which model judged, because a model grading its own family rates it higher; and surface-compliance fails (right filename, thin content).

**Proposal shape** (`x-autoreflection/SKILL.md:183-205`). One proposal per gap, not per signal:

```markdown
### P1 -- <signal kind>: <the one-line change>
**Signal:** S3
**Target:** `skills/x-example/SKILL.md:64`
**Change:** <concrete enough that someone else could make the edit>
**Check:** `<command>` exits 0
**Watch:** (quality gaps only) the skill, the model, the rate that should drop, and the window
```

**Improvement classes** (`references/gap-taxonomy.md:54-68`). Seven friction classes: `doc-command-drift, script-hardening, missing-gate, panel-rule, missing-check, stopping-point, contract-drift`. Six quality classes: `rule-not-applied, missing-expectation, unbacked-report, depth-floor, ritual-cost, silent-success`. Prefer `missing-check` when a mechanism exists: a doc line can drift again, a test cannot.

**Not a gap** (`gap-taxonomy.md:74-84`): the user changed their mind; the environment was missing something; the agent's own exploratory probe failed; one slow step without a measured comparison; a headless run.

**Expectations file.** A `missing-expectation` fix is one line in `skills/<x>/evals/expectations.json`, in the user's words, with the finding id in `source`: `{"skill", "expected_behavior": [...], "source": ["F2"]}`, at most seven lines. The judge reads it next to SKILL.md, so an expectation a user once had to state is asked of every later run (`x-autoreflection-heal/SKILL.md:86-89`).

## 8. Metrics

Source: `metrics.mjs`. Optional for a first port; needed once there is enough volume to compare skills.

### 8.1 Five rates per skill

Every dimension is a rate with a named denominator. A zero denominator gives `null` (not measured), and the weights renormalise over measured dimensions only, so a skill is never punished for a denominator it never had.

```js
// metrics.mjs:19-25, 35, 114-139
export const WEIGHTS_V1 = { conformance: 0.3, adherence: 0.2, trigger: 0.2, rework: 0.15, protocol: 0.15 };
export const SAMPLE_FLOOR = 5;   // below this many loaded sessions: "insufficient data", no score

export function dimensionsOf(tally) {
  const { checks, graphs } = tally;
  const passes = checks.passes ?? 0, fails = checks.fails ?? 0;
  return {
    conformance: checks.declared ? rate(passes, passes + fails) : null,            // own checks accepted its work
    adherence: graphs.calls ? 1 - rate(graphs.illegalMoves + graphs.prematureTransitions, graphs.calls) : null,
    trigger: tally.named ? rate(tally.loaded, tally.named) : null,                 // loaded, not merely named
    rework: tally.toolCalls ? 1 - rate(tally.repeats, tally.toolCalls) : null,     // work was not redone
    protocol: tally.panels + tally.proseQuestions ? rate(tally.panels, tally.panels + tally.proseQuestions) : null,
  };
}

export function compose(dimensions, weights = WEIGHTS_V1) {
  const used = DIMENSIONS.filter((name) => dimensions[name] !== null);
  const total = used.reduce((sum, name) => sum + weights[name], 0);
  if (!total) return { score: null, used, coverage: 0 };
  const score = used.reduce((sum, name) => sum + weights[name] * dimensions[name], 0) / total;
  return { score: score * 100, used, coverage: total };   // coverage: how much weight the score rests on
}
```

`adherence` and `protocol` are x-skills specific (a state-graph CLI and a panel tool). Drop or replace them in the target.

### 8.2 Shortfall rate per skill and model

`shortfallRates` (`metrics.mjs:370-406`) reports, per skill and per model, the share of sessions that carry a shortfall anchor the skill owns (`user-redo, user-handoff, tool-rejected, user-pushback, cross-session-retry`). It is reported beside the composite score and never inside it: "a number heal could optimise is a number that stops meaning anything". Within one skill it is the only fair model comparison. This is the number a `Watch:` line refers to.

### 8.3 Detector validation

A detector may choose which sessions get read only after human labels validate it. A reviewer labels each anchored session `good`, `below`, or `not-a-skill-problem`. A kind is validated at >= 60 labels and precision >= 0.8, where precision is the share labelled `below`; `not-a-skill-problem` counts against the detector (`metrics.mjs:325-358`). Audit labels score no detector.

## 9. Stage 5 -- healing

Source: `heal.mjs`, `check-heal.mjs`.

**Mint.** `mintPlan` creates one item per finding with `target` defaulted to the skill's SKILL.md and `find, replace, check` empty, `auto: false`. Quality-class items get an empty `watch` field. A finding dropped after reading its file is deleted from the plan, not left empty.

**Fill.** The agent opens each target, then writes the smallest `find`/`replace` that answers the finding and a `check` command that exits 0 once the fix is in.

**Auto whitelist.** Only four classes may be `auto: true`: `doc-command-drift, missing-gate, panel-rule, contract-drift`. The six quality classes are never auto and must name a `watch`.

**Apply.** The whole safety model is this function:

```js
// heal.mjs:180-209
export function applyItem(item, { cwd = process.cwd(), dryRun = false } = {}) {
  if (item.auto !== true) return { id: item.id, status: "skipped", detail: "not marked auto" };
  if (!item.target || !item.find) return { id: item.id, status: "skipped", detail: "no target or find" };
  const file = path.resolve(cwd, item.target);
  if (!fs.existsSync(file)) return { id: item.id, status: "stale", detail: `target missing: ${item.target}` };
  const original = fs.readFileSync(file, "utf8");
  const occurrences = countOccurrences(original, item.find);
  if (occurrences === 0) return { id: item.id, status: "stale", detail: `"${item.find}" not found in ${item.target}` };
  if (occurrences > 1) return { id: item.id, status: "ambiguous", detail: `"${item.find}" occurs ${occurrences}x; make it unique` };

  const edited = original.replace(item.find, item.replace ?? "");
  if (!dryRun) fs.writeFileSync(file, edited);

  const check = runCheck(item.check, cwd);
  if (check.status !== 0) {
    if (!dryRun) fs.writeFileSync(file, original);
    return { id: item.id, status: "reverted", detail: `check failed: ${check.stderr || check.stdout || item.check}`.slice(0, 200) };
  }
  return { id: item.id, status: dryRun ? "would-apply" : "applied", detail: item.target, ...(item.watch ? { watch: item.watch } : {}) };
}
```

Source defect to fix when porting: with `--dry-run` the file is not written, but `runCheck` still runs against the unedited file, so a dry run can report `reverted` for an edit that would pass. Skip the check in dry-run mode.

`runCheck` executes `item.check` with `shell: true`. The plan file is therefore executable input. Only apply plans you wrote or reviewed.

**Measure/measured separation.** `measuresOf(target)` returns `*` for the shared detectors, gates and taxonomy files, a skill name for that skill's own `check-*`/`validate-*` script, or null (`heal.mjs:29-48`). `check-heal.mjs` fails the plan when a measure is `auto` (`auto-measure`) or shares a plan with a skill it measures (`measure-and-measured`). Port `SHARED_MEASURES` with the target's own paths.

## 10. Gates

Each stage has a linter with exit codes 0 clean, 1 violations, 2 usage error.

| Gate | Rules | Source |
|---|---|---|
| `check-analysis` | `bad-schema, no-evidence` (sessions < 1), `missing-findings, missing-portfolio, finding-id` (`F<n>`), `finding-kind, finding-recurrence, finding-evidence, portfolio-id` (`PF<n>`), `portfolio-action` (one of create/merge/split/delete), `portfolio-skills, portfolio-reason` | `check-analysis.mjs:10-46` |
| `check-heal` | `bad-schema, no-analysis, empty-items, item-id, item-target, item-watch, check-edits-itself, auto-measure, item-find, item-check, auto-class, measure-and-measured` | `check-heal.mjs:26-62` |
| `check-reflection` | `proposal-shape, unanswered-high, kept-without-proposal, scan-not-evidence, quality-unanchored, quality-quote, quality-skill-line, quality-watch, unknown-signal, unparsed-gap, bad-severity, bad-verdict, empty-gaps, empty-proposals, empty-routes, missing-scan, no-signals, no-source, template-comment` | `check-reflection.mjs` (rule names only; file not read in full) |

`quality-quote` verifies that the user quote in a `## Quality` line really occurs in the transcript, and `quality-skill-line` that the cited `file:line` exists with the quote within three lines. This is what stops an LLM judge from inventing evidence.

Some gates are contracts that no script can check: that the agent actually read the file, asked the question as a panel, and that the user picked the route. The source SKILL.md marks these explicitly rather than implying they are machine-checked.

## 11. What is x-skills specific and must be replaced

| # | Convention in source | Where | Replace with |
|---|---|---|---|
| X1 | Skill names match `\bx-[a-z0-9-]+\b`; skill paths match `skills/(x-[a-z0-9-]+)/` | `scan-session.mjs:120-125, 173`, `reactions.mjs:21, 86`, `check-heal.mjs:7`, `heal.mjs:36` | The target's skill naming and directory. Always pass an explicit `skillNames` allowlist; the prefix regex alone is too loose without the `x-` prefix. |
| X2 | Failure markers are Crush / Claude Code wording: `Exit code N`, `old_string not found in file`, leading `Error:` | `scan-session.mjs:132-150, 241-244` | The target store's failure representation. Prefer a structured error flag over text matching where one exists. |
| X3 | A "panel" is a tool call named `question`; `prose-question` and the `protocol` rate depend on it | `scan-session.mjs:449`, `reactions.mjs:169` | The target's structured-question mechanism, or drop both. |
| X4 | Skill load is detected by a `Skill` tool call or a user message starting `Base directory for this skill:` | `hosts/claude.mjs:71-83`, `reactions.mjs:26, 85` | However the target records that a skill was selected for a run. |
| X5 | Artifacts live in `.x-skills/runs/<stamp>-R<nn>-<slug>/E<nn>-<name>`; the run-folder helper is duplicated in `analyze.mjs:234-316` and `heal.mjs:58-140` | both | One output directory convention in the target. Do not port the duplication. |
| X6 | `scanSkillScripts` assumes `skills/<name>/scripts/check-*.mjs` and a `scenario.mjs record --to` state-graph CLI | `scan-session.mjs:219-319` | Drop `graphs`/`adherence`. Keep `checks`/`conformance` only if target skills ship self-checks. |
| X7 | `analyze.mjs` shells out to sibling scripts because the xskills lint forbids cross-skill imports | `analyze.mjs:15-18, 417-465` | Import the functions directly. |
| X8 | `--session last` calls the `crush` binary | `read-session.mjs:96-100, 159-167, 177` | Delete. |

## 12. Mapping onto devops-incident-analyzer

This is a gap-fill, not a fresh port. The target already has a create path and a coarse improve path. It lacks the evidence layer between them.

### 12.1 What the target already has

| Concern | Target today | Reference |
|---|---|---|
| What a skill is | `agents/<agent>/skills/<name>/SKILL.md`, also per sub-agent under `agents/<agent>/agents/<sub>/skills/` and `agents/shared/skills/`. 35 first-party files: elastic-iac 16, incident-analyzer 7, capella-agent 3, gitlab-agent 3, elastic-agent 1, pi-fleet/aws-spoke 4, shared 1. Frontmatter `name`, `description`, plus optional learning counters. Declared per agent in `agent.yaml` under `skills:`. | `agents/incident-analyzer/agent.yaml:46-53`, `packages/gitagent-bridge/src/types.ts:330-332` |
| Which skills ran in a turn | The aggregate node writes `getActiveSkillNames()` onto `state.skillsApplied` | `packages/agent/src/state.ts:441-447`, `packages/agent/src/aggregator.ts:1663-1667` |
| Create a new skill | `skill-learner.ts`: an LLM judge runs after a turn that is `complex`, has confidence >= 0.6 and used >= 2 datasources, and asks whether the turn exercised a reusable pattern. A worthy verdict becomes a durable `kind:skill` agent-memory fact. Propose-only; a human promotes it with `skill-promote-cli.ts`. | `packages/agent/src/skill-learner.ts:24-29, 68-86, 111-132` |
| Improve an existing skill | `skill-outcome.ts`: per-skill `usage_count / success_count / failure_count` in the SKILL.md frontmatter, with Laplace confidence `(success + 1) / (usage + 2)`. Outcome is turn-level: `validationResult === "fail"` plus `confidenceScore`. | `packages/agent/src/skill-outcome.ts:34-52, 109`, `apps/web/src/lib/server/agent.ts:565-583` |
| Post-turn hook | One slot, last registration wins. Both halves above run inside it. | `packages/agent/src/lifecycle.ts:105-107, 306-308`, `packages/agent/src/skill-learner-install.ts:70-87` |
| Tool failure representation | Structured, not text: LangGraph `ToolMessage` with `status="error"`; closed enum `ToolErrorCategory` = `auth, session, transient, not-found, bad-query, no-data, server-error, unknown`; MCP-side `ToolCallFailureClass` = `bad-input, unstructured, unknown-tool, structured-other`; `collectToolFailures(state)` | `packages/shared/src/agent-state.ts:26-36`, `packages/shared/src/tool-call-metrics.ts:31`, `packages/agent/src/sub-agent.ts:862, 965`, `packages/agent/src/follow-up-generator.ts:76` |
| Explicit user feedback | `POST /api/agent/feedback` with `{runId, score 0..1, comment?}`, stored as LangSmith feedback key `user-feedback` | `apps/web/src/routes/api/agent/feedback/+server.ts:6-31` |
| HIL learning flow | `packages/agent/src/learn/*` (detect, match, distill, edits, apply, runbook, skill-pr, ticket). A user-invoked flow that distils learnings from an incident ticket and can open a skill PR. Not read in depth for this document. | `packages/agent/src/learn/distill.ts:202`, `learn/apply.ts:185` |
| Evals | `packages/agent/src/eval/` with root scripts `eval:agent`, `eval:incident-replay`, `eval:mcp-tool`, `eval:tool-probe`, `eval:spec-audit` | root `package.json` |
| Transcript store | None locally. LangSmith traces. The checkpointer is in-memory only; sqlite is a `throw` stub. The agent-memory daily log stores failure categories only, by design. | `packages/checkpointer/src/index.ts:11-13`, `packages/agent/src/memory-writer.ts:35-48` |

Stale comment to be aware of, not to fix in this work: `skill-learner-install.ts:36-39` says the production reader returns `appliedSkills: []`. `apps/web/src/lib/server/agent.ts:558-583` shows SIO-1018 closed that gap.

### 12.2 The gaps this port fills

| # | Gap | Why the existing mechanisms do not cover it |
|---|---|---|
| G1 | Create-from-failure | `skill-learner` only looks at successful, confident turns (`preGateSkip`). A failure class that recurs across turns with no skill covering it is exactly the turn it skips. The xskills create rule (section 5) is the complement. |
| G2 | Why a skill is weak, and what to change | `skill-outcome` yields one scalar per skill. It cannot say which step failed, cite a message, or name a line. xskills findings carry kind, class, evidence and a change hint. |
| G3 | Cross-run recurrence | Both existing mechanisms judge one turn at a time. Nothing groups the same gap across runs, so a one-off and a defect look the same. |
| G4 | Shortfall without error | A turn that validates and scores well but that the user re-asks, or scores low in feedback, counts as a `success` in `outcomeForTurn`. Cross-run retry detection and the feedback score fix this. |
| G5 | Checked, reversible skill edits | No find-exactly-once, check, revert, ledger path for SKILL.md edits, and no rule stopping an edit to a gate in the same change as the skill it grades. |

### 12.3 Decisions

**D1. Transcript source: LangSmith traces through `langsmith-fetch` (recommended).**

| Option | Verdict |
|---|---|
| O1. Adapter over `langsmith-fetch traces <dir> --include-metadata --include-feedback` output | Recommended. No runtime change. Traces include sub-agent tool calls and the `user-feedback` score. `langsmith-fetch` is installed at `~/.local/bin/langsmith-fetch`. It fits the adapter `run` stub pattern, so it is testable offline. |
| O2. Write a normalized session JSONL from the post-turn hook | Rejected for now. Needs a runtime change in a single-slot hook, a PII redaction decision for a new durable store, and it is unverified whether sub-agent tool messages reach the parent state's `messages`. |
| O3. Agent-memory daily log | Rejected. `toolFailures` holds categories only (SIO-1687), so there is no excerpt to cite and rule R2 cannot be met. |

Unverified, and the first thing to check: the JSON shape `langsmith-fetch` writes. Run it once and inspect before writing the adapter (step A1).

**D2. Skill attribution comes from `skillsApplied`, not from text matching.** Replace X1 and X4 with: `meta.skills` = the run's `skillsApplied`. Sub-agent runs are attributed to that sub-agent's declared skills. This removes the prefix regex entirely.

**D3. Failure detection uses the structured enums, not regexes.** Replace X2: a `tool_result` part is a failure when the ToolMessage `status` is `error`. Map the concept of `expected-exit` onto categories `not-found` and `no-data`, which `agent-state.ts:20-24` already describes as "a normal finding, not a malfunction". Keep `auth`, `session`, `transient`, `server-error` out of skill findings as well: they are environment failures, which `gap-taxonomy.md` lists under "not a gap". That leaves `bad-query` and `unknown` as the categories that can indict a skill.

**D4. Drop what has no target equivalent.** `prose-question`, `protocol`, `adherence`, `graphs`, `skill-script-silent`, `tool-rejected`, `interrupt`, `user-handedit`, run folders, and the twelve CLI adapters. The HIL interrupt flow may later supply a `tool-rejected` equivalent; not in this work.

**D5. `skill-unused` and `delete` are blocked on a usage signal.** `skillsApplied` records the skills that were active, not the ones the model followed. Without a "used" signal, `unused` is always empty. Do not port the delete rule until an application trace exists. `skill-outcome` counters are the nearest existing proxy.

**D6. Add one anchor the source does not have: `user-feedback-low`.** A `user-feedback` score below 0.5 is a stronger shortfall signal than any phrase regex. Severity `high`, owner = the run's applied skills. Keep `REDO_RE` and cross-run retry as secondary.

**D7. Place the code beside the existing CLIs.** `packages/agent/src/reflect/` with `*-cli.ts` entry points exposed as root scripts, matching `skill-promote-cli.ts`. Hand-rolled `process.argv` parsing, as the repo already does. Reports go to `experiments/reflect/<YYYY-MM-DD>-analysis.{json,md}`.

**D8. Heal targets are `agents/**/skills/**/SKILL.md`; checks are `bun run yaml:check` and the skill spec validator.** `SHARED_MEASURES` in the port lists `packages/agent/src/reflect/**`, `packages/agent/src/eval/**` and `packages/gitagent-bridge/src/skill-spec-validator.ts`.

### 12.4 Steps

Each step is independently testable. Stop after A4 and review the first real report before building A5-A6.

| Step | Work | Source to port | Done when |
|---|---|---|---|
| A1 | Fetch a sample: `langsmith-fetch traces $TMPDIR/traces --limit 20 --include-metadata --include-feedback`. Document the JSON shape at the top of `adapter-langsmith.ts`. Write `list` and `read` returning `RawSession` (section 2.1), with `skills` from `skillsApplied` and `headless: true` for eval runs. | `hosts/claude.mjs`, `hosts/shared.mjs:41-46, 182-203` | A fixture trace maps to a `RawSession` with the expected tool_call / tool_result pairing |
| A2 | `normalize.ts`: `normalizeSession` and `clip`, typed with the Zod schemas in section 2. Add a `status` field on `tool_result` parts. Pass excerpts through `redactPiiContent` from `@devops-agent/shared`. | `read-session.mjs:14-90` | Section 13 clip and shape checks pass |
| A3 | `scan.ts`: `scanSession` with detectors `tool-failure` (D3), `expected-outcome` (D3), `repeat-call`, `user-correction`, `user-reprompt`, `user-redo`, `user-handoff`, `user-feedback-low` (D6), `user-abandon`. Owner = applied skills (D2). | `scan-session.mjs:321-606`, `reactions.mjs:59-70, 111-113, 180-190, 238-300` | Section 13 owner and repeat checks pass |
| A4 | `aggregate.ts` + `anchors.ts` + `analyze-cli.ts` + `check-analysis.ts`. Import directly (X7). Root scripts `reflect:analyze`, `reflect:check`. | `analyze.mjs:20-224, 346-415`, `anchors.mjs:44-243`, `check-analysis.mjs:10-46` | `bun run reflect:analyze --hours 168` writes both files and `bun run reflect:check` exits 0 |
| A5 | Feed create candidates into the existing proposal path: a `create` portfolio item becomes a `kind:skill` proposal through `skill-learner`'s fact writer, tagged with its finding id, so promotion stays in `skill-promote-cli.ts`. | `skill-learner.ts:184-236` | A synthetic `create` item appears in `listSkillProposals()` |
| A6 | `heal.ts` + `check-heal.ts` + `heal-cli.ts` with D8 paths. Skip the check on dry run. | `heal.mjs:20-48, 143-223`, `check-heal.mjs:13-62` | Section 13 heal and gate checks pass |
| A7 | Optional. `classify-turns` using `createLlm` and `invokeWithDeadline`, behind an env flag, mirroring `judgeTurn`. Metrics `rework` and `conformance` plus `shortfallRates`. | `classify-turns.mjs`, `metrics.mjs:19-174, 361-406` | Only after A4 has produced reports worth ranking |

Also port `references/gap-taxonomy.md` and `references/quality-judge.md` as `docs/development/skill-reflection.md`, trimmed to the kinds and classes kept. They are the instructions for the judging step, which stays a human or agent reading task.

### 12.5 Files to create or modify

| File | Change |
|---|---|
| `packages/agent/src/reflect/schema.ts` | New. Zod schemas from section 2 |
| `packages/agent/src/reflect/adapter-langsmith.ts` | New. A1 |
| `packages/agent/src/reflect/normalize.ts` | New. A2 |
| `packages/agent/src/reflect/scan.ts` | New. A3 |
| `packages/agent/src/reflect/anchors.ts`, `aggregate.ts`, `check-analysis.ts`, `analyze-cli.ts` | New. A4 |
| `packages/agent/src/reflect/heal.ts`, `check-heal.ts`, `heal-cli.ts` | New. A6 |
| `packages/agent/src/reflect/*.test.ts` | New. Section 13 checks, `bun test` |
| `packages/agent/src/skill-learner.ts` | Modify. Export a fact-writer entry that accepts an externally built proposal (A5) |
| `package.json` (root) | Modify. Add `reflect:analyze`, `reflect:check`, `reflect:heal` scripts. Scripts only, no dependencies. Ask before changing. |
| `docs/development/skill-reflection.md` | New. Taxonomy and judging rules |

### 12.6 Second, independent use: development sessions

The repo also holds tooling skills under `.claude/skills/` and `.agents/skills/` that are exercised through Claude Code sessions, not through the app. The xskills scripts read those sessions unchanged with `--host claude --skills-dir .claude/skills`, provided the `x-` prefix in X1 is relaxed. That needs no port: run the xskills scripts from a checkout. It is out of scope for this ticket.

## 13. Verification

Source tests, for behaviour reference (run in xskills): `node --test test/x-autoreflection.test.cjs test/x-autoreflection-analysis.test.cjs test/x-autoreflection-heal.test.cjs test/x-autoreflection-anchors.test.cjs test/x-autoreflection-classify.test.cjs test/x-autoreflection-metrics.test.cjs`. 1,838 lines of cases; port the ones for the functions you keep. They were not run for this document.

Minimum checks for the port, each the smallest thing that fails if the logic breaks:

| Check | Input | Expected |
|---|---|---|
| Expected outcome (D3) | failed `tool_result` with category `no-data` / `bad-query` | `expected-outcome`, severity `low`, no finding / `tool-failure` |
| Clip | 2,000-char tool result, limit 600 | 360 head chars + `…` + 240 tail chars; text parts unclipped |
| Owner attribution (D2) | run with `skillsApplied: ["A"]`, later user turn "start over from scratch please now" | one `user-redo`, `suspects: ["A"]` |
| Repeat call | same tool name and identical input 3 times | one `repeat-call`, `count: 3`, severity `medium` |
| Feedback anchor (D6) | run with `user-feedback` score 0.2 | one `user-feedback-low`, severity `high` |
| Recurrence | same `(kind, skill)` signal in 3 synthetic scans | one finding, `recurrence: 3`, ranked above a `count: 10` single-session finding |
| Create rule | `tool-failure` with `suspects: []` in 2 scans | one portfolio item, `action: "create"` |
| Retry | two entries, same 12-word request, 1 hour apart | one retry, `earlier` is the older key |
| Heal exactly-once | `find` occurring 0 / 1 / 2 times | `stale` / `applied` / `ambiguous` |
| Heal revert | `check: "false"` | `reverted`, file bytes unchanged |
| Gate | `lintHeal` on a plan with an `auto` item of class `missing-expectation` | violation `auto-class` |

Commands in this repo, run after every step:

```bash
bun run typecheck
bun run lint
bun test packages/agent/src/reflect
```

End-to-end acceptance, after step A4:

```bash
bun run reflect:analyze --hours 168     # prints {"json": "...", "md": "...", "sessions": n, "findings": n, "portfolio": n}
bun run reflect:check                   # exit 0, "violations": []
```

The markdown must list at least the `Skills in use` table. A window with no sessions still writes a report that says so; `check-analysis` then fails with `no-evidence`, which is the correct result for an empty window.

## 14. Workflow

1. Create a Linear issue containing sections TL;DR, 12 and 13 of this document. No implementation before the issue exists.
2. Branch `feat/skill-autoreflection` off `main`. Linear status: In Progress.
3. Implement in the order given in section 12. Run typecheck, lint and tests after each step.
4. Open a PR. Linear status: In Review. Set Done only with explicit user approval.

```bash
git commit -F - <<'EOF'
feat(autoreflection): <step> -- <what it adds>

Ported from xskills@cded11d skills/x-autoreflection*.
<one line on what was adapted for this repo>
EOF
```

## 15. Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Phrase detectors (`REDO_RE`, `HANDOFF_RE`, `CORRECTION_RE`) are tuned to another user's sessions and misfire on target transcripts | High | Treat every anchor as a lead. Label a sample before letting any detector rank sessions (section 8.3). |
| Skill attribution is wrong because the target does not record which skill drove a step | High | Decide the skill-load signal (X4) first. Without it every quality anchor has no owner and every finding becomes a create candidate. |
| Low volume: findings with `recurrence: 1` get acted on | Medium | Enforce R3. Act only on recurrence >= 2; keep the sample floor of 5 for scores. |
| Transcripts contain secrets or customer data and get copied into reports | Medium | Excerpts are capped at 160 chars but not redacted. Keep exports in a temp dir, write only the report into the repo, and add redaction before excerpts if the store holds production data. |
| The heal `check` field runs through a shell | Medium | Only apply plans that were reviewed. Do not accept plans from untrusted input. |
| Dry-run reports `reverted` incorrectly | Certain in source | Skip the check when `dryRun` is true (section 9). |
| The loop optimises its own detectors | Low, severe | Port `measuresOf` and the `measure-and-measured` rule with the target's paths (R6). |
| The create rule misses gaps that never fail | Medium | Keep the daily audit pick and record `manual` gaps. `skill-learner` already covers the success side. |
| `langsmith-fetch` output shape differs from what the adapter assumes, or omits sub-agent tool runs | Medium | Step A1 inspects a real sample before any adapter code is written. The user's global CLAUDE.md notes that the single-trace command returns incomplete data; use the batch `traces` command. |
| A third consumer is registered on the post-turn hook and silently replaces the learner | Medium if O2 is ever chosen | `registerPostTurnLearner` is a single slot, last registration wins (`lifecycle.ts:105-107`). Extend `installSkillLearner` instead. Not needed for D1. |
| Two learning loops produce duplicate skill proposals | Medium | Route create candidates through the existing fact writer and its `skillProposalExists` dedup (step A5). |

## 16. Out of scope

- The report UI (`tools/report-app/`) and `derive.mjs` (movement, calendar, bands).
- The daily collector and `history.jsonl` / `labels.jsonl` persistence in `metrics.mjs:284-677`.
- The ten other host adapters (OpenCode, Codex, Gemini, Cursor, Cline, Roo, Kilo, Goose, Crush, Qwen, Copilot).
- `check-questions.mjs` and the panel rules in `references/questions.md`.
- Automatic creation, merging, splitting or deletion of skills.
- Routing proposals to other x-skills (`x-fix`, `x-plan`, `x-epic`, `x-investigate`).
- A local transcript store or a persistent checkpointer (option O2).
- An application trace that says which active skill the model actually followed (blocks D5).
- Changes to `skill-outcome.ts`, the `learn/*` HIL flow, or the eval suite.
- Reflection over Claude Code development sessions (section 12.6).
- Fixing the stale comment at `skill-learner-install.ts:36-39`.

## 17. Related code references (source repo, HEAD cded11d)

| File | Lines | What it is |
|---|---|---|
| `skills/x-autoreflection/SKILL.md` | 334 | Single-session procedure, gates table, reflection format, constraints |
| `skills/x-autoreflection/scripts/read-session.mjs` | 288 | Normaliser, clipping, host listing, `parseArgs` |
| `skills/x-autoreflection/scripts/scan-session.mjs` | 685 | Friction detectors, used/mentioned, skill self-checks, `scanSession` |
| `skills/x-autoreflection/scripts/reactions.mjs` | 300 | Quality anchors, owner timeline, injected-text filter |
| `skills/x-autoreflection/scripts/anchors.mjs` | 269 | Retries, reading order, weak-signal composite, hand-edits, audit pick |
| `skills/x-autoreflection/scripts/classify-turns.mjs` | 130 | Model rubric, prompt builder, answer parser |
| `skills/x-autoreflection/scripts/metrics.mjs` | 677 | Rates, weights, sample floor, shortfall rates, detector precision |
| `skills/x-autoreflection/scripts/hosts/shared.mjs` | 203 | Window rule, JSONL readers, Anthropic block mapping |
| `skills/x-autoreflection/scripts/hosts/claude.mjs` | 145 | Reference adapter |
| `skills/x-autoreflection/references/gap-taxonomy.md` | 104 | Signal kind to class map, severity meaning, what is not a gap |
| `skills/x-autoreflection/references/quality-judge.md` | 68 | The narrow question, codebook, two worked examples |
| `skills/x-autoreflection-analysis/SKILL.md` | 178 | Window procedure, artifact schema, derivation rules |
| `skills/x-autoreflection-analysis/scripts/analyze.mjs` | 584 | `aggregate`, class map, portfolio rules, markdown renderer |
| `skills/x-autoreflection-analysis/scripts/check-analysis.mjs` | 114 | Report gate |
| `skills/x-autoreflection-heal/SKILL.md` | 162 | Heal procedure, auto whitelist, constraints |
| `skills/x-autoreflection-heal/scripts/heal.mjs` | 341 | `mintPlan`, `applyItem`, `measuresOf`, ledger |
| `skills/x-autoreflection-heal/scripts/check-heal.mjs` | 130 | Plan gate, measure/measured separation |
| `test/x-autoreflection*.test.cjs` | 1,838 | Behavioural reference |

## 18. Memory references

None. The xskills project memory directory held no entries when this was written.

## 19. Verification addendum (2026-09-20, same day)

Sections 1-11 describe xskills and are unaffected. **Section 12 was written without reading `learn/*`, without
checking the LangSmith run shape, and on the assumption that `skillsApplied` identifies the skills a turn used.**
Three read-only passes over the target repo at HEAD `7dbcf5f7` settled those. Four decisions are wrong as written
(D1, D2, D7, D8), one is unproven (D6), and two steps need less work than the doc assumes (A5, A6).

Every `file:line` below was opened and confirmed. Where this section and section 12 disagree, **this section wins.**

### 19.1 Where the pipeline actually incorporates

| # | Integration point | Existing seam | What the pipeline adds |
|---|---|---|---|
| I1 | The missing "improve existing skill" arm | On a skill-name collision the learning is **skipped outright**: `packages/agent/src/learn/apply.ts:585-588` (`skillProposalExists` -> `report.skipped.push` -> `return false`), backed by `skill-learner.ts:139-144` and `skill-manifest.ts:42-46` (`{changed:false}`). No improve path exists anywhere in the repo. | A finding whose `skill` is set (section 5) is exactly this arm. Strongest fit in the repo. |
| I2 | Create-from-failure proposals (G1, step A5) | `skill-learner.ts` only judges successful turns (`preGateSkip`, `:79-86`). | A `create` portfolio item is written with the **already exported** `buildSkillFactText` (`:204`) and `buildSkillAnnotations` (`:184`, pass `learnedFrom: "finding:F<n>"`), plus `enqueueFact`, after `skillProposalExists`. Promotion stays in `skill-promote-cli.ts`. |
| I3 | The offline analyzer (A1-A4) | `packages/agent/src/reflect/` is free: nothing named reflect/reflection/autoreflection/retro/skill-audit exists. Siblings: `eval/spec-audit-cli.ts`, `skill-promote-cli.ts`. | Scripts belong in `packages/agent/package.json` (`bun --env-file=../../.env run src/reflect/...`), **not** the root as section 12.5 says: `skill:promote` lives at `packages/agent/package.json:13`, and root exposes it via `--filter`. |
| I4 | Failure detection (D3) | `ToolErrorSchema` (`packages/shared/src/agent-state.ts:121-151`) carries `toolName, category, kind, message`; the message is capped at 500 chars and already PII-redacted at `sub-agent.ts:924`. | **D3 stands unchanged.** Structured `category`, no regexes. `bad-query` and `unknown` can indict a skill; the rest are environment failures or normal findings. |

### 19.2 Corrections

| Item | What section 12 says | What the code shows | Correction |
|---|---|---|---|
| **D1** | Read traces via the `langsmith-fetch` CLI | No wrapper, dependency or script for that CLI exists anywhere; it appears only in prose. `langsmith@^0.6.3` **is** a direct dependency (`packages/agent/package.json:39`) and is already constructed as `new Client()` in `eval/run-incident-replay-eval.ts:29,100`. The repo deliberately moved off the CLI to the SDK before (`eval/build-mcp-tool-dataset.ts:8`, SIO-1378). | **Use the SDK.** `Client.listRuns({ isRoot: true, filter: 'eq(name,"agent.request")' })`. Turns are already named `agent.request` and tagged `thread:<id>` with `session_id` metadata (`apps/web/src/lib/server/langsmith-tags.ts:9-19`). |
| **D2** | Attribute every signal to `skillsApplied` | `getActiveSkillNames()` (`packages/agent/src/prompt-context.ts:206-212`) returns `[...getAgent().skills.keys()]`: **every skill declared in the root `agent.yaml`**, not a per-turn selection, and no sub-agent skills. `skillsApplied` also never reaches LangSmith metadata. | **Blocker, not a detail.** With this signal every signal blames every skill and no finding can name one. First iteration attributes to the sub-agent / datasource, which is recoverable from the trace. Per-skill attribution needs a new signal; decide after the probe (19.3). |
| **D6** | `user-feedback-low` anchor from the feedback score | The feedback `runId` is a UUID minted at `apps/web/src/routes/api/agent/stream/+server.ts:77` and passed as `configurable.run_id` (`apps/web/src/lib/server/agent.ts:351,384`), which is not the documented channel for the LangSmith root run id. The feedback route never checks the LangSmith response status. | **Unproven, and possibly a live bug.** If the two ids diverge, feedback is filed against a run LangSmith never created and cannot be joined. The probe settles it; D6 is blocked until it does. Raise a separate ticket if they diverge. |
| **D7** | Reports to `experiments/reflect/` | `experiments/` is **git-tracked** (145 tracked files; `git check-ignore` exits 1) and the repo is public. `redactPiiContent` deliberately preserves IPs, hostnames and account ids (SIO-861), so redaction is not a safety net for excerpts. | Excerpts must not land in a tracked path. Write to a gitignored directory, following the eval-fixture precedent at `.gitignore:69-72`. |
| **D8** | Check is `bun run yaml:check` plus the skill spec validator | `yaml:check` is `yamllint -c .yamllint.yml agents/` (`package.json:54`): it sees `agents/**.yaml` and **cannot read SKILL.md frontmatter at all**. The only build-time SKILL.md gate is `packages/gitagent-bridge/src/skill-spec-compliance.test.ts`. | The heal check calls `validateSkillFile(filePath, content)` (`skill-spec-validator.ts:92`) **in-process**. It is already a pure function returning all violations. This also removes the `shell: true` execution risk the doc flags in sections 9 and 15. |
| **A5** | Export a fact-writer entry from `skill-learner.ts` | No writer function exists; the write is one inlined `enqueueFact(buildSkillFactText(proposal), nowIso, buildSkillAnnotations(...))` at `skill-learner.ts:234`. Both builders are already exported, and `buildSkillAnnotations`' `learnedFrom` parameter exists precisely for an external caller (SIO-1127). | **No modification to `skill-learner.ts`.** Compose the three existing calls at the new call site. |
| **A6** | Heal edits SKILL.md in place, then checks and reverts | Every file-shaped learning output routes through a PR by design: "agent proposes, GitOps disposes" (`learn/apply.ts:608-618`). The only in-place SKILL.md writer is `skill-outcome.ts`, and it earns that by touching frontmatter counters only, behind `SKILL_OUTCOME_TRACKING_ENABLED`. | Heal emits edits through `promoteToMemory` / `fetchBaseFileContent`, so **the PR is the revert**. Keep find-exactly-once and the measure/measured rule (R6); drop the local write-check-revert loop and its ledger. Reuse `skillFilePath` (`paths.ts:60-62`), and `withPathLock` / the unchanged-check (`skill-outcome.ts:92-102,158`) if any in-place write survives. |
| **Section 7** | A `missing-expectation` fix lands in `skills/<x>/evals/expectations.json` | No `evals/expectations.json` and no per-skill eval or expectation convention exists in this repo. | Out of scope. `missing-expectation` fixes have nowhere to land until such a convention is introduced. |
| **Section 12.1** | `collectToolFailures` at `sub-agent.ts:862,965`; 35 skill files; `learn/match.ts` decides create-vs-improve | It is **defined** at `follow-up-generator.ts:76-89` and returns `string[]` of `<datasource>:<category>` tags, capped at 12, persisted only to the daily log. 37 `SKILL.md` files. `learn/match.ts` matches a **ticket to a stored KG incident**, not a learning to a skill. | Fix the references. The `collectToolFailures` finding **confirms** the O3 rejection: categories only, no excerpt, so rule R2 cannot be met from the daily log. |

Line drift, no consequence: `preGateSkip` `skill-learner.ts:79-86`; `learnFromTurn` `:214-236`; `lifecycle.ts:105-108`
(invoked `:306-315`); `readCompletedTurn` `apps/web/src/lib/server/agent.ts:511-556`; `readCompletedTurnOutcome`
`:565-591`; `state.ts:441-450`; `aggregator.ts:1661-1668`.

Confirmed as written: the post-turn hook receives only `{agentName, threadId}` (`lifecycle.ts:105-108`), which
supports the doc's rejection of O2. The checkpointer is memory-only with a sqlite `throw` stub. `learn/edits.ts` is a
whitelisted field patch over an in-memory proposal keyed by item id, **not** a text edit, so it offers nothing to reuse
for heal beyond its whitelist discipline.

### 19.3 Do this before writing any adapter code

A throwaway probe (scratchpad, not committed, no production code) using `new Client()` to read about five
`agent.request` root runs with their children. It answers five questions that decide the shape of A1-A3:

1. Do sub-agent `createReactAgent` runs appear as **named child runs** with a resolvable datasource, or as anonymous
   graph nodes? Decides whether tool calls can be attributed per datasource (the D2 fallback).
2. Do `ToolMessage` error texts **survive** in the trace, or are they truncated? `langsmith.ts`'s `trimLargeValues`
   replaces oversize fields with `[truncated: N bytes]`. Decides whether rule R2 (evidence or silence) is satisfiable.
3. Does `configurable.run_id` equal the actual root run id? **Settles D6** and a possible feedback bug.
4. Is any per-skill signal recoverable from child-run prompt content? **Settles D2.**
5. How many `agent.request` root runs exist in a 7-day window? Decides whether `recurrence >= 2` (rule R3) is
   reachable at all, and therefore whether this pipeline is worth building yet.

Then scope A1-A4 against the real shape, and stop after the first report as section 12.4 already advises. I2 and the
heal-via-PR arm (I1) come after that report proves the findings are worth acting on.

### 19.4 Side finding, not this work

`skill-outcome.ts:159` writes counters for **every** promoted skill on **every** aggregated turn, because
`appliedSkillsForNames` is fed the same all-skills list from `getActiveSkillNames()`. The attribution gap SIO-1018
set out to close is open in substance: the counters measure "was declared in the manifest", not "was used". Worth its
own ticket; it is also the same root cause as the D2 blocker above.
