# elastic_cloud_get_deployment returned "deployment not found"

Tags: elastic_cloud_get_deployment, deployment not found, cluster name

A request named a cluster like "b2b" or "eu b2b prod" and `elastic_cloud_get_deployment`
returned no match. The repo's `environments/<cluster>/` directory naming and this server's
deployment names are not always identical strings -- "eu b2b prod" in a request can be the
`eu-b2b` deployment. Do not report the deployment as missing after one literal-name call.

Recover by calling `elastic_cloud_list_deployments` first (no name filter) and matching the
request's wording against the returned deployment names loosely -- ignoring casing, spaces
vs hyphens, and an "-prod"/"prod" suffix the request may have added or dropped. Retry
`elastic_cloud_get_deployment` with the matched name. Only report the deployment as absent
after the list call itself confirms no plausible match exists.
