<!--
VENDORED REFERENCE — do not edit by hand. Source: the AgentMemory service's own /openapi.json
(packaged at ~/WebstormProjects/agent_memory/api-docs/). Re-vendor from `GET /openapi.json` when the
service version changes. The raw spec is alongside as `agent-memory-openapi.json`.

Our deployment runs at http://localhost:8070 (the doc's "Base URL (local)" line may say :8080 — the
spec's `servers` default host is localhost:8080; the port is deployment-specific, the contract is not).

SIO-998 gotcha: a `query`-driven search ranks top-`relevant_k` (default 10) by relevance, THEN applies
the annotation filter — so an identifier-keyed recall must send `filters` ALONE (no `query`) for
deterministic retrieval. See docs/architecture/agent-memory.md "Retrieval: TWO modes".
-->
# AgentMemory API — API Reference

- **Spec version:** 0.1.0  
- **OpenAPI:** 3.1.0  
- **Base URL (local):** `http://localhost:8070`  
- **Interactive:** Swagger `/docs`, ReDoc `/redoc`, raw spec `/openapi.json`

AgentMemory is a persistent, semantic memory service for AI agents. It stores conversation
history, extracted facts, and vector embeddings, enabling agents to recall relevant past
context across sessions and conversations.

## Core concepts

AgentMemory organizes data in a three-level hierarchy:

- **User** — a persistent identity (human end-user, agent instance, or service account)
  that owns one or more sessions. A user must exist before sessions or memory can be created.
- **Session** — a scoped conversation context owned by a user. The session is the default
  boundary for semantic search — results are drawn from the current session unless the
  request explicitly expands scope. Sessions can be ended to prevent further writes.
- **Memory block** — the atomic unit of stored knowledge. Each block holds either a
  **chat message** (a user-turn and assistant-turn exchange) or a **fact** (a standalone
  declarative string). Blocks are independently addressable and retrievable.

## Semantic extraction

When a memory block is written, AgentMemory automatically generates a vector embedding and an
optional LLM-generated summary. By default this happens asynchronously in the background.
Blocks are immediately readable after ingestion but only participate in semantic search once
their `status` reaches `ready`. Blocks with `status: processing` or `status: extraction_failed`
are excluded from search results.

## Authentication

Authentication is optional and controlled by the `OIDC_AUTH_ENABLED` server configuration.
When enabled, all endpoints except `GET /health` and `GET /metrics` require a valid JWT
Bearer token issued by the configured OIDC provider.

Include the token in every request:
```
Authorization: Bearer <token>
```

Tokens are validated against the provider's JWKS endpoint. A `401` response indicates a
missing, malformed, or expired token. A `403` response indicates a valid token with
insufficient permissions.

## Request and response format

All request and response bodies use `application/json`. All timestamps are ISO 8601 strings
in UTC. Errors are returned as a JSON object with an `error` code, a human-readable
`message`, and an optional `details` field.

## Rate limiting and ingestion

Memory block ingestion is accepted immediately, but semantic extraction (embedding generation
and summarization) is rate-limited by the configured model provider. If the extraction queue
reaches capacity, ingestion requests return `503` with a `retry_after_seconds` field.


> Generated from the live server's OpenAPI spec. For machine consumption use `openapi.json` in this folder.

## Endpoints

### Health

#### `GET /health`

Check Server Health

Return server health status, version, and uptime. Public endpoint — no authentication required.

**Responses**

| code | type | description |
|---|---|---|
| 200 | HealthResponse | Successful Response |

#### `GET /health/async-batch-processor`

Check Extraction Queue Health

Return lightweight readiness status for the semantic extraction queue.

**Responses**

| code | type | description |
|---|---|---|
| 200 | AsyncBatchProcessorHealthResponse | Successful Response |

#### `GET /health/async-batch-processor-stats`

Get Extraction Queue Statistics

Return detailed queue depth, model API rate budget, and cumulative throughput statistics for the semantic extraction queue.

**Responses**

| code | type | description |
|---|---|---|
| 200 | AsyncBatchProcessorHealthResponse | Successful Response |

#### `GET /health/couchbase`

Check Database Health

Verify that AgentMemory can reach and query the Couchbase database.

**Responses**

| code | type | description |
|---|---|---|
| 200 | CouchbaseHealthResponse | Successful Response |

#### `GET /health/memory`

