# @devops-agent/mcp-server-atlassian

Proxy-plus-correlation MCP server for Atlassian Jira and Confluence. Wraps the Atlassian Rovo MCP endpoint (OAuth 2.1) and adds three read-only incident-correlation tools.

## Running

```bash
bun run --filter '@devops-agent/mcp-server-atlassian' dev
```

Default transport: stdio. Set `MCP_TRANSPORT=http` and `MCP_PORT=9085` for HTTP mode.

## Environment

| Var | Default | Description |
|---|---|---|
| `ATLASSIAN_UPSTREAM_MCP_URL` | `https://mcp.atlassian.com/v1/mcp` | Upstream Rovo endpoint the server proxies to. (Distinct from `ATLASSIAN_MCP_URL`, which is the local proxy URL the agent connects to — see the top-level `.env.example`.) |
| `ATLASSIAN_SITE_NAME` | (unset) | Match a site name to select cloudId; first accessible used if unset |
| `ATLASSIAN_READ_ONLY` | `true` | Filter write tools at registration |
| `ATLASSIAN_INCIDENT_PROJECTS` | (unset, warned) | Comma-separated Jira project keys for custom tools |
| `ATLASSIAN_OAUTH_CALLBACK_PORT` | `9185` | Local OAuth redirect port |
| `ATLASSIAN_TIMEOUT` | `30000` | Tool call timeout (ms) |
| `ATLASSIAN_MCP_PORT` | `9085` | HTTP transport port |

## OAuth Flow

First run: browser opens for consent. Tokens persist at `~/.mcp-auth/atlassian/<sanitized-endpoint>.json`. Dynamic client registration means no manual OAuth app setup.

## Tools

Proxied read-only Rovo tools plus three custom correlation tools:

- `findLinkedIncidents` -- JQL-composed recent incident search with MTTR
- `getRunbookForAlert` -- CQL search with client-side relevance ranking
- `getIncidentHistory` -- time-bucketed incident count and MTTR

## Testing

```bash
bun run --filter '@devops-agent/mcp-server-atlassian' test
bun run --filter '@devops-agent/mcp-server-atlassian' typecheck
```

## Smoke Test

```bash
bun --env-file=../../.env src/index.ts
```

Watch for the `Atlassian MCP ready` startup log with resolved cloudId.
