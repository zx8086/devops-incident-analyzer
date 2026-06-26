# SIO-1013: PERMISSION_DENIAL_RE regex widening + new tests

## Summary

Two changes applied to `packages/agent/src/aggregator.ts` and `packages/agent/src/aggregator-grounding.test.ts` to catch AWS IAM denial phrasings that the previous regex missed.

## TDD Red Phase (tests added first, confirmed failing)

```
bun test v1.3.14 (0d9b296a)

(fail) detectUngroundedBlockers > flags a single ungrounded bullet using 'not authorized' phrasing [2.10ms]
error: expect(received).toHaveLength(expected)
Expected length: 1
Received length: 0

(fail) detectUngroundedBlockers > flags an 'unauthorized' denial bullet when no auth error observed [0.12ms]
error: expect(received).toHaveLength(expected)
Expected length: 1
Received length: 0

7 pass
2 fail
```

Both new tests correctly failed against the old regex, proving the gap.

## TDD Green Phase (regex widened, all tests pass)

Regex change in `packages/agent/src/aggregator.ts` line 279-280:

Before:
```ts
const PERMISSION_DENIAL_RE =
    /\b(not permitted|access denied|accessdenied|forbidden|iam permission|permission (?:gap|denied|missing)|lacks? permission)\b/i;
```

After:
```ts
const PERMISSION_DENIAL_RE =
    /\b(not permitted|not authorized|unauthorized|access denied|accessdenied|forbidden|iam permission|permission (?:gap|denied|missing)|lacks? permission)\b/i;
```

## Full Test Suite Result

```
bun test v1.3.14 (0d9b296a)
 53 pass
 0 fail
 121 expect() calls
Ran 53 tests across 3 files. [1069.00ms]
```

Files: `aggregator-grounding.test.ts`, `aggregator-grounding-integration.test.ts`, `aggregator.test.ts`.

## Typecheck Result

```
@devops-agent/agent typecheck: Exited with code 0
@devops-agent/web typecheck: 0 ERRORS 0 WARNINGS
All packages: Exited with code 0
```

## Scoped Biome Lint Result

```
Checked 2 files in 37ms. No fixes applied.
```

Files checked: `aggregator.ts`, `aggregator-grounding.test.ts`.

## Commit SHA

(populated after commit)
