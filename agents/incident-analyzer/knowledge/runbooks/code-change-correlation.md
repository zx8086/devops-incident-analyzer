# Code Change Correlation

## Symptoms
- Incident timing correlates with a recent deployment
- Stack traces or error messages reference specific classes, methods, or file paths
- New error patterns appear that were not present before a recent merge
- Performance degradation after a CI/CD pipeline completed

## Investigation Steps

### 1. Extract Search Anchors from Logs
Before querying GitLab, extract searchable symbols from Elasticsearch logs and error messages:
- Exception class names (e.g. `NullPointerException`, `TimeoutException`)
- Method names from stack traces (e.g. `fetchOpenWindows`, `processDeliveryDates`)
- Endpoint or route paths (e.g. `/api/v1/delivery-dates`)
- Kafka topic names or Couchbase query references from error context

### 2. Semantic Code Search for Root Cause
Use `gitlab_semantic_code_search` with extracted symbols to find relevant source code by meaning, not just exact text. This finds code even when log messages don't match function names exactly.

Examples:
- Log shows `SettlementWindowRepository.fetchOpenWindows timeout` -> search "settlement window fetch open windows timeout"
- Log shows `DeliveryDateConsumer failed to process event` -> search "delivery date consumer event processing"
- Log shows `connection refused on port 5432` -> search "database connection configuration"

Semantic search returns scored results. Focus on scores above 0.75.

### 3. Trace the Call Chain
When semantic search identifies an exception handler or error handler:
- Use `gitlab_get_file_content` to read the full source file
- Use `gitlab_get_blame` to identify who last modified the relevant lines
- Look for callers of the failing method by searching for method name references

### 4. Identify Recent Code Changes
Use `gitlab_list_commits` filtered to the deployment time window (from Elasticsearch log timestamps):
- Filter by `since` and `until` matching the incident onset
- Filter by `path` if you know the affected file from step 2

### 5. Examine the Deployment Merge Request
If recent commits point to a merge request:
- Use `gitlab_get_merge_request` to get the MR details, description, and approvers
- Use `gitlab_get_merge_request_diffs` to see exactly what code changed
- Use `gitlab_get_merge_request_pipelines` to verify the CI/CD pipeline passed

### 6. Check Commit Diffs for Suspect Changes
Use `gitlab_get_commit_diff` for commits that touch files identified in steps 2-4. Look for:
- Changed error handling (removed try/catch, changed exception types)
- Modified timeouts or connection settings
- New dependencies or API call patterns
- Configuration changes (environment variables, feature flags)

### 7. Identify the Affected Project
If the incident references a service name but not a GitLab project, use `gitlab_search` with scope `projects` to find the matching repository. Search by service name, namespace, or keyword.

### 8. Browse Repository Structure
Use `gitlab_get_repository_tree` to understand the project layout when navigating unfamiliar codebases. This helps locate configuration files, test directories, and related modules.

## Cross-Datasource Correlation
- Elasticsearch error timestamp + GitLab commit timestamp = deployment-caused regression
- Kafka consumer lag spike + GitLab MR merged = consumer code change caused processing failure
- Couchbase slow queries + GitLab commit touching query code = query regression
- Kong gateway 5xx + GitLab pipeline deployment = upstream service deployment failure
- Error class in logs + GitLab blame shows recent author = direct author for escalation

## Escalation Criteria
- Code change clearly caused regression: tag MR author and reviewers
- Multiple services affected by same deployment: escalate to release manager
- Rollback candidate identified: requires human approval before proceeding

## All Tools Used Are Read-Only
gitlab_semantic_code_search, gitlab_get_file_content, gitlab_get_blame, gitlab_list_commits, gitlab_get_commit_diff, gitlab_get_merge_request, gitlab_get_merge_request_diffs, gitlab_get_merge_request_pipelines, gitlab_get_repository_tree, gitlab_search