Check Memory Pressure Status

Return current memory usage relative to the configured quota threshold. When usage exceeds the threshold, new ingestion requests are rejected until pressure subsides.

**Responses**

| code | type | description |
|---|---|---|
| 200 | MemoryMonitorHealthResponse | Successful Response |

#### `GET /health/models`

Check Model Service Health

Check reachability and status of the configured embedding and LLM model services.

**Responses**

| code | type | description |
|---|---|---|
| 200 | ModelsHealthResponse | Successful Response |

### Logs

#### `GET /logs/collect`

Download Diagnostic Logs

Download server logs and optional system diagnostics as a ZIP archive.
Use `log_types` to select log categories and `start_time`/`end_time` to narrow the time range.
Add `sys_commands` to include live system snapshots (CPU, memory, disk, network) in the archive.
Include this archive in support requests and incident post-mortems.

**Parameters**

| name | in | type | required | description |
|---|---|---|---|---|
| `start_time` | query | string | null | False | Include log lines at or after this timestamp |
| `end_time` | query | string | null | False | Include log lines at or before this timestamp |
| `log_types` | query | string[] | null | False | Log categories to include |
| `sys_commands` | query | string[] | null | False | Optional system commands to run and include in the archive |

**Responses**

| code | type | description |
|---|---|---|
| 200 | object | Successful Response |
| 400 | any | Invalid request |
| 422 | HTTPValidationError | Validation Error |

### Memory

#### `GET /users/{user_id}/memory`

List Memory Blocks

Paginated list of memory blocks for a user, ordered newest first.
Use `session_ids` to scope results to specific sessions.
Always specify `limit` and `offset` — unbounded requests on large datasets are slow.

**Parameters**

| name | in | type | required | description |
|---|---|---|---|---|
| `user_id` | path | string | True | Unique identifier for the user |
| `session_ids` | query | string | null | False | Comma-separated session IDs to filter by, or 'all' for all sessions |
| `limit` | query | integer | False | Maximum number of memory blocks to return (1–200) |
| `offset` | query | integer | False | Number of memory blocks to skip for pagination |
| `order_by` | query | "ingested_at" | "created_at" | False | Field to order results by. Defaults to 'ingested_at'. |

**Responses**

| code | type | description |
|---|---|---|
| 200 | ListMemoriesResponse | Successful Response |
| 422 | HTTPValidationError | Validation Error |

#### `DELETE /users/{user_id}/sessions/{session_id}/memory`

Delete Memory Blocks

Delete memory blocks by ID. Pass a list of block IDs to delete specific blocks,
or `"all"` to delete every block in the session.

**Parameters**

| name | in | type | required | description |
|---|---|---|---|---|
| `user_id` | path | string | True | Unique identifier for the user |
| `session_id` | path | string | True | Unique identifier for the session |

**Request body** (`application/json`): `DeleteMemoryRequest`

**Responses**

| code | type | description |
|---|---|---|
| 200 | DeleteMemoryResponse | Successful Response |
| 422 | HTTPValidationError | Validation Error |

#### `POST /users/{user_id}/sessions/{session_id}/memory`

Add Memory Blocks

Add one or more memory blocks to the session. Each block holds either a chat message
(user + assistant turn) or a fact (declarative string). Blocks are written immediately
and queued for semantic extraction. The session must be open — ended sessions reject new blocks.

**Parameters**

| name | in | type | required | description |
|---|---|---|---|---|
| `user_id` | path | string | True | Unique identifier for the user |
| `session_id` | path | string | True | Unique identifier for the session |

**Request body** (`application/json`): `AddMemoryRequest`

**Responses**

| code | type | description |
|---|---|---|
| 201 | AddMemoryResponse | Successful Response |
| 422 | HTTPValidationError | Validation Error |

#### `POST /users/{user_id}/sessions/{session_id}/memory/search`

Search Memory

Retrieve memory blocks using semantic similarity and/or filters. Provide a natural-language
`query` to rank blocks by relevance, or use `filters` alone for deterministic retrieval.
Search is session-scoped by default — set `filters.session_ids` to `"all"` to search
across all sessions for the user. Only `ready` blocks appear in results.

**Parameters**

| name | in | type | required | description |
|---|---|---|---|---|
| `user_id` | path | string | True | Unique identifier for the user |
| `session_id` | path | string | True | Unique identifier for the session |

