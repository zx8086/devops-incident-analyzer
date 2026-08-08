# Version-drift comparisons need three reads, not one

Tags: version, upgrade, drift, query_structure

A question like "is eu-b2b on the version the repo says it should be" is not answered by a
single read. Per RULES.md, comparing versions requires the LIVE deployment version, the
REPO file's declared version, and (if given) the REQUESTED target -- reading only one or two
of these produces a confident-sounding but wrong answer, because the repo file and the live
cluster can already disagree before any requested change is considered.

Structure it as: `elastic_cloud_get_deployment` for the live version, `gitlab_get_file_content`
on the relevant `environments/<cluster>/` version file for the repo's declared value, then
compare both against any explicitly requested target. If live and repo already disagree
before you factor in a request, say so explicitly rather than silently picking one as
authoritative.
