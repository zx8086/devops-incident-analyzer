# In-flight changes are part of current repository evidence

Tags: merge request, freshness, duplicate prevention

User: Create an account entry, but first account for any open aws-lz-account-creator merge request for this application.

Expected behaviour:

Route to `aws-lz-account-creator`. Query the default branch and open merge requests, then compare the proposed application, environments, owners, and paths with both active files and in-flight diffs.

Stop on duplicate or conflicting ownership. Do not treat a clean local checkout as proof that no change is in flight.
