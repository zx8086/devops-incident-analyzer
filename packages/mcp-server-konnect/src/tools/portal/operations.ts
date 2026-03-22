import type { KongApi } from "../../api/kong-api.js";

/**
 * List published APIs in the developer portal
 */
export async function listApis(
  api: KongApi,
  pageSize = 10,
  pageNumber?: number,
  filterName?: string,
  filterStatus?: string,
  sort?: string,
) {
  try {
    const result = await api.listPortalApis(
      pageSize,
      pageNumber,
      filterName,
      filterStatus,
      sort,
    );

    return {
      metadata: {
        pagination: {
          pageSize: pageSize,
          pageNumber: pageNumber || 1,
          totalPages: result.meta?.page?.total || 1,
          totalItems: result.meta?.page?.total_count || 0,
        },
        filters: {
          name: filterName,
          status: filterStatus,
          sort: sort,
        },
      },
      apis:
        result.data?.map((api: any) => ({
          apiId: api.id,
          name: api.name,
          description: api.description,
          version: api.version,
          status: api.status,
          slug: api.slug,
          createdAt: api.created_at,
          updatedAt: api.updated_at,
          metrics: {
            applications: api.application_count || 0,
            registrations: api.registration_count || 0,
          },
        })) || [],
      relatedTools: [
        "Use fetch-api to get detailed information about specific APIs",
        "Use get-api-actions to check available actions for APIs",
        "Use list-api-documents to explore API documentation",
      ],
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Get detailed information about a specific API
 */
export async function fetchApi(api: KongApi, apiIdOrSlug: string) {
  try {
    const result = await api.fetchPortalApi(apiIdOrSlug);

    return {
      api: {
        apiId: result.id,
        name: result.name,
        description: result.description,
        version: result.version,
        status: result.status,
        slug: result.slug,
        documentation: {
          hasDocumentation: result.has_documentation || false,
          documentCount: result.document_count || 0,
        },
        endpoints: result.endpoints || [],
        authentication: {
          required: result.auth_required || false,
          strategies: result.auth_strategies || [],
        },
        rateLimit: result.rate_limit || {},
        tags: result.tags || [],
        metadata: {
          createdAt: result.created_at,
          updatedAt: result.updated_at,
          publishedAt: result.published_at,
        },
      },
      relatedTools: [
        "Use create-application-registration to register apps for this API",
        "Use list-api-documents to browse documentation",
        "Use get-api-actions to check permissions",
      ],
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Check what actions a developer can perform on an API
 */
export async function getApiActions(api: KongApi, apiIdOrSlug: string) {
  try {
    const result = await api.getPortalApiActions(apiIdOrSlug);

    return {
      apiId: apiIdOrSlug,
      availableActions: {
        view: result.can_view || false,
        register: result.can_register || false,
        viewDocumentation: result.can_view_documentation || false,
        requestAccess: result.can_request_access || false,
      },
      requirements: {
        authentication: result.requires_authentication || false,
        approval: result.requires_approval || false,
      },
      relatedTools: [
        "Use authenticate to log in if authentication required",
        "Use create-application-registration if registration available",
      ],
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Get the documentation structure for an API
 */
export async function listApiDocuments(api: KongApi, apiIdOrSlug: string) {
  try {
    const result = await api.listPortalApiDocuments(apiIdOrSlug);

    return {
      apiId: apiIdOrSlug,
      documentTree: {
        sections: result.sections || [],
        pages: result.pages || [],
        navigation: result.navigation || {},
      },
      formats: ["json", "yaml", "html", "markdown"],
      relatedTools: ["Use fetch-api-document to get specific document content"],
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Fetch a specific API document
 */
export async function fetchApiDocument(
  api: KongApi,
  apiIdOrSlug: string,
  documentIdOrSlug: string,
  format = "json",
) {
  try {
    const result = await api.fetchPortalApiDocument(
      apiIdOrSlug,
      documentIdOrSlug,
      format,
    );

    return {
      document: {
        content: result.content || result,
        title: result.title,
        type: result.type || "documentation",
        format: format,
        lastModified: result.updated_at,
      },
      relatedTools: [
        "Use list-api-documents to explore other documentation pages",
      ],
    };
  } catch (error) {
    throw error;
  }
}

/**
 * List applications for the current developer
 */
export async function listApplications(
  api: KongApi,
  portalId: string,
  pageSize = 10,
  pageNumber?: number,
  filterName?: string,
  filterAuthStrategy?: string,
) {
  try {
    const portalClient = api.createPortalClient(portalId);
    const result = await portalClient.listApplications(
      pageSize,
      pageNumber,
      filterName,
      filterAuthStrategy,
    );

    return {
      metadata: {
        pagination: {
          pageSize: pageSize,
          pageNumber: pageNumber || 1,
          totalPages: result.meta?.page?.total || 1,
          totalItems: result.meta?.page?.total_count || 0,
        },
        filters: {
          name: filterName,
          authStrategy: filterAuthStrategy,
        },
      },
      applications:
        result.data?.map((app: any) => ({
          applicationId: app.id,
          name: app.name,
          description: app.description,
          status: app.status,
          authStrategy: app.auth_strategy?.name,
          createdAt: app.created_at,
          registrationCount: app.registration_count || 0,
          credentialCount: app.credential_count || 0,
        })) || [],
      relatedTools: [
        "Use create-application to register new applications",
        "Use get-application for detailed application info",
        "Use list-application-registrations to see API access",
      ],
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Create a new application
 */
export async function createApplication(
  api: KongApi,
  applicationData: {
    name: string;
    description?: string;
    clientId?: string;
    redirectUri?: string;
    authStrategyId?: string;
    scopes?: string[];
  },
) {
  try {
    const requestData = {
      name: applicationData.name,
      description: applicationData.description,
      client_id: applicationData.clientId,
      redirect_uri: applicationData.redirectUri,
      auth_strategy_id: applicationData.authStrategyId,
      scopes: applicationData.scopes,
    };

    const result = await api.createPortalApplication(requestData);

    return {
      success: true,
      application: {
        applicationId: result.id,
        name: result.name,
        description: result.description,
        clientId: result.client_id,
        clientSecret: result.client_secret,
        authStrategy: result.auth_strategy,
        scopes: result.scopes,
        metadata: {
          createdAt: result.created_at,
        },
      },
      message: `Application '${result.name}' created successfully with ID: ${result.id}`,
      relatedTools: [
        "Use create-application-registration to register for API access",
        "Use create-credential to generate API credentials",
        "Use list-applications to see all your applications",
      ],
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Get detailed information about an application
 */
export async function getApplication(api: KongApi, applicationId: string) {
  try {
    const result = await api.getPortalApplication(applicationId);

    return {
      application: {
        applicationId: result.id,
        name: result.name,
        description: result.description,
        status: result.status,
        authStrategy: result.auth_strategy,
        oauth: {
          clientId: result.client_id,
          redirectUri: result.redirect_uri,
          scopes: result.scopes,
        },
        registrations:
          result.registrations?.map((reg: any) => ({
            registrationId: reg.id,
            apiName: reg.api_name,
            status: reg.status,
          })) || [],
        credentials:
          result.credentials?.map((cred: any) => ({
            credentialId: cred.id,
            type: cred.type,
            status: cred.status,
          })) || [],
        usage: {
          requestCount: result.request_count || 0,
          lastUsed: result.last_used_at,
        },
        metadata: {
          createdAt: result.created_at,
          updatedAt: result.updated_at,
        },
      },
      relatedTools: [
        "Use update-application to modify settings",
        "Use list-application-registrations for API access details",
        "Use list-credentials for credential management",
      ],
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Update an application
 */
export async function updateApplication(
  api: KongApi,
  applicationId: string,
  applicationData: {
    name?: string;
    description?: string;
    redirectUri?: string;
    scopes?: string[];
  },
) {
  try {
    const requestData: any = {};

    if (applicationData.name !== undefined)
      requestData.name = applicationData.name;
    if (applicationData.description !== undefined)
      requestData.description = applicationData.description;
    if (applicationData.redirectUri !== undefined)
      requestData.redirect_uri = applicationData.redirectUri;
    if (applicationData.scopes !== undefined)
      requestData.scopes = applicationData.scopes;

    const result = await api.updatePortalApplication(
      applicationId,
      requestData,
    );

    return {
      success: true,
      application: {
        applicationId: result.id,
        name: result.name,
        description: result.description,
        redirectUri: result.redirect_uri,
        scopes: result.scopes,
        metadata: {
          updatedAt: result.updated_at,
        },
      },
      message: `Application '${result.name}' updated successfully`,
      relatedTools: ["Use get-application to see all updated details"],
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Delete an application
 */
export async function deleteApplication(api: KongApi, applicationId: string) {
  try {
    await api.deletePortalApplication(applicationId);

    return {
      success: true,
      message: `Application ${applicationId} deleted successfully`,
      warning:
        "All API registrations and credentials for this application have been removed",
      relatedTools: [
        "Use list-applications to see remaining applications",
        "Use create-application to create a new application",
      ],
    };
  } catch (error) {
    throw error;
  }
}

/**
 * List API registrations for an application
 */
export async function listApplicationRegistrations(
  api: KongApi,
  applicationId: string,
  pageSize = 10,
  pageNumber?: number,
  filterStatus?: string,
  filterApiName?: string,
) {
  try {
    const result = await api.listPortalApplicationRegistrations(
      applicationId,
      pageSize,
      pageNumber,
      filterStatus,
      filterApiName,
    );

    return {
      metadata: {
        applicationId: applicationId,
        pagination: {
          pageSize: pageSize,
          pageNumber: pageNumber || 1,
          totalPages: result.meta?.page?.total || 1,
          totalItems: result.meta?.page?.total_count || 0,
        },
        filters: {
          status: filterStatus,
          apiName: filterApiName,
        },
      },
      registrations:
        result.data?.map((reg: any) => ({
          registrationId: reg.id,
          apiId: reg.api_id,
          apiName: reg.api_name,
          status: reg.status,
          approvedAt: reg.approved_at,
          expiresAt: reg.expires_at,
          permissions: reg.permissions || [],
          usage: {
            requestCount: reg.request_count || 0,
            lastUsed: reg.last_used_at,
          },
        })) || [],
      relatedTools: [
        "Use create-application-registration to register for more APIs",
        "Use get-application-registration for detailed registration info",
        "Use delete-application-registration to remove access",
      ],
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Create an application registration for API access
 */
export async function createApplicationRegistration(
  api: KongApi,
  applicationId: string,
  registrationData: {
    apiId: string;
    apiProductVersionId?: string;
    requestReason?: string;
  },
) {
  try {
    const requestData = {
      api_id: registrationData.apiId,
      api_product_version_id: registrationData.apiProductVersionId,
      request_reason: registrationData.requestReason,
    };

    const result = await api.createPortalApplicationRegistration(
      applicationId,
      requestData,
    );

    return {
      success: true,
      registration: {
        registrationId: result.id,
        status: result.status,
        apiId: result.api_id,
        apiName: result.api_name,
        permissions: result.permissions || [],
        approvalProcess: {
          requiresApproval: result.requires_approval || false,
          approvalStatus: result.approval_status,
        },
      },
      message: result.requires_approval
        ? "Registration submitted for approval"
        : "API access granted immediately",
      relatedTools: [
        "Use get-application-registration to monitor approval status",
        "Use list-credentials to generate API keys after approval",
      ],
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Get details about a specific registration
 */
export async function getApplicationRegistration(
  api: KongApi,
  applicationId: string,
  registrationId: string,
) {
  try {
    const result = await api.getPortalApplicationRegistration(
      applicationId,
      registrationId,
    );

    return {
      registration: {
        registrationId: result.id,
        status: result.status,
        apiDetails: {
          apiId: result.api_id,
          apiName: result.api_name,
          version: result.api_version,
        },
        permissions: result.permissions || [],
        usage: {
          requestCount: result.request_count || 0,
          lastUsed: result.last_used_at,
          rateLimit: result.rate_limit,
        },
        approvalHistory: result.approval_history || [],
        expirationInfo: {
          expiresAt: result.expires_at,
          renewable: result.renewable || false,
        },
      },
      relatedTools: [
        "Use delete-application-registration to remove access",
        "Use list-credentials to manage API keys for this registration",
      ],
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Delete an application registration
 */
export async function deleteApplicationRegistration(
  api: KongApi,
  applicationId: string,
  registrationId: string,
) {
  try {
    await api.deletePortalApplicationRegistration(
      applicationId,
      registrationId,
    );

    return {
      success: true,
      message: `Registration ${registrationId} removed successfully`,
      relatedTools: [
        "Use list-application-registrations to see remaining API access",
        "Use create-application-registration to register for other APIs",
      ],
    };
  } catch (error) {
    throw error;
  }
}

/**
 * List credentials for an application
 */
export async function listCredentials(
  api: KongApi,
  applicationId: string,
  pageSize = 10,
  pageNumber?: number,
) {
  try {
    const result = await api.listPortalCredentials(
      applicationId,
      pageSize,
      pageNumber,
    );

    return {
      metadata: {
        applicationId: applicationId,
        pagination: {
          pageSize: pageSize,
          pageNumber: pageNumber || 1,
          totalPages: result.meta?.page?.total || 1,
          totalItems: result.meta?.page?.total_count || 0,
        },
      },
      credentials:
        result.data?.map((cred: any) => ({
          credentialId: cred.id,
          name: cred.name,
          type: cred.type,
          status: cred.status,
          createdAt: cred.created_at,
          expiresAt: cred.expires_at,
          lastUsed: cred.last_used_at,
          scopes: cred.scopes || [],
        })) || [],
      relatedTools: [
        "Use create-credential to generate new API keys",
        "Use update-credential to modify existing credentials",
        "Use delete-credential to revoke access",
      ],
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Create new credentials for an application
 */
export async function createCredential(
  api: KongApi,
  applicationId: string,
  credentialData: {
    credentialType: string;
    name?: string;
    scopes?: string[];
    expiresAt?: string;
  },
) {
  try {
    const requestData = {
      type: credentialData.credentialType,
      name: credentialData.name,
      scopes: credentialData.scopes,
      expires_at: credentialData.expiresAt,
    };

    const result = await api.createPortalCredential(applicationId, requestData);

    return {
      success: true,
      credential: {
        credentialId: result.id,
        type: result.type,
        key: result.key,
        secret: result.secret,
        scopes: result.scopes,
        expiresAt: result.expires_at,
      },
      message: `${result.type} credential created successfully`,
      security:
        "WARNING: Store the secret securely - it will not be shown again",
      relatedTools: [
        "Use list-credentials to see all credentials",
        "Use update-credential to modify settings",
      ],
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Update credential configuration
 */
export async function updateCredential(
  api: KongApi,
  applicationId: string,
  credentialId: string,
  credentialData: {
    name?: string;
    scopes?: string[];
    expiresAt?: string;
  },
) {
  try {
    const requestData: any = {};

    if (credentialData.name !== undefined)
      requestData.name = credentialData.name;
    if (credentialData.scopes !== undefined)
      requestData.scopes = credentialData.scopes;
    if (credentialData.expiresAt !== undefined)
      requestData.expires_at = credentialData.expiresAt;

    const result = await api.updatePortalCredential(
      applicationId,
      credentialId,
      requestData,
    );

    return {
      success: true,
      credential: {
        credentialId: result.id,
        name: result.name,
        scopes: result.scopes,
        expiresAt: result.expires_at,
      },
      message: "Credential updated successfully",
      relatedTools: ["Use list-credentials to see updated credential"],
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Delete a credential
 */
export async function deleteCredential(
  api: KongApi,
  applicationId: string,
  credentialId: string,
) {
  try {
    await api.deletePortalCredential(applicationId, credentialId);

    return {
      success: true,
      message: `Credential ${credentialId} deleted successfully`,
      warning: "API access using this credential has been revoked",
      relatedTools: [
        "Use list-credentials to see remaining credentials",
        "Use create-credential to generate new credentials",
      ],
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Regenerate application secret
 */
export async function regenerateApplicationSecret(
  api: KongApi,
  applicationId: string,
) {
  try {
    const result = await api.regeneratePortalApplicationSecret(applicationId);

    return {
      success: true,
      secret: {
        clientSecret: result.client_secret,
        generatedAt: result.generated_at,
        expiresAt: result.expires_at,
      },
      message: "Client secret regenerated successfully",
      security:
        "WARNING: Update your applications immediately with the new secret",
      relatedTools: ["Use get-application to see updated application details"],
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Register a new developer
 */
export async function registerDeveloper(
  api: KongApi,
  developerData: {
    email: string;
    fullName: string;
    password: string;
    organization?: string;
    customAttributes?: Record<string, string>;
  },
) {
  try {
    const requestData = {
      email: developerData.email,
      full_name: developerData.fullName,
      password: developerData.password,
      organization: developerData.organization,
      custom_attributes: developerData.customAttributes,
    };

    const result = await api.registerPortalDeveloper(requestData);

    return {
      success: true,
      developer: {
        developerId: result.id,
        email: result.email,
        fullName: result.full_name,
        status: result.status,
        organization: result.organization,
        verificationRequired: result.email_verification_required || false,
      },
      message: "Developer account created successfully",
      relatedTools: [
        "Use authenticate to log in to your new account",
        "Use get-developer-me to view your profile",
      ],
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Authenticate a developer
 */
export async function authenticate(
  api: KongApi,
  username: string,
  password: string,
) {
  try {
    const credentials = { username, password };
    const result = await api.authenticatePortalDeveloper(credentials);

    return {
      success: true,
      session: {
        token: result.token,
        expiresAt: result.expires_at,
        developerId: result.developer_id,
        permissions: result.permissions || [],
      },
      developer: {
        developerId: result.developer_id,
        email: result.email,
        fullName: result.full_name,
      },
      message: `Welcome back, ${result.full_name}!`,
      relatedTools: [
        "Use get-developer-me to view your profile",
        "Use list-applications to manage your applications",
      ],
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Get current developer profile
 */
export async function getDeveloperMe(api: KongApi) {
  try {
    const result = await api.getPortalDeveloperMe();

    return {
      developer: {
        developerId: result.id,
        email: result.email,
        fullName: result.full_name,
        organization: result.organization,
        status: result.status,
        permissions: result.permissions || [],
        applicationCount: result.application_count || 0,
        lastLogin: result.last_login_at,
        customAttributes: result.custom_attributes || {},
      },
      relatedTools: [
        "Use list-applications to manage your applications",
        "Use logout to end your session",
      ],
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Logout current developer
 */
export async function logout(api: KongApi) {
  try {
    await api.logoutPortalDeveloper();

    return {
      success: true,
      message: "Logged out successfully",
      relatedTools: [
        "Use list-apis to browse public APIs",
        "Use authenticate to log in again",
      ],
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Query application analytics
 */
export async function queryApplicationAnalytics(
  api: KongApi,
  applicationId: string,
  analyticsQuery: {
    metrics: string[];
    dimensions?: string[];
    timeRange?: string;
    granularity?: string;
  },
) {
  try {
    const requestData = {
      metrics: analyticsQuery.metrics,
      dimensions: analyticsQuery.dimensions,
      time_range: analyticsQuery.timeRange || "24H",
      granularity: analyticsQuery.granularity || "hour",
    };

    const result = await api.queryPortalApplicationAnalytics(
      applicationId,
      requestData,
    );

    return {
      metadata: {
        applicationId: applicationId,
        query: requestData,
        dataRetention: "90 days",
        rateLimit: "100 requests/minute",
      },
      analytics: {
        summary: result.summary || {},
        timeseries: result.data || [],
        breakdowns: result.breakdowns || {},
        trends: result.trends || {},
      },
      insights: result.insights || [],
      relatedTools: [
        "Use get-application to see application details",
        "Use list-application-registrations to understand API usage",
      ],
    };
  } catch (error) {
    throw error;
  }
}