**Request body** (`application/json`): `SearchMemoryRequest`

**Responses**

| code | type | description |
|---|---|---|
| 200 | MemoryResponse | Successful Response |
| 422 | HTTPValidationError | Validation Error |

#### `PUT /users/{user_id}/sessions/{session_id}/memory/{block_id}`

Update Memory Block

Update the content, annotations, or TTL of an existing memory block.
Providing a new message or fact triggers re-extraction (new embedding and summary).
Omitted fields retain their existing values. Use this endpoint to retry extraction
on blocks with `status: extraction_failed` by setting `async_processing: true`.
If the block does not exist or has expired due to TTL, responds with 404.

**Parameters**

| name | in | type | required | description |
|---|---|---|---|---|
| `user_id` | path | string | True | Unique identifier for the user |
| `session_id` | path | string | True | Unique identifier for the session |
| `block_id` | path | string | True | Unique identifier for the memory block |

**Request body** (`application/json`): `UpdateMemoryRequest`

**Responses**

| code | type | description |
|---|---|---|
| 200 | UpdateMemoryResponse | Successful Response |
| 422 | HTTPValidationError | Validation Error |

### Metrics

#### `GET /metrics`

Scrape Prometheus Metrics

**Responses**

| code | type | description |
|---|---|---|
| 200 | object | Successful Response |

### Sessions

#### `POST /users/{user_id}/sessions`

Create Session

Create a new session for the specified user.
The `session_id` must be unique per user — attempting to create a session with a duplicate ID returns a conflict error.

**Parameters**

| name | in | type | required | description |
|---|---|---|---|---|
| `user_id` | path | string | True | Unique identifier for the user |

**Request body** (`application/json`): `CreateSessionRequest`

**Responses**

| code | type | description |
|---|---|---|
| 201 | Session | Successful Response |
| 422 | HTTPValidationError | Validation Error |

#### `DELETE /users/{user_id}/sessions/{session_id}`

Delete Session

Permanently delete a session and all its memory blocks. This operation is irreversible.

**Parameters**

| name | in | type | required | description |
|---|---|---|---|---|
| `user_id` | path | string | True | Unique identifier for the user |
| `session_id` | path | string | True | Unique identifier for the session |

**Responses**

| code | type | description |
|---|---|---|
| 204 | - | Successful Response |
| 422 | HTTPValidationError | Validation Error |

#### `GET /users/{user_id}/sessions/{session_id}`

Get Session

Retrieve a session by ID, including its lifecycle state, annotations, and metadata.

**Parameters**

| name | in | type | required | description |
|---|---|---|---|---|
| `user_id` | path | string | True | Unique identifier for the user |
| `session_id` | path | string | True | Unique identifier for the session |

**Responses**

| code | type | description |
|---|---|---|
| 200 | Session | Successful Response |
| 422 | HTTPValidationError | Validation Error |

#### `PUT /users/{user_id}/sessions/{session_id}`

Update Session

Update a session's annotations and/or metadata.
At least one field must be provided. Omitted fields retain their existing values.

**Parameters**

| name | in | type | required | description |
|---|---|---|---|---|
| `user_id` | path | string | True | Unique identifier for the user |
| `session_id` | path | string | True | Unique identifier for the session |

**Request body** (`application/json`): `UpdateSessionRequest`

**Responses**

| code | type | description |
|---|---|---|
| 200 | Session | Successful Response |
| 422 | HTTPValidationError | Validation Error |

#### `POST /users/{user_id}/sessions/{session_id}/end`

End Session

Mark a session as ended. Once ended, no new memory blocks can be added.
Existing memory blocks remain readable and searchable. Returns the updated session with `end_time` set.

**Parameters**

| name | in | type | required | description |
|---|---|---|---|---|
| `user_id` | path | string | True | Unique identifier for the user |
| `session_id` | path | string | True | Unique identifier for the session |

**Responses**

| code | type | description |
|---|---|---|
| 200 | Session | Successful Response |
| 422 | HTTPValidationError | Validation Error |

### Users

#### `GET /users`

List Users

Retrieve all users. Returns an empty list if no users exist.

**Responses**

| code | type | description |
|---|---|---|
| 200 | UserListResponse | Successful Response |

#### `POST /users`

Create User

Create a new user with the specified ID, name, and optional metadata.
The `user_id` must be unique — attempting to create a user with an existing ID returns a conflict error.

