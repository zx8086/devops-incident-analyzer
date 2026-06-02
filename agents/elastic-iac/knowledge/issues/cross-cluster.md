# Issues — cross-cluster

Source: Consolidated_Issue_Register_v21 (live-reconciled 2026-05-31). 8 entries.

- **IR-163** — No agent upgrade cadence; no integration package quarterly review
  - Severity: P3 · Status: OPEN — establish quarterly upgrade cycle.
  - Evidence: Not cluster-verifiable — needs Fleet/Kibana/billing/app-team
- **IR-164** — Retention stepdown requires stakeholder sign-off which is not formalised
  - Severity: Medium · Status: OPEN — formalise approval + verification steps.
  - Evidence: Not cluster-verifiable — needs Fleet/Kibana/billing/app-team
- **IR-165** — APM-bundled ILM policies (logs-apm.app, logs-apm.error, metrics-apm.app_metrics, traces-apm.traces) may auto-revert via Fleet package updates E
  - Severity: edium M · Status: ONITOR — verify versions post-Fleet updates.
  - Evidence: Not cluster-verifiable — needs Fleet/Kibana/billing/app-team
- **IR-166** — Built-in ILM policies (metrics, logs, synthetics + @lifecycle) default to hot-only; auto-recreate on ES upgrades overwriting custom configurations E
  - Severity: 2 P · Status: CORRECTED (state differs from doc)
  - Evidence: On gl-cld-reporting, ilm_get_lifecycle confirms logs policy (version 2, modified 2026-04-13) IS NOT hot-only - it has 4 phases (hot/warm/frozen/delete, 180d retention). Same for metrics (version 2, modified 2026-04-13, 4-phase 180d). So the 'built-in policy defaulting to hot-only' has been customised at least on this cluster and persists post-9.4.x upgrade. The procedural risk (next ES upgrade may revert) remains valid as an ongoing watch item but the current state is not hot-only.
- **IR-168** — Federation Tier-1 rollout coordination required for: (1) mapping field optimisation (4.7M cluster-wide fields, 1.2M deduplicated); (2) ingest pipeline cleanup (37%/69% grok/lowercase failu
  - Severity: db overrid · Status: es) to ap-cld and us-cld Federation-wide changes risk cluster drift if applied piecemeal; eu-cld is the leader on the May 2026 round P2 PLANNED — multi-cluster session(s) covering eu-cld → ap-cld → us-cld with shared playbook v4 (5 May 2026) as runbook. Tier-1 levers represent more aggregate upside than the eu-cld-only Phase 2A work. Estimated multiplier: ~3x on shard reduction, master heap, ingest CPU.
  - Evidence: Not cluster-verifiable — needs Fleet/Kibana/billing/app-team
- **IR-169** — AutoOps event lifecycle as canonical ‘is the work done’ signal not formally adopted; events stay open silently while underlying state recovers; no cadence for verifying expected closure wi
  - Severity:  · Status: Operational pattern not previously codified P3 PROCEDURAL — adopt AutoOps event status as the closure signal for cluster-shape work (playbook §8.6). Document expected closure window in the change register at the time of fix application; escalate if closure window exceeded by >50%.
  - Evidence: Not cluster-verifiable — needs Fleet/Kibana/billing/app-team
- **IR-170** — Session-handover documents observed to diverge from live cluster state during April (eu-cld Citrix agent count, ap-cld MuleSoft orphan count); risks downstream planning on stale numbers
  - Severity: P3 · Status: PROCEDURAL — from 22 April, every session begins with a live-verification step (spot-check 3–5 headline numbers against the cluster before referring to prior handovers). Playbook §8 updated.
  - Evidence: Not cluster-verifiable — needs Fleet/Kibana/billing/app-team
- **IR-174** — Pre-resize / pre-change validation gate based on cluster_health alone is insufficient. eu-b2b had cluster_health=green while data_cold parent breaker tripped 2,034 times on instance-0000000122. us-cld plan #229 was greenlit by 'cluster healthy' signals but failed because per-zone disk-fit was never measured against the new instance size.
  - Severity: P2 · Status: RESOLVED 9 May 2026 — New pre-resize gate adopted for the playbook. Five conditions, all required, before any plan submission: (a) cluster_health.status = green; (b) breaker.tripped counts on every node in the affected tier = 0, or clearly trending toward 0; (c) old-gen peak / max < 90% per node in the affected tier; (d) thread_pool queue and rejected counts within historical norms; (e) per-zone disk-used + 20% buffer < new per-zone disk capacity. Failed plans must not be Reapply'd until the failure mode is identified and the gate is rechecked. Codify into the optimisation playbook in the next playbook revision.
  - Evidence: Not cluster-verifiable — needs Fleet/Kibana/billing/app-team

_Regenerated 2026-06-01 via python-docx + Sev/Status repair pass._
