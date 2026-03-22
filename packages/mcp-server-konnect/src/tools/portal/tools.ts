import type { z } from "zod";
import * as parameters from "./parameters.js";
import * as prompts from "./prompts.js";

export type PortalTool = {
	method: string;
	name: string;
	description: string;
	parameters: z.ZodObject<any, any, any, any>;
	category: string;
};

export const portalTools = (): PortalTool[] => [
	// =========================
	// Portal API Operations
	// =========================
	{
		method: "list_portal_apis",
		name: "List Portal APIs",
		description: prompts.listApisPrompt(),
		parameters: parameters.listApisParameters(),
		category: "portal",
	},
	{
		method: "fetch_portal_api",
		name: "Fetch Portal API",
		description: prompts.fetchApiPrompt(),
		parameters: parameters.fetchApiParameters(),
		category: "portal",
	},
	{
		method: "get_portal_api_actions",
		name: "Get Portal API Actions",
		description: prompts.getApiActionsPrompt(),
		parameters: parameters.getApiActionsParameters(),
		category: "portal",
	},
	{
		method: "list_portal_api_documents",
		name: "List Portal API Documents",
		description: prompts.listApiDocumentsPrompt(),
		parameters: parameters.listApiDocumentsParameters(),
		category: "portal",
	},
	{
		method: "fetch_portal_api_document",
		name: "Fetch Portal API Document",
		description: prompts.fetchApiDocumentPrompt(),
		parameters: parameters.fetchApiDocumentParameters(),
		category: "portal",
	},

	// =========================
	// Application Management Operations
	// =========================
	{
		method: "list_portal_applications",
		name: "List Portal Applications",
		description: prompts.listApplicationsPrompt(),
		parameters: parameters.listApplicationsParameters(),
		category: "portal",
	},
	{
		method: "create_portal_application",
		name: "Create Portal Application",
		description: prompts.createApplicationPrompt(),
		parameters: parameters.createApplicationParameters(),
		category: "portal",
	},
	{
		method: "get_portal_application",
		name: "Get Portal Application",
		description: prompts.getApplicationPrompt(),
		parameters: parameters.getApplicationParameters(),
		category: "portal",
	},
	{
		method: "update_portal_application",
		name: "Update Portal Application",
		description: prompts.updateApplicationPrompt(),
		parameters: parameters.updateApplicationParameters(),
		category: "portal",
	},
	{
		method: "delete_portal_application",
		name: "Delete Portal Application",
		description: prompts.deleteApplicationPrompt(),
		parameters: parameters.deleteApplicationParameters(),
		category: "portal",
	},

	// =========================
	// Application Registration Operations
	// =========================
	{
		method: "list_portal_application_registrations",
		name: "List Portal Application Registrations",
		description: prompts.listApplicationRegistrationsPrompt(),
		parameters: parameters.listApplicationRegistrationsParameters(),
		category: "portal",
	},
	{
		method: "create_portal_application_registration",
		name: "Create Portal Application Registration",
		description: prompts.createApplicationRegistrationPrompt(),
		parameters: parameters.createApplicationRegistrationParameters(),
		category: "portal",
	},
	{
		method: "get_portal_application_registration",
		name: "Get Portal Application Registration",
		description: prompts.getApplicationRegistrationPrompt(),
		parameters: parameters.getApplicationRegistrationParameters(),
		category: "portal",
	},
	{
		method: "delete_portal_application_registration",
		name: "Delete Portal Application Registration",
		description: prompts.deleteApplicationRegistrationPrompt(),
		parameters: parameters.deleteApplicationRegistrationParameters(),
		category: "portal",
	},

	// =========================
	// Credential Management Operations
	// =========================
	{
		method: "list_portal_credentials",
		name: "List Portal Credentials",
		description: prompts.listCredentialsPrompt(),
		parameters: parameters.listCredentialsParameters(),
		category: "portal",
	},
	{
		method: "create_portal_credential",
		name: "Create Portal Credential",
		description: prompts.createCredentialPrompt(),
		parameters: parameters.createCredentialParameters(),
		category: "portal",
	},
	{
		method: "update_portal_credential",
		name: "Update Portal Credential",
		description: prompts.updateCredentialPrompt(),
		parameters: parameters.updateCredentialParameters(),
		category: "portal",
	},
	{
		method: "delete_portal_credential",
		name: "Delete Portal Credential",
		description: prompts.deleteCredentialPrompt(),
		parameters: parameters.deleteCredentialParameters(),
		category: "portal",
	},
	{
		method: "regenerate_portal_application_secret",
		name: "Regenerate Portal Application Secret",
		description: prompts.regenerateApplicationSecretPrompt(),
		parameters: parameters.regenerateApplicationSecretParameters(),
		category: "portal",
	},

	// =========================
	// Developer Authentication Operations
	// =========================
	{
		method: "register_portal_developer",
		name: "Register Portal Developer",
		description: prompts.registerDeveloperPrompt(),
		parameters: parameters.registerDeveloperParameters(),
		category: "portal",
	},
	{
		method: "authenticate_portal_developer",
		name: "Authenticate Portal Developer",
		description: prompts.authenticatePrompt(),
		parameters: parameters.authenticateParameters(),
		category: "portal",
	},
	{
		method: "get_portal_developer_me",
		name: "Get Portal Developer Profile",
		description: prompts.getDeveloperMePrompt(),
		parameters: parameters.getDeveloperMeParameters(),
		category: "portal",
	},
	{
		method: "logout_portal_developer",
		name: "Logout Portal Developer",
		description: prompts.logoutPrompt(),
		parameters: parameters.logoutParameters(),
		category: "portal",
	},

	// =========================
	// Application Analytics Operations
	// =========================
	{
		method: "query_portal_application_analytics",
		name: "Query Portal Application Analytics",
		description: prompts.queryApplicationAnalyticsPrompt(),
		parameters: parameters.queryApplicationAnalyticsParameters(),
		category: "portal",
	},
];
