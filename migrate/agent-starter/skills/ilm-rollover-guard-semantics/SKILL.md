---
name: ilm-rollover-guard-semantics
description: ILM rollover guard semantics --- do not use min\_\* on shared policies
inputs:
  cluster: { type: string, required: true }
outputs:
  status: { type: string }
---

# Sub-procedure: ILM rollover guard semantics --- do not use min\_\* on shared policies

> Source: Elastic_Optimisation_Playbook_v12 §3.12

------------------------------------------------------------------------------------------

min_* rollover conditions (min_primary_shard_docs,
min_primary_shard_size, min_age, min_size, min_docs) are guards:
rollover triggers only when ALL min_* are met AND any max_* is met.
If a sparse stream never reaches the min_* threshold, the index never
rolls over --- regardless of max_age.

Concrete failure case (eu-cld, 5 May 2026): a kubernetes.state_cronjob
stream in eu_dtc_dev accumulated 7 docs across multiple days. With
min_primary_shard_docs: 1000000 set, the index would have stayed in
hot phase indefinitely, never moving to warm/cold/frozen, never reaching
the delete phase.

-   Symptom to watch for: GET _ilm/explain/\<index\> shows step:
    check-rollover-ready past the policy's max_age.

-   Verification: GET \<index\>/_ilm/explain and check the index has
    been hot longer than max_age while below the min_* threshold.

-   Rule: if the policy is shared across many streams of differing
    volume, do not use min_*. Rely on max_age +
    max_primary_shard_size only.

-   Acceptable use of min_*: dedicated single-stream policies where
    the stream's volume is bounded and known.
