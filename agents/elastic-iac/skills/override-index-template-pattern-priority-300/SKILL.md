---
name: override-index-template-pattern-priority-300
description: Override index template pattern (priority 300)
inputs:
  cluster: { type: string, required: true }
outputs:
  status: { type: string }
---

# Sub-procedure: Override index template pattern (priority 300)

> Source: Elastic_Optimisation_Playbook_v12 §3.14

------------------------------------------------------------------

When the goal is to add a setting (e.g. index.mode: logsdb,
index.mapping.source.mode: synthetic) without modifying a Fleet-managed
integration template, create a higher-priority override that composes in
the same components.

    PUT _index_template/logs-kubernetes.container_logs-logsdb
    {
      "index_patterns": ["logs-kubernetes.container_logs-*"],
      "priority": 300,
      "composed_of": [
        "logs@mappings",
        "logs@settings",
        "logs-kubernetes.container_logs@package",
        "logs@custom",
        "kubernetes@custom",
        "logs-kubernetes.container_logs@custom",
        "ecs@mappings",
        ".fleet_globals-1",
        ".fleet_agent_id_verification-1"
      ],
      "ignore_missing_component_templates": [
        "logs@custom",
        "kubernetes@custom",
        "logs-kubernetes.container_logs@custom"
      ],
      "template": {
        "settings": {
          "index": { "mode": "logsdb" }
        }
      },
      "data_stream": { "hidden": false, "allow_custom_routing": false }
    }

-   Priority 300 wins over the integration's priority-200 template.

-   composed_of mirrors the integration's composition, so package
    mappings/processors continue to apply.

-   ignore_missing_component_templates keeps the override resilient
    to optional \@custom hooks not yet defined.

-   Reversal: DELETE _index_template/\<override-name\>. The
    integration's template applies again on next rollover.

-   Use this whenever _component_template access is restricted
    (e.g. through limited tooling) and \@custom cannot be PUT directly.
