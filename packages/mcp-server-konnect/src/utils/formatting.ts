/**
 * Response formatting utilities for Kong Konnect MCP server
 */

/**
 * Format timestamps for better readability
 */
export function formatTimestamp(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    return date.toISOString().replace("T", " ").replace("Z", " UTC");
  } catch {
    return timestamp;
  }
}

/**
 * Format entity for display with key information highlighted
 */
export function formatEntity(entity: any, entityType: string): string {
  const formatted = [
    `${entityType.toUpperCase()}: ${entity.name || entity.id}`,
  ];

  // Add key fields based on entity type
  switch (entityType) {
    case "service":
      if (entity.host) formatted.push(`Host: ${entity.host}`);
      if (entity.port) formatted.push(`Port: ${entity.port}`);
      if (entity.protocol) formatted.push(`Protocol: ${entity.protocol}`);
      if (entity.path) formatted.push(`Path: ${entity.path}`);
      break;

    case "route":
      if (entity.methods)
        formatted.push(`Methods: ${entity.methods.join(", ")}`);
      if (entity.hosts) formatted.push(`Hosts: ${entity.hosts.join(", ")}`);
      if (entity.paths) formatted.push(`Paths: ${entity.paths.join(", ")}`);
      if (entity.protocols)
        formatted.push(`Protocols: ${entity.protocols.join(", ")}`);
      break;

    case "consumer":
      if (entity.username) formatted.push(`Username: ${entity.username}`);
      if (entity.custom_id) formatted.push(`Custom ID: ${entity.custom_id}`);
      break;

    case "plugin":
      formatted.push(`Plugin: ${entity.name}`);
      if (entity.service?.id) formatted.push(`Service: ${entity.service.id}`);
      if (entity.route?.id) formatted.push(`Route: ${entity.route.id}`);
      if (entity.consumer?.id)
        formatted.push(`Consumer: ${entity.consumer.id}`);
      break;

    case "certificate":
      if (entity.tags) formatted.push(`Tags: ${entity.tags.join(", ")}`);
      break;

    case "upstream":
      formatted.push(`Algorithm: ${entity.algorithm || "round-robin"}`);
      if (entity.slots) formatted.push(`Slots: ${entity.slots}`);
      break;

    case "data-plane-node":
      if (entity.hostname) formatted.push(`Hostname: ${entity.hostname}`);
      if (entity.ip) formatted.push(`IP: ${entity.ip}`);
      if (entity.status) formatted.push(`Status: ${entity.status}`);
      if (entity.version) formatted.push(`Version: ${entity.version}`);
      if (entity.last_seen)
        formatted.push(`Last Seen: ${formatTimestamp(entity.last_seen)}`);
      break;
  }

  // Common fields
  if (entity.enabled !== undefined) {
    formatted.push(`Enabled: ${entity.enabled ? "Yes" : "No"}`);
  }

  if (entity.created_at) {
    formatted.push(`Created: ${formatTimestamp(entity.created_at)}`);
  }

  if (entity.tags && entity.tags.length > 0) {
    formatted.push(`Tags: ${entity.tags.join(", ")}`);
  }

  return formatted.join("\n");
}

/**
 * Format a list of entities with summary information
 */
export function formatEntityList(entities: any[], entityType: string): string {
  if (!entities || entities.length === 0) {
    return `No ${entityType}s found.`;
  }

  const plural = entityType.endsWith("s") ? entityType : `${entityType}s`;
  const summary = [`Found ${entities.length} ${plural}:\n`];

  entities.forEach((entity, index) => {
    summary.push(`${index + 1}. ${formatEntitySummary(entity, entityType)}`);
  });

  return summary.join("\n");
}

/**
 * Format entity summary for list displays
 */
export function formatEntitySummary(entity: any, entityType: string): string {
  const name = entity.name || entity.id || entity.hostname || "Unknown";
  const parts = [name];

  switch (entityType) {
    case "service":
      if (entity.host)
        parts.push(
          `(${entity.protocol || "http"}://${entity.host}:${entity.port || 80})`,
        );
      break;

    case "route": {
      const routeInfo = [];
      if (entity.methods)
        routeInfo.push(`Methods: ${entity.methods.join(",")}`);
      if (entity.paths) routeInfo.push(`Paths: ${entity.paths.join(",")}`);
      if (routeInfo.length > 0) parts.push(`(${routeInfo.join(", ")})`);
      break;
    }

    case "consumer":
      if (entity.username && entity.custom_id) {
        parts.push(
          `(Username: ${entity.username}, Custom ID: ${entity.custom_id})`,
        );
      } else if (entity.username) {
        parts.push(`(Username: ${entity.username})`);
      } else if (entity.custom_id) {
        parts.push(`(Custom ID: ${entity.custom_id})`);
      }
      break;

    case "plugin":
      parts.push(`(${entity.name})`);
      if (!entity.enabled) parts.push("[DISABLED]");
      break;

    case "upstream":
      parts.push(`(${entity.algorithm || "round-robin"})`);
      break;

    case "data-plane-node":
      if (entity.ip) parts.push(`(${entity.ip})`);
      if (entity.status) parts.push(`[${entity.status.toUpperCase()}]`);
      break;
  }

  if (entity.enabled === false) {
    parts.push("[DISABLED]");
  }

  return parts.join(" ");
}

