/* src/tools/queryAnalysis/analysisQueries.ts */

/**
 * Collection of N1QL queries for system analysis
 */
export const n1qlQueryFatalRequests: string = `
    WITH fatal_requests AS (
    SELECT
        requestId,
        resultSize,
        statement,
        phaseTimes,
        errors,
        requestTime,
        userAgent,
        users
    FROM system:completed_requests
    WHERE state = "fatal"
        AND requestTime >= DATE_ADD_STR(NOW_STR(), -8, 'week')
        AND UPPER(statement) NOT LIKE 'INFER %'
        AND UPPER(statement) NOT LIKE 'CREATE INDEX%'
        AND UPPER(statement) NOT LIKE '% SYSTEM:%'
    ), 
    total_error_count AS (
    SELECT COUNT(*) AS totalErrorCount FROM fatal_requests
    )
    SELECT
        requestId,
        resultSize,
        statement,
        phaseTimes,
        errors,
        requestTime,
        userAgent,
        users
    FROM fatal_requests
    UNION ALL
    SELECT
        totalErrorCount
    FROM total_error_count
    ORDER BY requestTime DESC;
`;

export const n1qlLongestRunningQueries: string = `
SELECT statement,
    DURATION_TO_STR(avgServiceTime) AS avgServiceTime,
    MAX(requestTime) AS lastExecutionTime,
    COUNT(1) AS queries
FROM system:completed_requests
WHERE UPPER(statement) NOT LIKE 'INFER %'
    AND UPPER(statement) NOT LIKE 'CREATE INDEX%'
    AND UPPER(statement) NOT LIKE '% SYSTEM:%'
GROUP BY statement
LETTING avgServiceTime = AVG(STR_TO_DURATION(serviceTime))
ORDER BY avgServiceTime DESC;
`;

export const n1qlMostFrequentQueries: string = `
SELECT statement,
    COUNT(1) AS queries
FROM system:completed_requests
WHERE UPPER(statement) NOT LIKE 'INFER %'
    AND UPPER(statement) NOT LIKE 'CREATE INDEX%'
    AND UPPER(statement) NOT LIKE 'CREATE PRIMARY INDEX%'
    AND UPPER(statement) NOT LIKE 'EXPLAIN %'
    AND UPPER(statement) NOT LIKE 'ADVISE %'
    AND UPPER(statement) NOT LIKE '% SYSTEM:%'
GROUP BY statement
LETTING queries = COUNT(1)
ORDER BY queries DESC;
`;

export const n1qlLargestResultSizeQueries: string = `
SELECT statement,
    (avgResultSize) AS avgResultSizeBytes,
    (avgResultSize / 1000) AS avgResultSizeKB,
    (avgResultSize / 1000 / 1000) AS avgResultSizeMB,
    COUNT(1) AS queries
FROM system:completed_requests
WHERE UPPER(statement) NOT LIKE 'INFER %'
    AND UPPER(statement) NOT LIKE 'CREATE INDEX%'
    AND UPPER(statement) NOT LIKE '% SYSTEM:%'
GROUP BY statement
LETTING avgResultSize = AVG(resultSize)
ORDER BY avgResultSize DESC;
`;

export const n1qlLargestResultCountQueries: string = `
SELECT statement,
    avgResultCount,
    COUNT(1) AS queries
FROM system:completed_requests
WHERE UPPER(statement) NOT LIKE 'INFER %'
    AND UPPER(statement) NOT LIKE 'CREATE INDEX%'
    AND UPPER(statement) NOT LIKE '% SYSTEM:%'
GROUP BY statement
LETTING avgResultCount = AVG(resultCount)
ORDER BY avgResultCount DESC;
`;

export const n1qlPrimaryIndexes: string = `
SELECT *
FROM system:completed_requests
WHERE phaseCounts.\`primaryScan\` IS NOT MISSING
    AND UPPER(statement) NOT LIKE '% SYSTEM:%'
    AND UPPER(statement) NOT LIKE 'INFER %'
    AND UPPER(statement) NOT LIKE 'CREATE INDEX%'
ORDER BY resultCount DESC;
`;

// SIO-667: outer WHERE goes into the /* WHERE_CLAUSES */ marker so callers
// don't replace the inner sub-SELECT WHERE by accident.
// SIO-1162: total_count is just the catalog size -- a bare COUNT(*) over
// system:indexes (system:indexes has no `statement` column; request-history
// predicates here made the statement fail to parse on every run). The count
// lives in a WITH binding so it evaluates ONCE, not per projected row.
export const n1qlSystemIndexes: string = `
WITH total AS (SELECT RAW COUNT(*) FROM system:indexes)
SELECT
    total[0] AS total_count,
t.*
FROM system:indexes t /* WHERE_CLAUSES */;
`;

