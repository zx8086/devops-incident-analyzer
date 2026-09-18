# Session summary: couchbase read-only gate bypass (SIO-1813)

**Date:** 2026-09-18
**Repo state at end:** this session's work is `1716d43e` on `main`. Another session merged SIO-1814 (#845, `b8572e1c`) during close-out, so this document sits on top of that. Working tree clean apart from two untracked files that predate the session (`.mcp.json`, `packages/pi-coms/deploy/fleet.yaml.bak-sio1741`).
**Started from:** `bac18241`.

| Ticket | PR | Merged as | Status |
|---|---|---|---|
| [SIO-1813](https://linear.app/siobytes/issue/SIO-1813) | [#844](https://github.com/zx8086/devops-incident-analyzer/pull/844) | `1716d43e` | Done (auto-transitioned by the PR link, not set by hand) |

Two files changed, both in `packages/mcp-server-couchbase`: `src/lib/sqlppParser.ts` and `tests/queryAnalysis.test.ts`, +195 / -36.

## What the user asked for

A security fix. `sqlppParser.modifiesData()` and `modifiesStructure()` are the read-only boundary for the couchbase MCP server (`runSqlPlusPlusQuery.ts:46-67`; `server-v2.ts:36-37` says couchbase enforces read-only at the query-parser layer, not the shared chokepoint). They checked only the first token, and `tokenize()` split on the space character only, so `"DELETE\nFROM b"` produced a first token of `"DELETE\nFROM"` and passed the gate. The ask: fix it once in the shared function after grepping every caller, decide the other first-token evasions deliberately, and add one regression test next to the existing parser tests.

## What shipped

All in `sqlppParser.ts`, so the seven call sites (`runSqlPlusPlusQuery`, both `explainQuery` tools, both `runLiveOptimizationAnalysis`, `queryResource`, `v2/resources`) got it with no caller edits:

- `tokenize()` splits on any whitespace outside quotes and emits `;` as its own token.
- `removeComments()` replaces a comment with a space. This was a second hole found while reading the code: replacing with `""` turned `DELETE/**/FROM b` into `DELETEFROM b`.
- New `statementHeads()` feeds both gate functions: one leading keyword per `;`-separated statement, past opening parentheses, cut at the first non-letter so ``UPDATE`c` `` reads as `UPDATE`.
- Quoting follows the query service lexer: inside `"..."`, `'...'` and backtick identifiers alike, a backslash consumes the next character.

Evasion decisions, documented in the code comment on `statementHeads` and covered by tests:

| Case | Decision |
|---|---|
| Leading `(` | Stripped, then checked |
| Multiple statements separated by `;` | Every head is checked; `;` inside quotes is ignored. Defense in depth only, see below |
| `PREPARE` / `EXECUTE` | Refused wholesale. `EXECUTE` runs a server-side statement or UDF the gate cannot inspect, and `PREPARE` has no use without it |
| `EXPLAIN` / `ADVISE` of a mutation | Still allowed: they plan and never run. SIO-1107 depends on it |
| `BEGIN` / `COMMIT` / `ROLLBACK` / `SAVEPOINT` / `SET` | Still allowed: they mutate nothing, and each DML in a transaction is its own request through the gate |
| `BUILD`, `ANALYZE` | Added to the structure keywords |

Side effect of the same root cause: `hasLimit` was false for a multi-line `...\nLIMIT 5`, so `runSqlPlusPlusQuery` appended a second `LIMIT`. Fixed by the whitespace change and covered by a test.

## Defects found by review

Three Greptile rounds on #844: 3/5, 4/5, 5/5. Both findings were reproduced before anything was changed.

1. **Round 1 (P1), valid verdict, wrong premise.** The tokenizer treated any quote preceded by a backslash as escaped, so a closed quote could be read as still open and hide a following `; DELETE`. The real bug was the `\\` pair: in `'a\\'` the backslash is itself escaped and the quote closes. Greptile's stated premise, that backtick identifiers escape only by doubling, is wrong for the query service grammar.
2. **Round 2, valid, and caused by my round-1 fix.** Unable to confirm whether `\'` escapes a quote, I made the gate tokenize under both readings and refuse if either exposed a mutation. That refused a valid read-only query, `... WHERE note = 'it\'s; DELETE FROM c'`.

Settled from the `couchbase/query` source instead of a third guess:

- `parser/n1ql/n1ql.nex`: one quoting rule for all three quote kinds. A backslash consumes the next character, so `\'`, `\"` and backslash-backtick do not close the quote. Exempting backticks (my round-1 fix) left ``SELECT `a\`b` FROM c; DELETE FROM c`` unread.
- `parser/n1ql/n1ql.y`: `input: stmt_body opt_trailer`, with `opt_trailer` being only `;`. One statement per request, so a second statement is a server-side syntax error and the dual reading bought no security.

Final design is simpler than round 1: a single tokenizer reading that matches the lexer, no `backslashEscapes` parameter.

## Verification

- Original repro on merged main: `"DELETE\nFROM b"` and `"DELETE/**/FROM b"` return `true`; `"SELECT * FROM b"` returns `false`.
- SIO-1813 test block: 134 tests, all pass. It was run against the unfixed parser first: the evasion cases failed and the legitimate-query guards passed.
- `cd packages/mcp-server-couchbase && bun run test`: 380 pass, 1 fail locally. The one failure is `docsWrite.test.ts` writing to `/tmp/docs`, blocked by the local command sandbox (`EPERM`); it passes outside the sandbox and passes in CI (381 pass, 0 fail).
- `bun run typecheck` in the package: clean. `biome check` on both changed files: clean. CI `Lint` passed on every commit.
- Merge gate on `a5748b7c`: `Greptile Review` `COMPLETED SUCCESS`, footer SHA equal to the PR head, 2 of 2 threads resolved, all seven checks green, `MERGEABLE` / `CLEAN`.

Not verified against a live cluster. The gate is pure string logic exercised directly by the tests. A write-shaped probe was deliberately not sent to Capella: had the gate failed, that probe would have been a real write.

## Mistakes worth remembering

- **I designed around an unverified assumption twice.** Round 1 accepted Greptile's premise about backtick escaping; my own addition guessed at `\'` and hedged by reading it both ways. The grammar files were one `curl` away the whole time. When the question is "how does the server lex this", read the lexer.
- **"Fail closed" is not free and is not automatically safer.** The dual reading produced a false positive and closed no real hole, because the one-statement-per-request rule already made a hidden `; DELETE` unexecutable. Establish whether the threat is live before paying for a defense.
- **A reviewer's verdict and its reasoning come apart.** Round 1 was right that there was a bug and wrong about why. Fixing the stated reason instead of the reproduced behaviour is what introduced the round-2 defect.
- **A loose log grep wasted a round.** The first pass over the failed CI log matched `error` inside passing test names. The useful anchors are `Exited with code [1-9]` to find the package, then `(fail)` lines versus `N error`.

## Still open

Nothing asked for is unfinished. One recommendation, not started: comment stripping is still not quote-aware, and a keyword denylist fails open on any statement keyword it does not list. The Couchbase SDK has a server-side read-only query option that would cover both if passed at the query execution sites. It needs its own ticket and a test against a live cluster.

## Memory written

- `reference_n1ql_lexer_quoting_and_one_statement` -- the two grammar facts with source URLs, and the rule to fetch them instead of reasoning about escapes from memory.
- `reference_ci_agent_unhandled_error_between_tests_flake` -- how to recognise the CI flake below.

## Environment notes

- The CI `Test` check failed once on `a5748b7c` in `@devops-agent/agent`: 4710 pass, 0 fail, 1 error, `# Unhandled error between tests` / `TypeError: undefined is not an object (evaluating 'this.delete')` at `node:diagnostics_channel:19:9`. That is inside Bun's runtime. The PR could not reach that package (its only couchbase reference is a comment at `aggregator.ts:1483`), the same check had passed on the two earlier commits, and `gh run rerun 35373837371 --failed` went green.
- The local command sandbox blocks SSH and `/tmp` writes. `git fetch`, `git push` and `gh` needed to run outside it, and `$TMPDIR` differs between sandboxed and unsandboxed commands, so a file written by one is not visible to the other at the same variable.
- Root `bun run lint` exits 1 on this checkout because of local untracked files (`.mcp.json`, `graft/.cache/*`) and findings in other packages. CI lint is green, so it is a property of the checkout, not of main.
- The `mcp-server-couchbase`, `mcp-server-kafka`, `mcp-server-konnect` and `mcp-server-fallow` MCP connections failed at session start. None were needed.
- No servers, proxies or watchers were started this session, so there were no listeners to kill.
- The local branch `sio-1813-sqlpp-gate-whitespace` still exists; the remote branch was removed on merge.
