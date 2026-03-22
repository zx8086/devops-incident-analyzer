// =========================
// Portal API Operations
// =========================

export const listApisPrompt = () => `
List published APIs available in the Kong developer portal.

INPUT:
  - pageSize: Number - APIs per page (1-100, default: 10)
  - pageNumber: Number (optional) - Page to retrieve
  - filterName: String (optional) - Filter by API name (contains match)
  - filterStatus: String (optional) - Filter by status: "published" or "unpublished"
  - sort: String (optional) - Sort field and direction (e.g., "name", "created_at desc")

OUTPUT:
  - metadata: Object - Pagination info and total count
  - apis: Array - List of published APIs including:
    - apiId: String - Unique API identifier
    - name: String - API display name
    - description: String - API description
    - version: String - API version
    - status: String - Publication status
    - slug: String - URL-friendly identifier
    - createdAt: String - Creation timestamp
    - updatedAt: String - Last update timestamp
    - metrics: Object - Basic usage statistics
  - relatedTools: Array - Suggested next steps for API exploration
`;

export const fetchApiPrompt = () => `
Get detailed information about a specific API in the developer portal.

INPUT:
  - apiIdOrSlug: String - API ID or slug identifier

OUTPUT:
  - api: Object - Complete API information including:
    - apiId: String - Unique identifier
    - name: String - API name
    - description: String - Detailed description
    - version: String - Current version
    - status: String - Publication status
    - documentation: Object - Documentation metadata
    - endpoints: Array - Available API endpoints
    - authentication: Object - Auth requirements
    - rateLimit: Object - Rate limiting information
    - tags: Array - API categorization tags
    - metadata: Object - Creation and update info
  - relatedTools: Array - Tools for documentation, registration, and credentials
`;

export const getApiActionsPrompt = () => `
Check what actions a developer can perform on a specific API.

INPUT:
  - apiIdOrSlug: String - API ID or slug identifier

OUTPUT:
  - apiId: String - API identifier
  - availableActions: Array - Permitted actions including:
    - view: Boolean - Can view API details
    - register: Boolean - Can register applications
    - viewDocumentation: Boolean - Can access documentation
    - requestAccess: Boolean - Can request API access
  - requirements: Object - Requirements for each action
  - relatedTools: Array - Tools for performing available actions
`;

export const listApiDocumentsPrompt = () => `
Get the documentation structure for a specific API.

INPUT:
  - apiIdOrSlug: String - API ID or slug identifier

OUTPUT:
  - apiId: String - API identifier
  - documentTree: Object - Hierarchical documentation structure including:
    - sections: Array - Main documentation sections
    - pages: Array - Individual documentation pages
    - navigation: Object - Documentation navigation structure
  - formats: Array - Available document formats (json, yaml, html, markdown)
  - relatedTools: Array - Tools for fetching specific documents
`;

export const fetchApiDocumentPrompt = () => `
Fetch a specific API document in the requested format.

INPUT:
  - apiIdOrSlug: String - API ID or slug identifier
  - documentIdOrSlug: String - Document ID or slug
  - format: String - Document format: json, yaml, html, markdown (default: json)

OUTPUT:
  - document: Object - Document content and metadata including:
    - content: String - Document content in requested format
    - title: String - Document title
    - type: String - Document type (openapi, guide, reference)
    - format: String - Content format
    - lastModified: String - Last modification date
  - relatedTools: Array - Tools for exploring related documentation
`;

// =========================
// Application Management Operations
// =========================

