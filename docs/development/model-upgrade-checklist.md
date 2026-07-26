# Model Upgrade Checklist

Follow this before changing `model.preferred` or `model.fallback` in any `agents/**/agent.yaml`.

## Why this exists

SIO-1213 bumped two manifests (`incident-analyzer` to Sonnet 5, `elastic-iac` to Opus 4.8) and
**six production failures followed in a single day**:

| Ticket | Failure | The assumption that broke |
|---|---|---|
| SIO-1214 | Every sub-agent invocation failed; confidence 0.0, empty report | `temperature` is accepted by every model |
| SIO-1216 | `reasoningContent.reasoningText.text` must not be null | assistant turns carry no reasoning block |
| SIO-1217 | `[object Object]` in the streamed answer | `content` is a string |
| SIO-1218 | Streamed text garbled mid-word | a delta chunk holds one block |
| SIO-1219 | Runbook selection crashed | the model escapes control chars inside JSON strings |
| SIO-1220 | A 15-minute investigation returned nothing | per-call latency fits the existing wall-clock budget |

None was found by code review or unit tests. All were found by a human watching a live run.
SIO-1213's own acceptance-criteria smoke test was left unrun before merge — that is the gap
this checklist closes.

## The gates

Run them in order. Do not skip a gate because the model "looks like" the previous one — every
row in the table above was a model that looked like the previous one.

### 1. Probe the model and commit the report

```bash
bun run model:probe -- <model-name> --report
```

Costs roughly $0.50-2.00 and takes 3-5 minutes per model. It makes real Bedrock calls, so it
is deliberately **not** part of `bun test` — CI would otherwise bill Bedrock on every PR.

Commit the generated `docs/reference/model-probes/<model-name>.md`.

### 2. Declare the model's capabilities

```bash
bun run model:probe -- <model-name> --discover
```

Paste that output into `MODEL_REGISTRY`
(`packages/gitagent-bridge/src/model-registry.ts`). A model is not "known" to this codebase
until it has a complete capability record.

### 3. Typecheck

```bash
bun run typecheck
```

`MODEL_REGISTRY` is closed with `as const satisfies Record<string, ModelCapabilities>`, so a
missing or misspelled field is a compile error rather than a runtime surprise.

### 4. Test

```bash
bun run test
```

Three registry tests must pass: the temperature-generation oracle, manifest coverage across all
nine `agent.yaml` files, and probe-report provenance (you cannot declare a capability without
committing the probe that measured it).

### 5. Bump the manifest

Change `model.preferred` / `model.fallback` in `agents/<agent>/agent.yaml`.

### 6. Re-verify, including the fallback chain

```bash
bun run model:probe -- <model-name> --agent <agent> --verify
```

`--verify` exits non-zero on any mismatch against the declared record. `--agent` also probes the
manifest's **fallback** models. This matters: `elastic-iac` runs Opus 4.8 with a Sonnet 5
fallback, so both entries in that chain are new-generation and the fallback preserves every
assumption that broke. A fallback is not a safety net if it shares the failure mode.

### 7. Resolve any truncation advisory

The probe reports which roles' `maxTokens` sit below the measured long-form floor. Judge **per
role** whether its real output can be that long — the probe drives every budget with the same
full-report prompt, which over-states the need for a role that emits a compact JSON envelope.
Raise the budget or record why it is safe.

### 8. Run the acceptance eval

```bash
bun run eval:agent
```

This is the gate SIO-1213 skipped. Record the experiment prefix (`agent-eval-<sha>`) in the MR.

### 9. Exercise elastic-iac by hand, if its manifest changed

The elastic-iac graph has no token stream and its own 30-node pipeline, so the eval above does
not cover it. Drive one read-only `info` request and one `gitops` request through to plan
review. Link the run in the MR.

### 10. Link the evidence in the MR

The probe report path and the eval experiment id both go in the MR description. A reviewer
should block on either being absent.

## What the probe cannot tell you

Be honest about the limits, or the checklist becomes theatre:

- **P5 (control characters in JSON) is a stochastic detector, and a negative proves nothing.**
  SIO-1219 was a real production failure on Sonnet 5 that the probe does not reliably reproduce
  on demand. `parseLlmJson` therefore sanitizes unconditionally at all thirteen call sites
  (SIO-1221). A "not observed" result must never be used to justify removing the sanitizer.
- **P4 (reasoning blocks) is also stochastic.** Sonnet 5 returned reasoning blocks on 1/3 and
  then 2/3 of prompt shapes across two runs of the same probe. Treat "absent" as "not seen in
  this run", not "cannot happen".
- **The probe measures single calls, not a whole graph run.** It cannot tell you whether the
  900s graph budget still holds end to end; only a real investigation can (SIO-1220).
- **It does not measure answer quality.** That is what gate 8 is for.