// LIMIT-free base: getCompletedRequests.buildQuery ALWAYS appends a LIMIT -- an unbounded
// 8-week scan+sort took ~3.7s and bloated responses.
//
// SIO-1774: three defects fixed here, each confirmed against the live cluster first.
//
// 1. `SELECT *, meta().plan` returned ~15 KB per row: one run got 745 KB for 50 rows, of which
//    the execution plan (an escaped JSON string) was the bulk and a dozen fields were connection
//    metadata (clientContextID, node, remoteAddr, userAgent, n1qlFeatCtrl ...). Nothing reads
//    this tool's output but the model -- no typed-finding extractor consumes it -- so the
//    projection is what a latency diagnosis needs, and the plan is opt-in.
// 2. `ORDER BY elapsedTime` sorted a duration STRING: "9.99s" ranks above "44.8s" and above
//    "1m12s", so the "slowest N" window silently dropped the slowest queries. Live: the top row
//    was 9.99 s while 1m12 s and 44.9 s requests existed.
// 3. See COMPLETED_REQUEST_STATES in getCompletedRequests.ts for the status filter.
const COMPLETED_REQUEST_FIELDS = [
	"requestId",
	"requestTime",
	"state",
	"statementType",
	"statement",
	"queryContext",
	"users",
	"elapsedTime",
	"serviceTime",
	"cpuTime",
	"ioTime",
	"waitTime",
	"resultCount",
	"resultSize",
	"usedMemory",
	"errorCount",
	"errors",
	"phaseCounts",
	"phaseTimes",
	// Couchbase's own diagnosis ("High primary scan count", "Filter eliminating over 90%").
	"`~analysis` AS analysis",
];

export function completedRequestsQuery(includePlan = false): string {
	const fields = includePlan ? [...COMPLETED_REQUEST_FIELDS, "meta().plan AS plan"] : COMPLETED_REQUEST_FIELDS;
	return `
SELECT ${fields.join(", ")}
FROM system:completed_requests
WHERE requestTime >= DATE_ADD_STR(NOW_STR(), -8, 'week')
ORDER BY STR_TO_DURATION(elapsedTime) DESC;
`;
}

// Kept for importers that want the default (plan-free) statement.
export const n1qlCompletedRequests: string = completedRequestsQuery();

// With the ordering fixed the head of the list IS the slowest, so fewer rows answer the
// question. ~2 KB per row: 20 rows is ~40 KB where the old default was ~750 KB.
export const COMPLETED_REQUESTS_DEFAULT_LIMIT = 20;

// Default row cap for the completed/fatal request-history tools when the
// caller passes no limit. Keeps the ORDER BY sort bounded server-side.
export const DEFAULT_ANALYSIS_LIMIT = 50;

export const n1qlPreparedStatements: string = `
SELECT * FROM system:prepareds;
`;

export const n1qlIndexesToDrop: string = `
SELECT 
  (SELECT i_inner.name, i_inner.keyspace_id, i_inner.\`namespace\`, i_inner.namespace_id, i_inner.state
  FROM system:indexes AS i_inner
  WHERE i_inner.metadata.last_scan_time IS NULL AND ANY v IN ["default", "prices"] SATISFIES i_inner.keyspace_id LIKE v || "%" END) as last_scan_null,
  COUNT(*) AS total
FROM system:indexes AS i
WHERE i.metadata.last_scan_time IS NULL AND ANY v IN ["default", "prices"] SATISFIES i.keyspace_id LIKE v || "%" END;
`;