**Request body** (`application/json`): `CreateUserRequest`

**Responses**

| code | type | description |
|---|---|---|
| 201 | User | Successful Response |
| 422 | HTTPValidationError | Validation Error |

#### `POST /users/search`

Search Users

Find users matching the provided criteria (`user_id`, `name`, or `metadata`).
Multiple criteria are combined with AND logic. At least one criterion must be provided.

**Request body** (`application/json`): `SearchUsersRequest`

**Responses**

| code | type | description |
|---|---|---|
| 200 | User | User[] | Successful Response |
| 422 | HTTPValidationError | Validation Error |

#### `DELETE /users/{user_id}`

Delete User

Permanently delete a user and all associated sessions and memory blocks.
This operation is irreversible — there is no soft-delete or recovery.

**Parameters**

| name | in | type | required | description |
|---|---|---|---|---|
| `user_id` | path | string | True | Unique identifier for the user |

**Responses**

| code | type | description |
|---|---|---|
| 204 | - | Successful Response |
| 422 | HTTPValidationError | Validation Error |

#### `PUT /users/{user_id}`

Update User

Update an existing user's `name` and/or `metadata`.
At least one field must be provided. Omitted fields retain their existing values.

**Parameters**

| name | in | type | required | description |
|---|---|---|---|---|
| `user_id` | path | string | True | Unique identifier for the user |

**Request body** (`application/json`): `UpdateUserRequest`

**Responses**

| code | type | description |
|---|---|---|
| 200 | User | Successful Response |
| 422 | HTTPValidationError | Validation Error |

#### `GET /users/{user_id}/sessions`

List User Sessions

Retrieve all sessions for a user, including lifecycle state and annotations. Returns an empty list if the user has no sessions.

**Parameters**

| name | in | type | required | description |
|---|---|---|---|---|
| `user_id` | path | string | True | Unique identifier for the user |

**Responses**

| code | type | description |
|---|---|---|
| 200 | SessionListResponse | Successful Response |
| 422 | HTTPValidationError | Validation Error |

#### `PUT /users/{user_id}/ttl`

Update Memory Block TTL

Update the time-to-live (TTL) for memory blocks belonging to a user.
Optionally scope the update to specific sessions or specific block IDs.

**Parameters**

| name | in | type | required | description |
|---|---|---|---|---|
| `user_id` | path | string | True | Unique identifier for the user |

**Request body** (`application/json`): `ModifyTtlRequest`

**Responses**

| code | type | description |
|---|---|---|
| 200 | object | Successful Response |
| 422 | HTTPValidationError | Validation Error |

## Schemas

### AddMemoryRequest

| field | type | required | description |
|---|---|---|---|
| `messages` | ChatMessage[] | null | False |  |
| `facts` | string[] | null | False |  |
| `annotations` | object | null | False |  |
| `created_at` | string | null | False | ISO 8601 timestamp indicating when the data was originally created. Stored as null if not provided. |
| `async_processing` | boolean | False | (default: `false`) |
| `memory_block_ttl` | integer | null | False |  |
| `context_required` | boolean | null | False |  |

### AddMemoryResponse

Response for add memory operation.

| field | type | required | description |
|---|---|---|---|
| `message` | string | True |  |
| `accepted_count` | integer | True |  |
| `block_ids` | string[] | True |  |
| `rejected_count` | integer | True |  |
| `rejected_details` | object[] | null | False |  |

### AsyncBatchProcessorHealthResponse

Aggregated health payload for the async batch processor endpoint.

| field | type | required | description |
|---|---|---|---|
| `status` | string | True |  |
| `message` | string | null | False |  |
| `queue` | AsyncBatchQueueStats | null | False |  |
| `rate_budget` | AsyncBatchRateBudget | null | False |  |
| `statistics` | AsyncBatchStatistics | null | False |  |
| `loop_running` | boolean | null | False |  |
| `dispatcher_alive` | boolean | null | False |  |

### AsyncBatchQueueStats

Queue depth and processing counts for async batch processor.

| field | type | required | description |
|---|---|---|---|
| `size` | integer | True |  |
| `queued_ids` | integer | True |  |
| `processing` | integer | True |  |
| `max_size` | integer | null | False |  |

### AsyncBatchRateBudget

Snapshot of remaining request/token capacity and configured limits.

