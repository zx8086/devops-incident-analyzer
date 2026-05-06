import type { MCPTool } from "../registry.js";
import * as portalOps from "./operations.js";
import * as parameters from "./parameters.js";
import type {
	AuthenticateArgs,
	CreateApplicationArgs,
	CreateApplicationRegistrationArgs,
	CreateCredentialArgs,
	DeleteApplicationArgs,
	DeleteApplicationRegistrationArgs,
	DeleteCredentialArgs,
	FetchApiArgs,
	FetchApiDocumentArgs,
	GetApiActionsArgs,
	GetApplicationArgs,
	GetApplicationRegistrationArgs,
	ListApiDocumentsArgs,
	ListApisArgs,
	ListApplicationRegistrationsArgs,
	ListApplicationsArgs,
	ListCredentialsArgs,
	QueryApplicationAnalyticsArgs,
	RegenerateApplicationSecretArgs,
	RegisterDeveloperArgs,
	UpdateApplicationArgs,
	UpdateCredentialArgs,
} from "./parameters.js";
import * as prompts from "./prompts.js";

export const portalTools = (): MCPTool[] => [
	{
		method: "list_portal_apis",
		name: "List Portal APIs",
		description: prompts.listApisPrompt(),
		parameters: parameters.listApisParameters,
		category: "portal",
		handler: async (args: ListApisArgs, { api }) =>
			portalOps.listApis(api, args.pageSize, args.pageNumber, args.filterName, args.filterStatus, args.sort),
	},
	{
		method: "fetch_portal_api",
		name: "Fetch Portal API",
		description: prompts.fetchApiPrompt(),
		parameters: parameters.fetchApiParameters,
		category: "portal",
		handler: async (args: FetchApiArgs, { api }) => portalOps.fetchApi(api, args.apiIdOrSlug),
	},
	{
		method: "get_portal_api_actions",
		name: "Get Portal API Actions",
		description: prompts.getApiActionsPrompt(),
		parameters: parameters.getApiActionsParameters,
		category: "portal",
		handler: async (args: GetApiActionsArgs, { api }) => portalOps.getApiActions(api, args.apiIdOrSlug),
	},
	{
		method: "list_portal_api_documents",
		name: "List Portal API Documents",
		description: prompts.listApiDocumentsPrompt(),
		parameters: parameters.listApiDocumentsParameters,
		category: "portal",
		handler: async (args: ListApiDocumentsArgs, { api }) => portalOps.listApiDocuments(api, args.apiIdOrSlug),
	},
	{
		method: "fetch_portal_api_document",
		name: "Fetch Portal API Document",
		description: prompts.fetchApiDocumentPrompt(),
		parameters: parameters.fetchApiDocumentParameters,
		category: "portal",
		handler: async (args: FetchApiDocumentArgs, { api }) =>
			portalOps.fetchApiDocument(api, args.apiIdOrSlug, args.documentIdOrSlug, args.format),
	},

	{
		method: "list_portal_applications",
		name: "List Portal Applications",
		description: prompts.listApplicationsPrompt(),
		parameters: parameters.listApplicationsParameters,
		category: "portal",
		handler: async (args: ListApplicationsArgs, { api }) =>
			portalOps.listApplications(
				api,
				args.portalId,
				args.pageSize,
				args.pageNumber,
				args.filterName,
				args.filterAuthStrategy,
			),
	},
	{
		method: "create_portal_application",
		name: "Create Portal Application",
		description: prompts.createApplicationPrompt(),
		parameters: parameters.createApplicationParameters,
		category: "portal",
		handler: async (args: CreateApplicationArgs, { api }) =>
			portalOps.createApplication(api, {
				name: args.name,
				description: args.description,
				clientId: args.clientId,
				redirectUri: args.redirectUri,
				authStrategyId: args.authStrategyId,
				scopes: args.scopes,
			}),
	},
	{
		method: "get_portal_application",
		name: "Get Portal Application",
		description: prompts.getApplicationPrompt(),
		parameters: parameters.getApplicationParameters,
		category: "portal",
		handler: async (args: GetApplicationArgs, { api }) => portalOps.getApplication(api, args.applicationId),
	},
	{
		method: "update_portal_application",
		name: "Update Portal Application",
		description: prompts.updateApplicationPrompt(),
		parameters: parameters.updateApplicationParameters,
		category: "portal",
		handler: async (args: UpdateApplicationArgs, { api }) =>
			portalOps.updateApplication(api, args.applicationId, {
				name: args.name,
				description: args.description,
				redirectUri: args.redirectUri,
				scopes: args.scopes,
			}),
	},
	{
		method: "delete_portal_application",
		name: "Delete Portal Application",
		description: prompts.deleteApplicationPrompt(),
		parameters: parameters.deleteApplicationParameters,
		category: "portal",
		handler: async (args: DeleteApplicationArgs, { api }) => portalOps.deleteApplication(api, args.applicationId),
	},

	{
		method: "list_portal_application_registrations",
		name: "List Portal Application Registrations",
		description: prompts.listApplicationRegistrationsPrompt(),
		parameters: parameters.listApplicationRegistrationsParameters,
		category: "portal",
		handler: async (args: ListApplicationRegistrationsArgs, { api }) =>
			portalOps.listApplicationRegistrations(
				api,
				args.applicationId,
				args.pageSize,
				args.pageNumber,
				args.filterStatus,
				args.filterApiName,
			),
	},
	{
		method: "create_portal_application_registration",
		name: "Create Portal Application Registration",
		description: prompts.createApplicationRegistrationPrompt(),
		parameters: parameters.createApplicationRegistrationParameters,
		category: "portal",
		handler: async (args: CreateApplicationRegistrationArgs, { api }) =>
			portalOps.createApplicationRegistration(api, args.applicationId, {
				apiId: args.apiId,
				apiProductVersionId: args.apiProductVersionId,
				requestReason: args.requestReason,
			}),
	},
	{
		method: "get_portal_application_registration",
		name: "Get Portal Application Registration",
		description: prompts.getApplicationRegistrationPrompt(),
		parameters: parameters.getApplicationRegistrationParameters,
		category: "portal",
		handler: async (args: GetApplicationRegistrationArgs, { api }) =>
			portalOps.getApplicationRegistration(api, args.applicationId, args.registrationId),
	},
	{
		method: "delete_portal_application_registration",
		name: "Delete Portal Application Registration",
		description: prompts.deleteApplicationRegistrationPrompt(),
		parameters: parameters.deleteApplicationRegistrationParameters,
		category: "portal",
		handler: async (args: DeleteApplicationRegistrationArgs, { api }) =>
			portalOps.deleteApplicationRegistration(api, args.applicationId, args.registrationId),
	},

	{
		method: "list_portal_credentials",
		name: "List Portal Credentials",
		description: prompts.listCredentialsPrompt(),
		parameters: parameters.listCredentialsParameters,
		category: "portal",
		handler: async (args: ListCredentialsArgs, { api }) =>
			portalOps.listCredentials(api, args.applicationId, args.pageSize, args.pageNumber),
	},
	{
		method: "create_portal_credential",
		name: "Create Portal Credential",
		description: prompts.createCredentialPrompt(),
		parameters: parameters.createCredentialParameters,
		category: "portal",
		handler: async (args: CreateCredentialArgs, { api }) =>
			portalOps.createCredential(api, args.applicationId, {
				credentialType: args.credentialType,
				name: args.name,
				scopes: args.scopes,
				expiresAt: args.expiresAt,
			}),
	},
	{
		method: "update_portal_credential",
		name: "Update Portal Credential",
		description: prompts.updateCredentialPrompt(),
		parameters: parameters.updateCredentialParameters,
		category: "portal",
		handler: async (args: UpdateCredentialArgs, { api }) =>
			portalOps.updateCredential(api, args.applicationId, args.credentialId, {
				name: args.name,
				scopes: args.scopes,
				expiresAt: args.expiresAt,
			}),
	},
	{
		method: "delete_portal_credential",
		name: "Delete Portal Credential",
		description: prompts.deleteCredentialPrompt(),
		parameters: parameters.deleteCredentialParameters,
		category: "portal",
		handler: async (args: DeleteCredentialArgs, { api }) =>
			portalOps.deleteCredential(api, args.applicationId, args.credentialId),
	},
	{
		method: "regenerate_portal_application_secret",
		name: "Regenerate Portal Application Secret",
		description: prompts.regenerateApplicationSecretPrompt(),
		parameters: parameters.regenerateApplicationSecretParameters,
		category: "portal",
		handler: async (args: RegenerateApplicationSecretArgs, { api }) =>
			portalOps.regenerateApplicationSecret(api, args.applicationId),
	},

	{
		method: "register_portal_developer",
		name: "Register Portal Developer",
		description: prompts.registerDeveloperPrompt(),
		parameters: parameters.registerDeveloperParameters,
		category: "portal",
		handler: async (args: RegisterDeveloperArgs, { api }) =>
			portalOps.registerDeveloper(api, {
				email: args.email,
				fullName: args.fullName,
				password: args.password,
				organization: args.organization,
				customAttributes: args.customAttributes,
			}),
	},
	{
		method: "authenticate_portal_developer",
		name: "Authenticate Portal Developer",
		description: prompts.authenticatePrompt(),
		parameters: parameters.authenticateParameters,
		category: "portal",
		handler: async (args: AuthenticateArgs, { api }) => portalOps.authenticate(api, args.username, args.password),
	},
	{
		method: "get_portal_developer_me",
		name: "Get Portal Developer Profile",
		description: prompts.getDeveloperMePrompt(),
		parameters: parameters.getDeveloperMeParameters,
		category: "portal",
		handler: async (_args, { api }) => portalOps.getDeveloperMe(api),
	},
	{
		method: "logout_portal_developer",
		name: "Logout Portal Developer",
		description: prompts.logoutPrompt(),
		parameters: parameters.logoutParameters,
		category: "portal",
		handler: async (_args, { api }) => portalOps.logout(api),
	},

	{
		method: "query_portal_application_analytics",
		name: "Query Portal Application Analytics",
		description: prompts.queryApplicationAnalyticsPrompt(),
		parameters: parameters.queryApplicationAnalyticsParameters,
		category: "portal",
		handler: async (args: QueryApplicationAnalyticsArgs, { api }) =>
			portalOps.queryApplicationAnalytics(api, args.applicationId, {
				metrics: args.metrics,
				dimensions: args.dimensions,
				timeRange: args.timeRange,
				granularity: args.granularity,
			}),
	},
];
