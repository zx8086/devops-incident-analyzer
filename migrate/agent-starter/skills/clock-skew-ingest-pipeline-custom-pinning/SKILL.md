---
name: clock-skew-ingest-pipeline-custom-pinning
description: Clock-skew ingest pipeline (\@custom) pinning
inputs:
  cluster: { type: string, required: true }
outputs:
  status: { type: string }
---

# Sub-procedure: Clock-skew ingest pipeline (\@custom) pinning

> Source: Elastic_Optimisation_Playbook_v12 §4.5

----------------------------------------------------------------

Symptom: agents on hosts with skewed clocks produce documents with
\@timestamp in the future, which breaks time-based dashboards and can
push docs into the next index generation. Observed across Windows hosts
in ap-cld where NTP drift was not corrected at the OS level.

Pattern: intercept in the integration's \@custom ingest pipeline, not in
a global pipeline --- \@custom pipelines are guaranteed to be invoked by
every integration and survive package upgrades.

    PUT _ingest/pipeline/logs-system-@custom
    {
    "processors": [
    {
    "script": {
    "source": """
    long now = new Date().getTime();
    long ts =
    ZonedDateTime.parse(ctx['@timestamp']).toInstant().toEpochMilli();
    if (ts - now > 300000) { // >5 min in the future
    ctx['event.ingested'] =
    ZonedDateTime.now(ZoneOffset.UTC).toString();
    ctx['event.original_ts'] = ctx['@timestamp'];
    ctx['@timestamp'] = ctx['event.ingested'];
    ctx['tags'] = (ctx['tags'] ?: []);
    ctx['tags'].add('clock-skew-corrected');
    }
    """
    }
    }
    ]
    }

-   Pin via component template so \@custom survives Fleet package
    upgrades:

```{=html}
<!-- -->
```
    PUT _component_template/logs-system@custom
    { "template": { "settings": { "index.default_pipeline":
    "logs-system-@custom" } } }

-   Repeat per integration (metrics-system\@custom,
    logs-windows\@custom, etc.) --- Fleet integrations each have their
    own \@custom pipeline name.

-   Monitor tags:clock-skew-corrected to find hosts that need OS-level
    NTP fixes; this is a diagnostic, not a permanent substitute for NTP.