export const listApplicationsPrompt = () => `
List applications registered by the current developer.

INPUT:
  - pageSize: Number - Applications per page (1-100, default: 10)
  - pageNumber: Number (optional) - Page to retrieve
  - filterName: String (optional) - Filter by application name
  - filterAuthStrategy: String (optional) - Filter by authentication strategy ID

OUTPUT:
  - metadata: Object - Pagination and total count
  - applications: Array - List of applications including:
    - applicationId: String - Unique identifier
    - name: String - Application name
    - description: String - Application description
    - status: String - Application status (active, suspended)
    - authStrategy: String - Authentication strategy
    - createdAt: String - Creation timestamp
    - registrationCount: Number - Number of API registrations
    - credentialCount: Number - Number of active credentials
  - relatedTools: Array - Tools for managing applications and registrations
`;

export const createApplicationPrompt = () => `
Create a new application for API access.

INPUT:
  - name: String - Application name
  - description: String (optional) - Application description
  - clientId: String (optional) - OAuth2 client ID (auto-generated if not provided)
  - redirectUri: String (optional) - OAuth2 redirect URI
  - authStrategyId: String (optional) - Authentication strategy ID
  - scopes: Array (optional) - Requested OAuth2 scopes

OUTPUT:
  - success: Boolean - Whether creation succeeded
  - application: Object - Created application details including:
    - applicationId: String - Unique identifier
    - name: String - Application name
    - clientId: String - OAuth2 client ID
    - clientSecret: String - OAuth2 client secret (if applicable)
    - authStrategy: Object - Authentication configuration
    - scopes: Array - Granted scopes
  - message: String - Success message
  - relatedTools: Array - Next steps for API registration and credentials
`;

export const getApplicationPrompt = () => `
Get detailed information about a specific application.

INPUT:
  - applicationId: String - Application ID

OUTPUT:
  - application: Object - Complete application information including:
    - applicationId: String - Unique identifier
    - name: String - Application name
    - description: String - Application description
    - status: String - Current status
    - authStrategy: Object - Authentication configuration
    - oauth: Object - OAuth2 settings (client_id, redirect_uri, scopes)
    - registrations: Array - API registrations summary
    - credentials: Array - Active credentials summary
    - usage: Object - Usage statistics
    - metadata: Object - Creation and update timestamps
  - relatedTools: Array - Tools for managing this application
`;

export const updateApplicationPrompt = () => `
Update an existing application configuration.

INPUT:
  - applicationId: String - Application ID
  - name: String (optional) - New application name
  - description: String (optional) - New description
  - redirectUri: String (optional) - New OAuth2 redirect URI
  - scopes: Array (optional) - New OAuth2 scopes

OUTPUT:
  - success: Boolean - Whether update succeeded
  - application: Object - Updated application details
  - message: String - Success message
  - relatedTools: Array - Tools for further configuration
`;

export const deleteApplicationPrompt = () => `
Delete an application and all its API registrations.

INPUT:
  - applicationId: String - Application ID to delete

OUTPUT:
  - success: Boolean - Whether deletion succeeded
  - message: String - Confirmation message
  - warning: String - Information about deleted registrations and credentials
  - relatedTools: Array - Tools for creating new applications
`;

// =========================
// Application Registration Operations
// =========================

export const listApplicationRegistrationsPrompt = () => `
List API registrations for a specific application.

INPUT:
  - applicationId: String - Application ID
  - pageSize: Number - Registrations per page (1-100, default: 10)
  - pageNumber: Number (optional) - Page to retrieve
  - filterStatus: String (optional) - Filter by status: pending, approved, rejected, revoked
  - filterApiName: String (optional) - Filter by API name

OUTPUT:
  - metadata: Object - Pagination and application info
  - registrations: Array - List of API registrations including:
    - registrationId: String - Unique identifier
    - apiId: String - Registered API ID
    - apiName: String - API name
    - status: String - Registration status
    - approvedAt: String - Approval timestamp
    - expiresAt: String - Expiration date (if applicable)
    - permissions: Array - Granted permissions
    - usage: Object - Usage statistics
  - relatedTools: Array - Tools for managing registrations
`;

