---
name: no-index-diagnosis
description: Turn "no index available (N1QL 4000)" into a one-shot fix -- read _error.advice, discover the index key order, re-lead the WHERE, never leading-wildcard LIKE.
---

# Skill: No-Index Diagnosis

## When to use
A query fails with "No index available on keyspace ... (code 4000)" or a
tool result carries `_error.kind: "no-index"`.

## Procedure
1. Read `_error.advice` on the failed tool result -- it states the fix.
   Do NOT re-issue the same statement unchanged.
2. Discover the index key order: `capella_get_detailed_indexes` (or
   `capella_get_system_indexes`) for the keyspace; note the FIRST key field
   of each index.
3. Re-issue with the WHERE clause leading on that first key field, using a
   predicate taken from the original query or `_error.advice` (equality or
   range -- do NOT invent an equality that changes the result set). When the
   full document key is known, fetch by key instead
   (`USE KEYS` / `capella_get_document_by_id`).
4. If only a trailing key's value is known and no index leads on it, report
   "collection has no usable index for this predicate" as a finding -- it is
   NOT evidence of missing data (Soul "Querying collections").

## LIKE discipline (copy-paste)
A leading-wildcard LIKE cannot use a selective index range scan -- at best it
degrades to a broad or full index scan, and on a collection with no index
usable for the predicate it fails with code 4000:

```sql
-- Bad: leading wildcard, cannot use any index
SELECT META(d).id FROM myCollection d WHERE META(d).id LIKE "%0003307479%"
-- Good: prefix pattern, uses the index range scan
SELECT META(d).id FROM myCollection d WHERE META(d).id LIKE "ORDER::0003307479%" LIMIT 30
```

When the full document key is already known, skip LIKE entirely: use
`USE KEYS "ORDER::0003307479"` or `capella_get_document_by_id`.