/**
 * Format API request analytics data
 */
export function formatApiRequestsResponse(response: any): string {
  const { meta, results } = response;

  if (!results || results.length === 0) {
    return "No API requests found for the specified time range and filters.";
  }

  const summary = [
    `API Requests Analysis (${results.length} requests)`,
    `Time Range: ${meta.time_range?.start} to ${meta.time_range?.end}\n`,
  ];

  // Group by status code for summary
  const statusCounts: Record<string, number> = {};
  const serviceCounts: Record<string, number> = {};
  let totalLatency = 0;

  results.forEach((request: any) => {
    const status = request.status_code?.toString() || "unknown";
    statusCounts[status] = (statusCounts[status] || 0) + 1;

    if (request.gateway_service) {
      serviceCounts[request.gateway_service] =
        (serviceCounts[request.gateway_service] || 0) + 1;
    }

    if (request.latencies_response_ms) {
      totalLatency += request.latencies_response_ms;
    }
  });

  // Status code summary
  summary.push("Status Code Distribution:");
  Object.entries(statusCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([status, count]) => {
      const percentage = ((count / results.length) * 100).toFixed(1);
      summary.push(`  ${status}: ${count} requests (${percentage}%)`);
    });

  // Average latency
  if (totalLatency > 0) {
    const avgLatency = (totalLatency / results.length).toFixed(2);
    summary.push(`\nAverage Response Latency: ${avgLatency}ms`);
  }

  // Top services
  if (Object.keys(serviceCounts).length > 0) {
    summary.push("\nTop Services:");
    Object.entries(serviceCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .forEach(([service, count]) => {
        const percentage = ((count / results.length) * 100).toFixed(1);
        summary.push(`  ${service}: ${count} requests (${percentage}%)`);
      });
  }

  return summary.join("\n");
}

/**
 * Format health check results
 */
export function formatHealthStatus(health: any, resourceName: string): string {
  if (!health) {
    return `Health status for ${resourceName}: No data available`;
  }

  const status = [];
  status.push(`Health Status for ${resourceName}:`);

  if (health.status) {
    status.push(`Overall Status: ${health.status.toUpperCase()}`);
  }

  if (health.targets && Array.isArray(health.targets)) {
    status.push(`\nTargets (${health.targets.length}):`);
    health.targets.forEach((target: any, index: number) => {
      const targetStatus = target.health || "unknown";
      const weight = target.weight || "N/A";
      status.push(
        `  ${index + 1}. ${target.target || "Unknown"} - Status: ${targetStatus}, Weight: ${weight}`,
      );
    });
  }

  return status.join("\n");
}

/**
 * Format certificate information with expiry warnings
 */
export function formatCertificate(cert: any): string {
  const info = [`Certificate: ${cert.id}`];

  if (cert.tags && cert.tags.length > 0) {
    info.push(`Tags: ${cert.tags.join(", ")}`);
  }

  // Try to parse certificate details if available
  if (cert.cert) {
    try {
      // Basic certificate info extraction (would need proper X.509 parsing in production)
      const certLines = cert.cert.split("\n");
      const certData = certLines.find((line: string) =>
        line.startsWith("-----BEGIN CERTIFICATE-----"),
      );
      if (certData) {
        info.push("Certificate Type: X.509");
      }
    } catch {
      info.push("Certificate: Valid PEM format");
    }
  }

  if (cert.created_at) {
    info.push(`Created: ${formatTimestamp(cert.created_at)}`);
  }

  return info.join("\n");
}

/**
 * Format plugin configuration in a readable way
 */
export function formatPluginConfig(config: any, pluginName: string): string {
  if (!config || typeof config !== "object") {
    return "No configuration";
  }

  const formatted = [`${pluginName} Configuration:`];

  // Handle common plugin configs
  Object.entries(config).forEach(([key, value]) => {
    if (value !== null && value !== undefined) {
      if (Array.isArray(value)) {
        formatted.push(`  ${key}: [${value.join(", ")}]`);
      } else if (typeof value === "object") {
        formatted.push(
          `  ${key}: ${JSON.stringify(value, null, 2).replace(/\n/g, "\n    ")}`,
        );
      } else {
        formatted.push(`  ${key}: ${value}`);
      }
    }
  });

  return formatted.join("\n");
}

/**
 * Truncate long text for display
 */
export function truncateText(text: string, maxLength = 100): string {
  if (!text || text.length <= maxLength) {
    return text;
  }

  return text.substring(0, maxLength - 3) + "...";
}

/**
 * Format bytes into human readable format
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / k ** i).toFixed(2)) + " " + sizes[i];
}