export const createApplicationRegistrationPrompt = () => `
Register an application for API access.

INPUT:
  - applicationId: String - Application ID
  - apiId: String - API ID to register for
  - apiProductVersionId: String (optional) - Specific API product version
  - requestReason: String (optional) - Reason for requesting access

OUTPUT:
  - success: Boolean - Whether registration succeeded
  - registration: Object - Registration details including:
    - registrationId: String - Unique identifier
    - status: String - Current status (pending, approved)
    - apiId: String - Registered API
    - permissions: Array - Granted permissions
    - approvalProcess: Object - Approval workflow info
  - message: String - Status message
  - relatedTools: Array - Tools for monitoring approval status
`;

export const getApplicationRegistrationPrompt = () => `
Get details about a specific API registration.

INPUT:
  - applicationId: String - Application ID
  - registrationId: String - Registration ID

OUTPUT:
  - registration: Object - Complete registration information including:
    - registrationId: String - Unique identifier
    - status: String - Current status
    - apiDetails: Object - Registered API information
    - permissions: Array - Granted permissions and scopes
    - usage: Object - Usage statistics and limits
    - approvalHistory: Array - Approval workflow history
    - expirationInfo: Object - Expiration and renewal info
  - relatedTools: Array - Tools for managing this registration
`;

export const deleteApplicationRegistrationPrompt = () => `
Unregister an application from API access.

INPUT:
  - applicationId: String - Application ID
  - registrationId: String - Registration ID to delete

OUTPUT:
  - success: Boolean - Whether unregistration succeeded
  - message: String - Confirmation message
  - relatedTools: Array - Tools for managing remaining registrations
`;

// =========================
// Credential Management Operations
// =========================

export const listCredentialsPrompt = () => `
List credentials for a specific application.

INPUT:
  - applicationId: String - Application ID
  - pageSize: Number - Credentials per page (1-100, default: 10)
  - pageNumber: Number (optional) - Page to retrieve

OUTPUT:
  - metadata: Object - Pagination and application info
  - credentials: Array - List of credentials including:
    - credentialId: String - Unique identifier
    - name: String - Credential name/label
    - type: String - Credential type (api_key, oauth2, basic_auth)
    - status: String - Credential status (active, revoked, expired)
    - createdAt: String - Creation timestamp
    - expiresAt: String - Expiration date
    - lastUsed: String - Last usage timestamp
    - scopes: Array - Associated scopes
  - relatedTools: Array - Tools for credential management
`;

export const createCredentialPrompt = () => `
Create new credentials for an application.

INPUT:
  - applicationId: String - Application ID
  - credentialType: String - Type: api_key, oauth2, basic_auth
  - name: String (optional) - Credential name/label
  - scopes: Array (optional) - OAuth2 scopes
  - expiresAt: String (optional) - Expiration date (ISO 8601)

OUTPUT:
  - success: Boolean - Whether creation succeeded
  - credential: Object - Created credential details including:
    - credentialId: String - Unique identifier
    - type: String - Credential type
    - key: String - API key or client ID
    - secret: String - Secret value (shown once)
    - scopes: Array - Granted scopes
    - expiresAt: String - Expiration date
  - message: String - Success message
  - security: String - Important security notice about secret storage
  - relatedTools: Array - Tools for testing and managing credentials
`;

export const updateCredentialPrompt = () => `
Update existing credential configuration.

INPUT:
  - applicationId: String - Application ID
  - credentialId: String - Credential ID
  - name: String (optional) - New credential name/label
  - scopes: Array (optional) - New OAuth2 scopes
  - expiresAt: String (optional) - New expiration date (ISO 8601)

OUTPUT:
  - success: Boolean - Whether update succeeded
  - credential: Object - Updated credential details
  - message: String - Success message
  - relatedTools: Array - Tools for testing updated credential
`;

