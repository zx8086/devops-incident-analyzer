# 2. Platform baseline

Source: Elastic_Optimisation_Playbook_v12 §2 (reference content).

## §2.1 Cluster footprint

---------------------

  **Cluster**        **Role**                            **Stack**   **Hot/Warm/Cold/Frozen**   **Monthly spend**   **Status**
  ------------------ ----------------------------------- ----------- -------------------------- ------------------- -------------------------------------------------------------------
  eu-cld             Primary EU observability & logs     ES 9.2.3    8 / 12 / 4 / 3             \~€34,800           Cold tier under active management; I3 downsize planned w/o 28 Apr
  us-cld             US observability & logs             ES 9.2.3    6 / 10 / 3 / 2             \~€22,400           Stable post-downsize
  eu-b2b             EDI & B2B integration telemetry     ES 9.2.2    4 / 6 / 2 / 1              \~€14,100           Path B complete; 4-tier uniform
  ap-cld             APAC observability & network logs   ES 9.1.5    3 / 4 / 2 / 1              \~€9,800            Stable; ap-network-logs dedicated ILM split in progress
  gl-cld-reporting   Global reporting data mart          ES 9.0.4    2 / 3 / 2 / 0              \~€6,200            Stable; no frozen tier

## §2.2 Standard data-tier roles

----------------------------

Every cluster follows the same four-tier architecture. Exact thresholds
live in individual ILM policies (Section 3).

  **Tier**   **Role**                            **Typical hardware**         **Primary workload**
  ---------- ----------------------------------- ---------------------------- -------------------------------------------------
  Hot        Active writes, recent search        NVMe SSD, high CPU           Last 0--3d of data, real-time ingest
  Warm       Ageing, occasional search           SSD, moderate CPU            3--10d old; shard consolidation happens here
  Cold       Rare search, compliance retention   HDD + searchable snapshots   10--90d; mounted from snapshots, not on-cluster
  Frozen     Archival, regulatory                HDD + partial cache          90d--retention end; cache miss tolerated

## §2.3 Cost model primer

---------------------

-   Hot-tier GB costs roughly 4--6× cold-tier GB (SSD, CPU reservation,
    higher RF).

-   Warm is \~2--3× cold; frozen is the cheapest (searchable snapshot,
    partial cache).

-   Shards themselves carry overhead: each open shard is \~100--200 MB
    of heap even when empty. Shard count reduction is a real cost lever.

-   Ingest pipelines and enrich processors consume coordinating-node CPU
    --- visible as rising search latency, not ingest latency.