| field | type | required | description |
|---|---|---|---|
| `available_requests` | number | True |  |
| `available_tokens` | number | True |  |
| `max_requests_per_minute` | number | True |  |
| `max_tokens_per_minute` | number | True |  |
| `per_request_token_limit` | integer | True |  |

### AsyncBatchStatistics

Cumulative async batch processor counters for observability.

| field | type | required | description |
|---|---|---|---|
| `total_enqueued` | integer | True |  |
| `total_recovered` | integer | True |  |
| `total_dispatched` | integer | True |  |
| `total_completed` | integer | True |  |
| `total_failed` | integer | True |  |
| `queue_full` | integer | True |  |
| `queue_duplicates` | integer | True |  |
| `queue_oversized` | integer | True |  |
| `recovery_duplicates` | integer | True |  |
| `active_tasks` | integer | True |  |
| `loop_running` | boolean | null | False |  |
| `dispatcher_alive` | boolean | null | False |  |

### ChatMessage

| field | type | required | description |
|---|---|---|---|
| `user_content` | string | False | (default: `""`) |
| `assistant_content` | string | False | (default: `""`) |

### CouchbaseHealthResponse

Health response for Couchbase database.

| field | type | required | description |
|---|---|---|---|
| `status` | HealthStatus | True |  |

### CreateSessionRequest

| field | type | required | description |
|---|---|---|---|
| `session_id` | string | True |  |
| `annotations` | object | null | False |  |
| `metadata` | object | null | False |  |
| `memory_blocks_ttl` | integer | null | False |  |

### CreateUserRequest

| field | type | required | description |
|---|---|---|---|
| `user_id` | string | True |  |
| `name` | string | True |  |
| `metadata` | object | null | False |  |

### DeleteMemoryRequest

| field | type | required | description |
|---|---|---|---|
| `block_ids` | string[] | string | True |  |

### DeleteMemoryResponse

| field | type | required | description |
|---|---|---|---|
| `deleted_count` | integer | True |  |

### FilterOptions

| field | type | required | description |
|---|---|---|---|
| `start_time` | string | null | False | Inclusive lower bound on ingested_at (when the block was stored). For semantic search this is a pre-filter inside the FTS KNN index, so only blocks ingested within [start_time, end_time) enter the candidate pool. |
| `end_time` | string | null | False | Exclusive upper bound on ingested_at. See start_time. |
| `created_start_time` | string | null | False | Inclusive lower bound on created_at (the original data-creation timestamp, which may differ from ingestion time for historic imports). For semantic search this is also a pre-filter inside the FTS KNN index. When both ingested_at and created_at ranges are provided they are ANDed: a block must satisfy both ranges to be returned. |
| `created_end_time` | string | null | False | Exclusive upper bound on created_at. See created_start_time. |
| `session_ids` | string[] | string | null | False | List of session IDs to search, 'all' for all sessions, or None for current session only |
| `block_ids` | string[] | null | False |  |
| `relevant_k` | integer | null | False | (default: `10`) |
| `annotations` | object | null | False |  |
| `order_by` | "ingested_at" | "created_at" | null | False | Field to order results by. Defaults to 'ingested_at'. (default: `"ingested_at"`) |

### HTTPValidationError

| field | type | required | description |
|---|---|---|---|
| `detail` | ValidationError[] | False |  |

### HealthResponse

| field | type | required | description |
|---|---|---|---|
| `status` | HealthStatus | True |  |
| `version` | string | True |  |
| `uptime_seconds` | number | null | False |  |

### HealthStatus

Enum: `"healthy"`, `"degraded"`, `"unhealthy"`

### ListMemoriesResponse

Response for listing memory blocks with pagination.

| field | type | required | description |
|---|---|---|---|
| `memory_blocks` | MemoryBlock[] | True |  |
| `count` | integer | True | Number of memory blocks returned in this response |
| `total` | integer | True | Total number of memory blocks matching the query scope |
| `limit` | integer | True | Maximum number of memory blocks requested (1-200) |
| `offset` | integer | True | Number of memory blocks skipped |

### MemoryBlock

