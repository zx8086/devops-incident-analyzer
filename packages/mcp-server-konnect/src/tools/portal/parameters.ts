import { z } from "zod";

/**
 * Standard pagination parameters for portal APIs
 */
export const portalPaginationSchema = z.object({
	pageSize: z.number().int().min(1).max(100).default(10).describe("Number of items per page"),
	pageNumber: z.number().int().min(1).optional().describe("Page number to retrieve"),
});

export const listApisParameters = z.object({
	pageSize: z.number().int().min(1).max(100).default(10).describe("Number of APIs per page"),
	pageNumber: z.number().int().min(1).optional().describe("Page number to retrieve"),
	filterName: z.string().optional().describe("Filter APIs by name (contains match)"),
	filterStatus: z.enum(["published", "unpublished"]).optional().describe("Filter by API publication status"),
	sort: z.string().optional().describe("Sort field and direction (e.g., 'name', 'created_at desc')"),
});

export const fetchApiParameters = z.object({
	apiIdOrSlug: z.string().describe("API ID or slug identifier"),
});

export const getApiActionsParameters = z.object({
	apiIdOrSlug: z.string().describe("API ID or slug identifier"),
});

export const listApiDocumentsParameters = z.object({
	apiIdOrSlug: z.string().describe("API ID or slug identifier"),
});

export const fetchApiDocumentParameters = z.object({
	apiIdOrSlug: z.string().describe("API ID or slug identifier"),
	documentIdOrSlug: z.string().describe("Document ID or slug identifier"),
	format: z.enum(["json", "yaml", "html", "markdown"]).default("json").describe("Requested document format"),
});

export const listApplicationsParameters = z.object({
	portalId: z.string().min(1).describe("Portal ID (obtainable from list-portals tool)"),
	pageSize: z.number().int().min(1).max(100).default(10).describe("Number of applications per page"),
	pageNumber: z.number().int().min(1).optional().describe("Page number to retrieve"),
	filterName: z.string().optional().describe("Filter applications by name"),
	filterAuthStrategy: z.string().optional().describe("Filter by authentication strategy ID"),
});

export const createApplicationParameters = z.object({
	name: z.string().min(1).describe("Application name"),
	description: z.string().optional().describe("Application description"),
	clientId: z.string().optional().describe("OAuth2 client ID (auto-generated if not provided)"),
	redirectUri: z.string().optional().describe("OAuth2 redirect URI"),
	authStrategyId: z.string().optional().describe("Authentication strategy ID"),
	scopes: z.array(z.string()).optional().describe("Requested OAuth2 scopes"),
});

export const getApplicationParameters = z.object({
	applicationId: z.string().describe("Application ID"),
});

export const updateApplicationParameters = z.object({
	applicationId: z.string().describe("Application ID"),
	name: z.string().optional().describe("New application name"),
	description: z.string().optional().describe("New application description"),
	redirectUri: z.string().optional().describe("New OAuth2 redirect URI"),
	scopes: z.array(z.string()).optional().describe("New OAuth2 scopes"),
});

export const deleteApplicationParameters = z.object({
	applicationId: z.string().describe("Application ID to delete"),
});

export const listApplicationRegistrationsParameters = z.object({
	applicationId: z.string().describe("Application ID"),
	pageSize: z.number().int().min(1).max(100).default(10).describe("Number of registrations per page"),
	pageNumber: z.number().int().min(1).optional().describe("Page number to retrieve"),
	filterStatus: z
		.enum(["pending", "approved", "rejected", "revoked"])
		.optional()
		.describe("Filter by registration status"),
	filterApiName: z.string().optional().describe("Filter by API name"),
});

export const createApplicationRegistrationParameters = z.object({
	applicationId: z.string().describe("Application ID"),
	apiId: z.string().describe("API ID to register for"),
	apiProductVersionId: z.string().optional().describe("Specific API product version ID"),
	requestReason: z.string().optional().describe("Reason for requesting API access"),
});

export const getApplicationRegistrationParameters = z.object({
	applicationId: z.string().describe("Application ID"),
	registrationId: z.string().describe("Registration ID"),
});

export const deleteApplicationRegistrationParameters = z.object({
	applicationId: z.string().describe("Application ID"),
	registrationId: z.string().describe("Registration ID to delete"),
});

export const listCredentialsParameters = z.object({
	applicationId: z.string().describe("Application ID"),
	pageSize: z.number().int().min(1).max(100).default(10).describe("Number of credentials per page"),
	pageNumber: z.number().int().min(1).optional().describe("Page number to retrieve"),
});

