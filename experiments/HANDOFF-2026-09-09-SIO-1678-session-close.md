# HANDOFF 2026-09-09 (evening) -- session close: eu-oit-prd empty replies, model agreement, edge ingress reads, cost gate

**Date**: 2026-09-09
**Repo state**: `main` @ `689e225b` plus this docs commit; feature branches `sio-1678-spoke-empty-reply-error` (PR #721, head `676e7439`) and `sio-1679-edge-ingress-reads` (PR #722, head `826ade62`) pushed, both ready for review
**Linear**: [SIO-1678](https://linear.app/siobytes/issue/SIO-1678) In Progress, [SIO-1679](https://linear.app/siobytes/issue/SIO-1679) In Progress, [SIO-1680](https://linear.app/siobytes/issue/SIO-1680) Backlog (ships in #721), [SIO-1681](https://linear.app/siobytes/issue/SIO-1681) Backlog (follow-up), [SIO-1675](https://linear.app/siobytes/issue/SIO-1675) commented (trial clock restarts 16:00Z)
**Plan**: `~/.claude/plans/system-reminder-you-are-operating-luminous-adleman.md` (approved; all parts executed except merge and rollout)

## TL;DR

The eu-oit-prd spoke answered every hub prompt with an EMPTY `complete` reply within 200 ms from 13:45Z to 15:59Z. Root cause, two layers: (1) account 762715229080 had no Bedrock model AGREEMENT for Haiku 4.5 after the SIO-1675 swap, so every model call was a 403 `AccessDeniedException ... aws-marketplace:Subscribe`; (2) the pi-coms extension posted the failed run's empty assistant text as a completed reply, and every consumer read `complete` as answered. Production is recovered (agreement accepted 15:55Z, zero client errors since 16:00Z), the code fix is in PR #721, the IAM reads that the original Prana question needed are applied on all five spokes and in PR #722, and the spoke has answered the question.

**Update 16:40Z**: #721 merged as `950f61de`, #722 as `9adaf06c`; bundle `9adaf06c` published to both hub buckets and `pi-coms-update` run on all seven hosts (hub-prd, hub-dev, five spokes), all on `9adaf06c` with services active; all ten agents re-registered 16:36 to 16:38Z; probe to eu-oit-prd through the new code answered `ok` in 2 s. **Nothing is left.** CloudTrail check for the operator's question: no network-related write (WAF, IP sets, SG, CloudFront, API Gateway, ELB) happened in eu-oit-prd today; only the IAM policy version and the Bedrock model agreement.

## What was applied to production (UTC)

| When | Where | Action | Proof |
|---|---|---|---|
| 15:55 | eu-oit-prd (762715229080) | `aws bedrock create-foundation-model-agreement` for `anthropic.claude-haiku-4-5-20251001-v1:0` (user approved) | `agreementAvailability` PENDING -> AVAILABLE 15:57; probe reply 6065 chars at 16:01; CloudWatch 16:00Z bucket 13 invocations, 0 client errors |
| ~16:15 | all five spokes | `EdgeIngressReads` on `pi-coms-extensions` (plan-guarded, one in-place update each) | eu-oit-prd answered the Prana allowlist question in 76 s naming IP sets, rule groups, CloudFront and SG facts |

No instance was replaced. Suppressions were not touched. Every tunnel and process this session started is stopped (`lsof -nP -iTCP:8788 -sTCP:LISTEN` empty).

## The answer to the operator's question

IP allowlisting for Prana is not on the ALB rules. It is in WAFv2 IP sets: `oit-wafv2-reg-ipset-whitelist` (238 CIDRs, "PVH whitelist") referenced by Web ACL `oit-wafv2-reg` on `eu-oit-prd-alb` (alongside `Limit-Orders-Service-Access` with x-api-key rule groups), and `eu-oit-prd-wafv2-global-ipset-whitelist` (2 CIDRs) referenced by `eu-oit-prd-wafv2-global` on CloudFront distribution `d32qk1ogw4ao38.cloudfront.net`. No API Gateway API mentions Prana; the Prana ElastiCache SG isolates by SG pairing. (Spoke-authored data, reported on SIO-1679.)

## Diagnosis recipe that worked

1. Hub mailbox: `GET /v1/mailbox?name=<spoke>&project=pi-coms-prd&limit=100` over the SSM tunnel; look at `response` (`""` vs NULL) and `completed_at - created_at` (200 ms = no model turn).
2. CloudWatch `AWS/Bedrock` for the spoke's model id in the SPOKE account: `InvocationClientErrors == Invocations` means every call is rejected.
3. The provider message: SSM `AWS-RunShellScript` on the spoke host, newest `/home/piagent/.pi/agent/sessions/*/*.jsonl`, grep `"stopReason":"error"`.
4. `aws bedrock get-foundation-model-availability --model-id <foundation id>`: `agreementAvailability NOT_AVAILABLE` is the per-account agreement gap. Check this BEFORE any `pi_model` swap; eu-oit-dev is still NOT_AVAILABLE for Haiku 4.5.

## What is in PR #721

- `packages/pi-coms/extensions/turnReply.ts`: `finalAssistant()`, `turnFailure()` (error/aborted/length/deferred), `buildTurnReplies(inbounds, string|FinalAssistant)`, `claimTurnReplies(queue, turn, only?)`.
- `packages/pi-coms/extensions/coms-net.ts`: `agent_end` stashes `{final, ids}`; `agent_settled` claims synchronously and posts without holding the handler open.
- `packages/pi-coms/contracts/reply.ts` `isBlankReply` (runtime sibling of the types-only wire.ts); hub stores blank + no error as `status error, error empty_reply`; a blank error string counts as none.
- Console `fleet_await_reply`: empty complete -> "not answered"; hub error text fenced with `wrapUntrusted`; `empty_reply` rendered in words. Pane: empty line gated on `complete`. Monitor: `isBlankReply` guard.
- SIO-1680: `COST_DEFAULTS = { pct: 0, abs: 100 }` in `checks/cost.ts`, `envNumber` guard, `pct <= 0` off switch, zero-baseline summary; docs updated.

## Rollout after merge

`packages/pi-coms/deploy/publish-fleet.sh` from a checkout whose HEAD has the merge (`--stage-only` first, grep the staged `turnReply.ts` for `finalAssistant`), then `/usr/local/bin/pi-coms-update` per host over SSM (three prd hosts, two dev hosts, hub hosts), verify `.bundle-version`. Then send `Reply with exactly: ok` to a spoke and confirm the reply, and force one failure on eu-oit-dev (it still lacks the Haiku agreement, so swapping its model would reproduce the 403) to see `status: error` with the provider message.

## Traps hit today

- A `git stash -q` left inside a diagnostic command stashed the uncommitted extension change; the first #721 commit shipped without it. Never put `git stash` in a compound diagnostic command in a worktree; the second-pass review caught it.
- The user's 8788 tunnel dropped mid-session; `just hub-tunnel eu-shared-services-prd` from the MAIN checkout (it reads the gitignored fleet.yaml) brings it back; kill by the launcher PID.
- Bedrock: after the agreement turns AVAILABLE, calls still 403 for a few minutes ("try again after 5 minutes").
- The spoke session runs `thinkingLevel: medium` (Pi session header); Haiku therefore takes pi-ai's budget-thinking branch. It works; noted for the SIO-1675 cost comparison.

## Memory references

`reference_sio1678_bedrock_model_agreement_per_account_and_empty_replies`, `reference_sio1673_spoke_context_1m_window_and_early_reply_race`, `reference_sio1675_fleet_render_placeholder_token_and_model_swap`, `reference_sio1635_pi_coms_hub_client_gotchas`, `reference_greptile_skips_docs_only_prs`.
