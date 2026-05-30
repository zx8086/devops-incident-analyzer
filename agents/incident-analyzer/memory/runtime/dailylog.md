# Daily Log

Append-only chronological breadcrumb of completed investigations. One line per
finished run (request id, services, datasources, severity, confidence). This is
an audit trail, not learned knowledge, so it is written directly (not PR-gated)
but always PII-redacted. When `LIVE_MEMORY_IMMUTABLE` is set, entries are
hash-chained JSON for tamper-evidence.

<!-- Entries are appended below this line. -->
