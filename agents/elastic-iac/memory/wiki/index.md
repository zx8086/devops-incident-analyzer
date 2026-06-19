# Wiki Index

Compiled knowledge for the elastic-iac change agent. Each page distills one or
more raw sources from `knowledge/` into cross-referenced prose the agent can
inline at bootstrap. Consult this index before re-deriving cluster topology,
repo layout, or workflow rules. Raw detail and live state stay in `knowledge/`
and `memory/runtime/`; this wiki is the durable, stable distillation.

- [[cluster-topology]] -- the live cluster set, what each is for, and the standing gotchas per cluster
- [[iac-repo-layout]] -- the two-tree repo (`environments/` edit surface vs `stacks/` Terraform) and how an edit reaches a plan
- [[maker-checker-workflow]] -- the segregation-of-duties pipeline: pre-check on gl-testing, one MR per wave, never apply or self-merge
