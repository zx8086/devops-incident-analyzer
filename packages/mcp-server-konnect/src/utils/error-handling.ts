/**
 * Enhanced error handling utilities for Kong Konnect MCP server
 */

export interface TraceContext {
	runId?: string;
	traceUrl?: string;
	sessionId?: string;
}

export interface ErrorContext {
	operation: string;
	resource?: string;
	resourceId?: string;
	controlPlaneId?: string;
	troubleshooting?: string[];
	trace?: TraceContext;
}

export class KongMCPError extends Error {
	public readonly context: ErrorContext;
	public readonly statusCode?: number;

	constructor(message: string, context: ErrorContext, statusCode?: number) {
		super(message);
		this.name = "KongMCPError";
		this.context = context;
		this.statusCode = statusCode;
	}

	public toJSON() {
		return {
			name: this.name,
			message: this.message,
			context: this.context,
			statusCode: this.statusCode,
			stack: this.stack,
		};
	}
}

/**
 * Wrap Kong API calls with enhanced error context
 */
export function withErrorContext<T>(
	operation: string,
	resource?: string,
	resourceId?: string,
	controlPlaneId?: string,
) {
	return async (apiCall: () => Promise<T>): Promise<T> => {
		try {
			return await apiCall();
		} catch (error: unknown) {
			const context: ErrorContext = {
				operation,
				resource,
				resourceId,
				controlPlaneId,
				troubleshooting: generateTroubleshootingTips(error, operation, resource),
			};

			// Extract status code from axios error response or message text.
			let statusCode: number | undefined;
			let errMessage = "Unknown error occurred";
			if (error && typeof error === "object") {
				const errObj = error as {
					response?: { status?: unknown };
					statusCode?: unknown;
					message?: unknown;
				};
				if (typeof errObj.response?.status === "number") {
					statusCode = errObj.response.status;
				} else if (typeof errObj.message === "string" && errObj.message.includes("Status ")) {
					const match = errObj.message.match(/Status (\d+)/);
					if (match?.[1]) {
						statusCode = parseInt(match[1], 10);
					}
				}
				if (typeof errObj.message === "string") errMessage = errObj.message;
			} else if (typeof error === "string") {
				errMessage = error;
			}

			throw new KongMCPError(errMessage, context, statusCode);
		}
	};
}

/**
 * Generate contextual troubleshooting tips based on error type
 */
export function generateTroubleshootingTips(error: unknown, operation: string, resource?: string): string[] {
	const tips: string[] = [];

	// Status code specific tips. error may be axios-style or a plain Error;
	// tolerate either shape via a structural cast.
	const errObj =
		error && typeof error === "object"
			? (error as { response?: { status?: unknown }; statusCode?: unknown; message?: unknown })
			: undefined;
	const statusCode = errObj?.response?.status ?? errObj?.statusCode;

	switch (statusCode) {
		case 401:
			tips.push("Verify that KONNECT_ACCESS_TOKEN is set correctly");
			tips.push("Check if your access token has expired");
			tips.push("Ensure the token format is correct (no extra spaces or characters)");
			break;

		case 403:
			tips.push("Your access token may not have sufficient permissions for this operation");
			tips.push(`Check if your token has ${resource || "resource"} access permissions`);
			tips.push("Verify you're accessing the correct control plane");
			break;

		case 404:
			if (resource && operation.includes("get")) {
				tips.push(`The ${resource} ID provided may not exist`);
				tips.push(`Use list_${resource}s to verify the ${resource} exists`);
			} else if (operation.includes("control_plane")) {
				tips.push("The control plane ID may be incorrect");
				tips.push("Use list_control_planes to verify the control plane exists");
			} else {
				tips.push("The requested resource was not found");
				tips.push("Verify all IDs are correct and the resource exists");
			}
			break;

		case 429:
			tips.push("Rate limit exceeded - wait before making more requests");
			tips.push("Consider implementing request throttling in your application");
			break;

		case 500:
			tips.push("Internal server error from Kong Konnect");
			tips.push("Try the request again in a few moments");
			tips.push("Check Kong Konnect status page for service issues");
			break;

		default:
			if (typeof errObj?.message === "string" && errObj.message.includes("Network Error")) {
				tips.push("Check your internet connection");
				tips.push("Verify the Kong Konnect API endpoint is accessible");
				tips.push("Check if there are firewall restrictions");
			}
	}

	// Operation-specific tips
	if (operation.includes("create")) {
		tips.push("Verify all required fields are provided");
		tips.push("Check that field values meet Kong's validation requirements");
		tips.push("Ensure any referenced entities (services, routes) exist");
	}

	if (operation.includes("delete")) {
		tips.push("Verify the resource exists before attempting deletion");
		tips.push("Check if the resource has dependencies that prevent deletion");
	}

	if (operation.includes("certificate")) {
		tips.push("Ensure certificate and key are in valid PEM format");
		tips.push("Check that the certificate matches the private key");
		tips.push("Verify certificate is not expired");
	}

	// Add general tips if no specific ones were added
	if (tips.length === 0) {
		tips.push("Check the Kong Konnect documentation for this operation");
		tips.push("Verify your request parameters are correct");
		tips.push("Try the operation again with different parameters");
	}

	return tips;
}

