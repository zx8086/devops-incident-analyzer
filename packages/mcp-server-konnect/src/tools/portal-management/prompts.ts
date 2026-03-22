export const portalManagementPrompts = {
	"list-portals": `## List Developer Portals

List all developer portals in your Kong Konnect organization. Developer portals enable you to publish APIs for internal and external developers.

**Common Use Cases:**
- View all developer portals in your organization
- Check portal configuration and statistics
- Monitor portal usage metrics
- Find portals for API publication

**Parameters:**
- \`pageSize\` (optional): Number of portals per page (1-100, default: 10)
- \`pageNumber\` (optional): Page to retrieve (default: 1)

**Example Queries:**
- "List all our developer portals"
- "Show me the portals with their usage statistics"
- "What portals do we have configured?"`,

	"create-portal": `## Create Developer Portal

Create a new developer portal for publishing APIs to internal or external developers. Portals provide a centralized location for API documentation, registration, and management.

**Common Use Cases:**
- Set up a new developer portal for API distribution
- Create separate portals for internal vs external APIs
- Establish developer self-service capabilities
- Enable API discovery and documentation

**Parameters:**
- \`name\` (required): Portal name (max 100 characters)
- \`description\` (optional): Portal purpose description
- \`displayName\` (optional): Name shown in portal UI
- \`isPublic\` (optional): Public accessibility (default: false)
- \`autoApproveDevelopers\` (optional): Auto-approve developer registration (default: true)
- \`autoApproveApplications\` (optional): Auto-approve app registration (default: true)
- \`customDomain\` (optional): Custom domain (e.g., portal.company.com)
- \`labels\` (optional): Custom metadata labels

**Example Queries:**
- "Create a portal for our Flight API called 'flight-api-portal'"
- "Set up a public portal for external developers"
- "Create an internal portal with custom domain portal.company.com"`,

	"get-portal": `## Get Portal Details

Retrieve comprehensive information about a specific developer portal, including configuration, statistics, and metadata.

**Common Use Cases:**
- Review portal configuration and settings
- Check portal usage statistics
- Verify portal domain configuration
- Monitor developer and application counts

**Parameters:**
- \`portalId\` (required): ID of the portal to retrieve

**Example Queries:**
- "Get details for portal 3cb352a1-9f97-4a4c-87bc-94aefd3200d8"
- "Show me the configuration of the flight-api-portal"
- "What's the status of our main developer portal?"`,

	"update-portal": `## Update Portal Configuration

Update developer portal settings, configuration, and metadata. Allows modification of portal behavior and appearance.

**Common Use Cases:**
- Change portal approval settings
- Update portal description or display name
- Configure custom domains
- Modify public accessibility settings
- Update portal labels and metadata

**Parameters:**
- \`portalId\` (required): ID of the portal to update
- \`name\` (optional): Updated portal name
- \`description\` (optional): Updated description
- \`displayName\` (optional): Updated display name
- \`isPublic\` (optional): Updated public accessibility
- \`autoApproveDevelopers\` (optional): Developer auto-approval setting
- \`autoApproveApplications\` (optional): Application auto-approval setting
- \`customDomain\` (optional): Custom domain configuration
- \`labels\` (optional): Updated metadata labels

**Example Queries:**
- "Make the flight-api-portal public"
- "Update portal description to include Flight API information"
- "Configure custom domain portal.flightapi.com for the portal"`,

	"delete-portal": `## Delete Developer Portal

WARNING: **DESTRUCTIVE OPERATION** WARNING:

Permanently delete a developer portal and all associated data including developers, applications, and published products. This action cannot be undone.

**Common Use Cases:**
- Remove unused or deprecated portals
- Clean up development/testing portals
- Consolidate portal infrastructure

**Parameters:**
- \`portalId\` (required): ID of the portal to delete

**WARNING: Warning:** This will permanently remove:
- All portal configuration
- All registered developers
- All applications and credentials
- All published API products
- All portal customizations

**Example Queries:**
- "Delete the test portal 3cb352a1-9f97-4a4c-87bc-94aefd3200d8"
- "Remove the unused development portal"`,

	"list-portal-products": `## List Portal Published Products

List API products that have been published to a developer portal. Published products are available for developers to discover and register applications against.

**Common Use Cases:**
- Review APIs published to a portal
- Check product publication status
- Monitor API availability in portals
- Audit published content

**Parameters:**
- \`portalId\` (required): ID of the portal
- \`pageSize\` (optional): Number of products per page
- \`pageNumber\` (optional): Page to retrieve

**Example Queries:**
- "What APIs are published to the flight-api-portal?"
- "List all products available in our main developer portal"
- "Show me the published APIs with their registration counts"`,

	"publish-portal-product": `## Publish API Product to Portal

Publish an API product to a developer portal, making it available for developers to discover, explore, and register applications against.

**Common Use Cases:**
- Make APIs available to developers
- Publish new API versions to portals
- Enable developer access to specific APIs
- Distribute APIs for consumption

**Parameters:**
- \`portalId\` (required): ID of the target portal
- \`productId\` (required): ID of the API product to publish
- \`productVersionId\` (optional): Specific version to publish
- \`description\` (optional): Portal-specific API description

**Example Queries:**
- "Publish the Flight API product to the developer portal"
- "Make the booking API available in the public portal"
- "Add the Flight API v2.0 to the flight-api-portal"`,

	"unpublish-portal-product": `## Unpublish API Product from Portal

Remove an API product from a developer portal, making it no longer available for new developer registrations. Existing application registrations remain active.

**Common Use Cases:**
- Remove deprecated API versions
- Hide APIs during maintenance
- Control API availability
- Manage portal content lifecycle

**Parameters:**
- \`portalId\` (required): ID of the portal
- \`productId\` (required): ID of the API product to unpublish

**Note:** Existing application registrations and credentials remain functional after unpublishing.

**Example Queries:**
- "Remove the deprecated Flight API v1 from the portal"
- "Unpublish the booking API during maintenance"
- "Hide the internal API from the public portal"`,
};