// SIO-1175: durations are converted once per row via LET instead of per-aggregate,
// the default window matches n1qlCompletedRequests (8 weeks; buildQuery rewrites it
// for the period parameter), and the pct_* / authorize / project / stream / filter
// columns were dropped -- percentages are derivable client-side from the avg pairs.
export const mostExpensiveQueries: string = `
SELECT
       COUNT(*) AS count,
       preparedText,
       statement,
       AVG(resultSize) AS avg_resultSize,
       AVG(resultCount) AS avg_resultCount,
       AVG(usedMemory) AS avg_usedMemory,
       AVG(phaseCounts['fetch']) AS avg_fetches,
       AVG(phaseCounts.indexScan) AS avg_indexScanResults,
       AVG(phaseOperators.indexScan) AS avg_indexesScanned,
       SUM(svc) as sum_serviceTimeMs,

       DURATION_TO_STR(AVG(svc)) AS avg_serviceTime,
       DURATION_TO_STR(SUM(svc)) AS sum_serviceTime,

       DURATION_TO_STR(AVG(ela)) AS avg_elapsedTime,
       DURATION_TO_STR(SUM(ela)) AS sum_elapsedTime,

       DURATION_TO_STR(AVG(runT)) AS avg_runTime,
       DURATION_TO_STR(SUM(runT)) AS sum_runTime,

       DURATION_TO_STR(AVG(fetchT)) AS avg_fetchTime,
       DURATION_TO_STR(SUM(fetchT)) AS sum_fetchTime,

       DURATION_TO_STR(AVG(planT)) AS avg_planTime,
       DURATION_TO_STR(SUM(planT)) AS sum_planTime,

       DURATION_TO_STR(AVG(scanT)) AS avg_indexScanTime,
       DURATION_TO_STR(SUM(scanT)) AS sum_indexScanTime,

       MIN(requestTime) as requestTimeFirst,
       MAX(requestTime) as requestTimeLast

FROM system:completed_requests
LET svc = STR_TO_DURATION(serviceTime),
    ela = STR_TO_DURATION(elapsedTime),
    runT = STR_TO_DURATION(phaseTimes.run),
    fetchT = STR_TO_DURATION(phaseTimes['fetch']),
    planT = STR_TO_DURATION(phaseTimes.plan),
    scanT = STR_TO_DURATION(phaseTimes.indexScan)
WHERE requestTime >= DATE_ADD_STR(NOW_STR(), -8, 'week')
  AND LOWER(statement) IS NOT NULL AND LOWER(statement) NOT LIKE "%advise %" AND LOWER(statement) NOT LIKE "%infer %"
GROUP BY statement,preparedText
ORDER BY sum_serviceTimeMs DESC;
`;

export const documentTypeExamples: string = `
SELECT d.documentType, MIN(META(d).id) AS documentKey
FROM default._default._default AS d
WHERE d.documentType IS NOT NULL
GROUP BY d.documentType;
`;

// System Information Queries
export const systemNodesQuery: string = `
SELECT * FROM system:nodes;
`;

export const systemVitalsQuery: string = `
SELECT * FROM system:vitals;
`;

export const detailedPreparedStatementsQuery: string = `
SELECT * FROM system:prepareds
ORDER BY uses DESC;
`;

// SIO-667: WHERE_CLAUSES and ORDER_BY markers let buildQuery splice composed
// predicates / sort fields without regex-replacing against arbitrary SQL.
export const detailedIndexesQuery: string = `
SELECT t.*
FROM system:indexes t /* WHERE_CLAUSES */
ORDER BY /* ORDER_BY */;
`;

// SIO-1107: index scan followed by a fetch phase = the index did NOT cover the
// projection, so every matching entry paid a document fetch. Ported from the
// official Couchbase MCP server's get_queries_not_using_covering_index.
export const n1qlNonCoveringIndexQueries: string = `
SELECT statement,
    COUNT(1) AS executions,
    AVG(phaseCounts.indexScan) AS avgIndexScanCount,
    AVG(phaseCounts['fetch']) AS avgFetchCount,
    DURATION_TO_STR(AVG(STR_TO_DURATION(serviceTime))) AS avgServiceTime,
    MAX(requestTime) AS lastExecutionTime
FROM system:completed_requests
WHERE phaseCounts.indexScan IS NOT MISSING
    AND phaseCounts['fetch'] IS NOT MISSING
    AND UPPER(statement) NOT LIKE 'INFER %'
    AND UPPER(statement) NOT LIKE 'CREATE INDEX%'
    AND UPPER(statement) NOT LIKE '% SYSTEM:%'
GROUP BY statement
ORDER BY avgFetchCount DESC;
`;

// SIO-1107: queries whose index scans read far more entries than they return --
// a poorly selective index or predicate. Ported from the official Couchbase MCP
// server's get_queries_not_selective.
export const n1qlLowSelectivityQueries: string = `
SELECT statement,
    COUNT(1) AS executions,
    AVG(phaseCounts.indexScan) AS avgIndexScanCount,
    AVG(resultCount) AS avgResultCount,
    AVG(phaseCounts.indexScan - resultCount) AS avgScanResultGap,
    ROUND(AVG(resultCount) / AVG(phaseCounts.indexScan) * 100, 2) AS selectivityPct
FROM system:completed_requests
WHERE phaseCounts.indexScan IS NOT MISSING
    AND phaseCounts.indexScan > resultCount
    AND UPPER(statement) NOT LIKE 'INFER %'
    AND UPPER(statement) NOT LIKE 'CREATE INDEX%'
    AND UPPER(statement) NOT LIKE '% SYSTEM:%'
GROUP BY statement
ORDER BY avgScanResultGap DESC;
`;

// SIO-1107: the server-computed Index Advisor. The analyzed statement binds as a
// named parameter (never spliced), and ADVISOR only evaluates -- it never creates
// indexes, so it is safe under readOnlyQueryMode.
export const n1qlIndexAdvisor: string = `
SELECT ADVISOR($advise_statement) AS advisor_result;
`;