export const createCredentialParameters = z.object({
	applicationId: z.string().describe("Application ID"),
	credentialType: z.enum(["api_key", "oauth2", "basic_auth"]).describe("Type of credential to create"),
	name: z.string().optional().describe("Credential name/label"),
	scopes: z.array(z.string()).optional().describe("OAuth2 scopes for this credential"),
	expiresAt: z.string().optional().describe("Credential expiration date (ISO 8601)"),
});

export const updateCredentialParameters = z.object({
	applicationId: z.string().describe("Application ID"),
	credentialId: z.string().describe("Credential ID"),
	name: z.string().optional().describe("New credential name/label"),
	scopes: z.array(z.string()).optional().describe("New OAuth2 scopes"),
	expiresAt: z.string().optional().describe("New expiration date (ISO 8601)"),
});

export const deleteCredentialParameters = z.object({
	applicationId: z.string().describe("Application ID"),
	credentialId: z.string().describe("Credential ID to delete"),
});

export const regenerateApplicationSecretParameters = z.object({
	applicationId: z.string().describe("Application ID"),
});

export const registerDeveloperParameters = z.object({
	email: z.string().email().describe("Developer email address"),
	fullName: z.string().min(1).describe("Developer full name"),
	password: z.string().min(8).describe("Password (minimum 8 characters)"),
	organization: z.string().optional().describe("Developer organization"),
	customAttributes: z.record(z.string(), z.string()).optional().describe("Custom developer attributes"),
});

export const authenticateParameters = z.object({
	username: z.string().describe("Username or email"),
	password: z.string().describe("Password"),
});

export const getDeveloperMeParameters = z.object({
	// No parameters - gets current authenticated developer
});

export const logoutParameters = z.object({
	// No parameters - logs out current developer
});

export const queryApplicationAnalyticsParameters = z.object({
	applicationId: z.string().describe("Application ID"),
	metrics: z
		.array(z.enum(["request_count", "response_time", "error_rate", "success_rate", "bandwidth_usage"]))
		.describe("Metrics to query"),
	dimensions: z
		.array(z.enum(["time", "api", "status_code", "endpoint", "method"]))
		.optional()
		.describe("Dimensions to group by"),
	timeRange: z.enum(["1H", "6H", "12H", "24H", "7D", "30D"]).default("24H").describe("Time range for analytics data"),
	granularity: z.enum(["hour", "day", "week"]).default("hour").describe("Time granularity for data points"),
});

export type ListApisArgs = z.infer<typeof listApisParameters>;
export type FetchApiArgs = z.infer<typeof fetchApiParameters>;
export type GetApiActionsArgs = z.infer<typeof getApiActionsParameters>;
export type ListApiDocumentsArgs = z.infer<typeof listApiDocumentsParameters>;
export type FetchApiDocumentArgs = z.infer<typeof fetchApiDocumentParameters>;
export type ListApplicationsArgs = z.infer<typeof listApplicationsParameters>;
export type CreateApplicationArgs = z.infer<typeof createApplicationParameters>;
export type GetApplicationArgs = z.infer<typeof getApplicationParameters>;
export type UpdateApplicationArgs = z.infer<typeof updateApplicationParameters>;
export type DeleteApplicationArgs = z.infer<typeof deleteApplicationParameters>;
export type ListApplicationRegistrationsArgs = z.infer<typeof listApplicationRegistrationsParameters>;
export type CreateApplicationRegistrationArgs = z.infer<typeof createApplicationRegistrationParameters>;
export type GetApplicationRegistrationArgs = z.infer<typeof getApplicationRegistrationParameters>;
export type DeleteApplicationRegistrationArgs = z.infer<typeof deleteApplicationRegistrationParameters>;
export type ListCredentialsArgs = z.infer<typeof listCredentialsParameters>;
export type CreateCredentialArgs = z.infer<typeof createCredentialParameters>;
export type UpdateCredentialArgs = z.infer<typeof updateCredentialParameters>;
export type DeleteCredentialArgs = z.infer<typeof deleteCredentialParameters>;
export type RegenerateApplicationSecretArgs = z.infer<typeof regenerateApplicationSecretParameters>;
export type RegisterDeveloperArgs = z.infer<typeof registerDeveloperParameters>;
export type AuthenticateArgs = z.infer<typeof authenticateParameters>;
export type GetDeveloperMeArgs = z.infer<typeof getDeveloperMeParameters>;
export type LogoutArgs = z.infer<typeof logoutParameters>;
export type QueryApplicationAnalyticsArgs = z.infer<typeof queryApplicationAnalyticsParameters>;