export const deleteCredentialPrompt = () => `
Delete a credential and revoke its access.

INPUT:
  - applicationId: String - Application ID
  - credentialId: String - Credential ID to delete

OUTPUT:
  - success: Boolean - Whether deletion succeeded
  - message: String - Confirmation message
  - warning: String - Information about revoked access
  - relatedTools: Array - Tools for creating new credentials
`;

export const regenerateApplicationSecretPrompt = () => `
Regenerate the client secret for an OAuth2 application.

INPUT:
  - applicationId: String - Application ID

OUTPUT:
  - success: Boolean - Whether regeneration succeeded
  - secret: Object - New secret details including:
    - clientSecret: String - New client secret (shown once)
    - generatedAt: String - Generation timestamp
    - expiresAt: String - Expiration date (if applicable)
  - message: String - Success message
  - security: String - Important notice about updating applications
  - relatedTools: Array - Tools for testing with new secret
`;

// =========================
// Developer Authentication Operations
// =========================

export const registerDeveloperPrompt = () => `
Register a new developer account for the portal.

INPUT:
  - email: String - Developer email address
  - fullName: String - Developer full name
  - password: String - Password (minimum 8 characters)
  - organization: String (optional) - Developer organization
  - customAttributes: Object (optional) - Custom developer attributes

OUTPUT:
  - success: Boolean - Whether registration succeeded
  - developer: Object - Created developer profile including:
    - developerId: String - Unique identifier
    - email: String - Email address
    - fullName: String - Full name
    - status: String - Account status
    - organization: String - Organization
    - verificationRequired: Boolean - Email verification status
  - message: String - Success message and next steps
  - relatedTools: Array - Tools for authentication and profile management
`;

export const authenticatePrompt = () => `
Authenticate a developer and establish a session.

INPUT:
  - username: String - Username or email
  - password: String - Password

OUTPUT:
  - success: Boolean - Whether authentication succeeded
  - session: Object - Session information including:
    - token: String - Session token
    - expiresAt: String - Token expiration
    - developerId: String - Developer ID
    - permissions: Array - Developer permissions
  - developer: Object - Developer profile information
  - message: String - Welcome message
  - relatedTools: Array - Authenticated tools and operations
`;

export const getDeveloperMePrompt = () => `
Get the current authenticated developer's profile.

OUTPUT:
  - developer: Object - Developer profile including:
    - developerId: String - Unique identifier
    - email: String - Email address
    - fullName: String - Full name
    - organization: String - Organization
    - status: String - Account status
    - permissions: Array - Developer permissions
    - applicationCount: Number - Number of applications
    - lastLogin: String - Last login timestamp
    - customAttributes: Object - Custom attributes
  - relatedTools: Array - Tools for profile management and applications
`;

export const logoutPrompt = () => `
Logout the current developer and invalidate the session.

OUTPUT:
  - success: Boolean - Whether logout succeeded
  - message: String - Confirmation message
  - relatedTools: Array - Public tools available without authentication
`;

// =========================
// Application Analytics Operations
// =========================

export const queryApplicationAnalyticsPrompt = () => `
Query analytics data for a specific application.

INPUT:
  - applicationId: String - Application ID
  - metrics: Array - Metrics to query: request_count, response_time, error_rate, success_rate, bandwidth_usage
  - dimensions: Array (optional) - Group by: time, api, status_code, endpoint, method
  - timeRange: String - Time range: 1H, 6H, 12H, 24H, 7D, 30D (default: 24H)
  - granularity: String - Time granularity: hour, day, week (default: hour)

OUTPUT:
  - metadata: Object - Query parameters and data retention info
  - analytics: Object - Analytics data including:
    - summary: Object - Overall statistics
    - timeseries: Array - Time-based data points
    - breakdowns: Object - Data grouped by dimensions
    - trends: Object - Trend analysis (growth, patterns)
  - insights: Array - Automated insights and recommendations
  - relatedTools: Array - Tools for deeper analysis and optimization

Note: Rate limited to 100 requests/minute with 90-day data retention.
`;