| field | type | required | description |
|---|---|---|---|
| `block_id` | string | True |  |
| `user_id` | string | True |  |
| `session_id` | string | True |  |
| `message` | ChatMessage | null | False |  |
| `fact` | string | null | False |  |
| `ingested_at` | string | True |  |
| `created_at` | string | null | False |  |
| `last_queued_at` | string | null | False |  |
| `fail_count` | integer | null | False | (default: `0`) |
| `annotations` | object | null | False |  |
| `summary` | string | null | False |  |
| `contexts` | string[] | null | False |  |
| `status` | MemoryBlockStatus | False | (default: `"ready"`) |
| `rel_score` | number | null | False |  |

### MemoryBlockStatus

Enum: `"processing"`, `"ready"`, `"extraction_failed"`

### MemoryMonitorHealthResponse

Health response for memory monitor.

| field | type | required | description |
|---|---|---|---|
| `status` | string | True |  |
| `message` | string | null | False |  |
| `accepting_requests` | boolean | null | False |  |
| `usage_percent` | number | null | False |  |
| `threshold_percent` | number | null | False |  |
| `last_check` | number | null | False |  |

### MemoryResponse

Response wrapper for memory blocks.

| field | type | required | description |
|---|---|---|---|
| `memory_blocks` | MemoryBlock[] | True |  |
| `count` | integer | True |  |

### ModelHealth

Health info for a single model service.

| field | type | required | description |
|---|---|---|---|
| `status` | string | True |  |
| `model` | string | True |  |
| `retry_after` | integer | null | False |  |

### ModelsHealthResponse

Health response for model services.

| field | type | required | description |
|---|---|---|---|
| `status` | HealthStatus | True |  |
| `embedding` | ModelHealth | True |  |
| `llm` | ModelHealth | True |  |

### ModifyTtlRequest

| field | type | required | description |
|---|---|---|---|
| `session_id` | string | null | False |  |
| `block_ids` | string[] | null | False |  |
| `new_ttl` | integer | True |  |

### SearchMemoryRequest

| field | type | required | description |
|---|---|---|---|
| `query` | string | null | False |  |
| `filters` | FilterOptions | null | False |  |

### SearchUsersRequest

| field | type | required | description |
|---|---|---|---|
| `user_id` | string | null | False |  |
| `name` | string | null | False |  |
| `metadata` | object | null | False |  |

### Session

| field | type | required | description |
|---|---|---|---|
| `user_id` | string | True |  |
| `session_id` | string | True |  |
| `start_time` | string | True |  |
| `end_time` | string | null | False |  |
| `annotations` | object | null | False |  |
| `metadata` | object | null | False |  |
| `blocks_ttl` | integer | null | False |  |

### SessionListResponse

Response wrapper for list of sessions.

| field | type | required | description |
|---|---|---|---|
| `sessions` | Session[] | True |  |
| `count` | integer | True |  |

### UpdateMemoryRequest

| field | type | required | description |
|---|---|---|---|
| `message` | ChatMessage | null | False |  |
| `fact` | string | null | False |  |
| `annotations` | object | null | False | New annotations to overwrite existing ones. If None, existing annotations are preserved. |
| `memory_block_ttl` | integer | null | False | New TTL in seconds. If None, existing TTL is preserved. |
| `async_processing` | boolean | False | If True, semantic extraction runs in background via queue. (default: `false`) |
| `context_required` | boolean | null | False | Whether semantic extraction is required. If None, uses environment variable. |

### UpdateMemoryResponse

| field | type | required | description |
|---|---|---|---|
| `message` | string | True |  |
| `block` | MemoryBlock | null | False | The updated memory block. Always populated on a 200 response; missing or expired blocks return 404 instead. |

### UpdateSessionRequest

| field | type | required | description |
|---|---|---|---|
| `annotations` | object | null | False |  |
| `metadata` | object | null | False |  |

### UpdateUserRequest

| field | type | required | description |
|---|---|---|---|
| `name` | string | null | False |  |
| `metadata` | object | null | False |  |

### User

| field | type | required | description |
|---|---|---|---|
| `id` | string | True |  |
| `name` | string | True |  |
| `sessions` | string[] | null | False |  |
| `metadata` | object | null | False |  |

### UserListResponse

Response wrapper for list of users.

| field | type | required | description |
|---|---|---|---|
| `users` | User[] | True |  |
| `count` | integer | True |  |

### ValidationError

| field | type | required | description |
|---|---|---|---|
| `loc` | string | integer[] | True |  |
| `msg` | string | True |  |
| `type` | string | True |  |