/**
 * Format error for display to user with optional trace context
 */
export function formatError(error: unknown, traceContext?: TraceContext): string {
	if (error instanceof KongMCPError) {
		let formatted = `Error in ${error.context.operation}`;

		if (error.context.resource) {
			formatted += ` for ${error.context.resource}`;
		}

		if (error.context.resourceId) {
			formatted += ` (ID: ${error.context.resourceId})`;
		}

		formatted += `:\n${error.message}`;

		if (error.context.troubleshooting && error.context.troubleshooting.length > 0) {
			formatted += "\n\nTroubleshooting tips:";
			error.context.troubleshooting.forEach((tip, index) => {
				formatted += `\n${index + 1}. ${tip}`;
			});
		}

		// Add trace context if available
		const trace = traceContext || error.context.trace;
		if (trace) {
			formatted += "\n\nINFO: Trace Information:";
			if (trace.runId) {
				formatted += `\nTrace ID: ${trace.runId}`;
			}
			if (trace.traceUrl) {
				formatted += `\nView in LangSmith: ${trace.traceUrl}`;
			}
			if (trace.sessionId) {
				formatted += `\nSession ID: ${trace.sessionId}`;
			}
		}

		return formatted;
	}

	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

/**
 * Validate common Kong entity fields
 */
// biome-ignore lint/suspicious/noExplicitAny: validates loosely-typed user-supplied entity payloads; field access is defensive.
export function validateKongEntity(data: any, entityType: string): string[] {
	const errors: string[] = [];

	switch (entityType) {
		case "service":
			if (!data.name || typeof data.name !== "string") {
				errors.push("Service name is required and must be a string");
			}
			if (!data.url && (!data.host || !data.port)) {
				errors.push("Either URL or host+port must be provided for service");
			}
			if (data.port && (typeof data.port !== "number" || data.port < 1 || data.port > 65535)) {
				errors.push("Service port must be a number between 1 and 65535");
			}
			break;

		case "route":
			if (!data.name || typeof data.name !== "string") {
				errors.push("Route name is required and must be a string");
			}
			if (!data.paths && !data.hosts && !data.methods) {
				errors.push("Route must have at least one of: paths, hosts, or methods");
			}
			break;

		case "consumer":
			if (!data.username && !data.custom_id) {
				errors.push("Consumer must have either username or custom_id");
			}
			break;

		case "certificate":
			if (!data.cert || typeof data.cert !== "string") {
				errors.push("Certificate cert field is required and must be a string");
			}
			if (!data.key || typeof data.key !== "string") {
				errors.push("Certificate key field is required and must be a string");
			}
			break;

		case "plugin":
			if (!data.name || typeof data.name !== "string") {
				errors.push("Plugin name is required and must be a string");
			}
			if (!data.config || typeof data.config !== "object") {
				errors.push("Plugin config is required and must be an object");
			}
			break;
	}

	return errors;
}
