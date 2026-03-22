export const listCertificatesPrompt = () => `
List all SSL/TLS certificates in a control plane with health analysis and expiration monitoring.

INPUT:
  - controlPlaneId: String - Control Plane ID (from list-control-planes)
  - size: Number - Number of certificates to return (1-1000, default: 100)
  - offset: String (optional) - Pagination offset token from previous response

OUTPUT:
  - metadata: Object - Contains pagination and control plane information
  - certificates: Array - List of certificates with details including:
    - certificateId: String - Unique certificate identifier
    - certDigest: String - Certificate fingerprint/digest
    - snis: Array - Associated Server Name Indications (domain names)
    - tags: Array - Certificate tags for organization
    - expirationAnalysis: Object - Certificate health analysis including:
      - status: String - Certificate validation status
      - daysUntilExpiration: Number - Days remaining before expiration
      - warnings: Array - Expiration warnings and alerts
    - metadata: Object - Creation and update timestamps
  - healthSummary: Object - Overall certificate health summary
  - relatedTools: Array - Suggested tools for certificate management

SECURITY FEATURES:
  - Certificate contents are redacted for security
  - Automated expiration monitoring and alerts
  - Health analysis to identify certificates needing attention
  - Integration with SNI management for domain associations

CERTIFICATE LIFECYCLE MANAGEMENT:
  - Monitor expiring certificates proactively
  - Plan certificate renewal strategies
  - Organize certificates with tags and metadata
`;

export const getCertificatePrompt = () => `
Get detailed information about a specific SSL/TLS certificate including validation status.

INPUT:
  - controlPlaneId: String - Control Plane ID (from list-control-planes)
  - certificateId: String - Certificate ID (from list-certificates)

OUTPUT:
  - certificate: Object - Detailed certificate information including:
    - certificateId: String - Unique identifier
    - certDigest: String - Certificate fingerprint
    - keyInfo: String - Private key presence indicator (for security)
    - snis: Array - Associated domain names
    - tags: Array - Organization tags
    - validation: Object - Certificate format validation results
    - metadata: Object - Creation and modification timestamps
  - usage: Object - Certificate usage information
  - recommendations: Array - Best practices and maintenance suggestions

SECURITY CONSIDERATIONS:
  - Certificate and private key contents are never exposed in responses
  - Only metadata and validation status are provided
  - Digest/fingerprint provided for certificate identification
  - SNI associations shown for domain mapping verification

USE CASES:
  - Verify certificate installation and format
  - Check SNI domain associations
  - Validate certificate-key pair integrity
  - Audit certificate configuration
`;

export const createCertificatePrompt = () => `
Upload a new SSL/TLS certificate and private key to Kong Konnect with validation.

INPUT:
  - controlPlaneId: String - Control Plane ID (from list-control-planes)
  - cert: String - Certificate in PEM format (-----BEGIN CERTIFICATE-----...)
  - key: String - Private key in PEM format (-----BEGIN PRIVATE KEY-----...)
  - certAlt: String (optional) - Alternative certificate for dual cert setups (ECC + RSA)
  - keyAlt: String (optional) - Alternative private key
  - tags: String[] (optional) - Tags for organization and management

OUTPUT:
  - certificate: Object - Created certificate information including:
    - certificateId: String - New certificate identifier
    - status: String - Creation status
    - hasAlternativeCert: Boolean - Whether alternative cert was provided
    - tags: Array - Applied tags
    - metadata: Object - Creation timestamp
  - nextSteps: Array - Recommended actions after certificate creation

VALIDATION FEATURES:
  - Automatic PEM format validation
  - Certificate-key pair compatibility checking
  - Alternative certificate support for mixed cipher suites
  - Format validation with detailed error messages

SECURITY BEST PRACTICES:
  - Certificates are validated before storage
  - Private keys are securely stored and never exposed
  - Support for both RSA and ECC certificates
  - Alternative certificates for broader client compatibility

POST-CREATION STEPS:
  - Create SNI associations for domain names
  - Configure services to use the certificate
  - Set up monitoring for expiration tracking
`;

export const updateCertificatePrompt = () => `
Update an existing SSL/TLS certificate, private key, or associated metadata.

INPUT:
  - controlPlaneId: String - Control Plane ID (from list-control-planes)
  - certificateId: String - Certificate ID (from list-certificates)
  - cert: String (optional) - Updated certificate in PEM format
  - key: String (optional) - Updated private key in PEM format
  - certAlt: String (optional) - Updated alternative certificate
  - keyAlt: String (optional) - Updated alternative private key
  - tags: String[] (optional) - Updated tags

OUTPUT:
  - certificate: Object - Updated certificate information including:
    - certificateId: String - Certificate identifier
    - status: String - Update status
    - updatedFields: Array - List of fields that were modified
    - tags: Array - Current tags after update
    - metadata: Object - Updated timestamp information
  - recommendations: Array - Post-update verification suggestions

UPDATE SCENARIOS:
  - Certificate renewal with new cert/key pair
  - Adding or updating alternative certificates
  - Updating tags for better organization
  - Key rotation for enhanced security

VALIDATION AND SAFETY:
  - All updates are validated before applying
  - Certificate-key pair compatibility verified
  - Existing SNI associations preserved
  - Rollback guidance provided if issues occur

IMPACT CONSIDERATIONS:
  - Services using this certificate continue operating
  - SNI associations remain intact
  - Client connections may briefly reconnect during updates
`;

export const deleteCertificatePrompt = () => `
Remove an SSL/TLS certificate from Kong Konnect with safety checks.

INPUT:
  - controlPlaneId: String - Control Plane ID (from list-control-planes)
  - certificateId: String - Certificate ID (from list-certificates)

OUTPUT:
  - status: String - Deletion confirmation
  - certificateId: String - Deleted certificate identifier
  - message: String - Deletion success message
  - warnings: Array - Important considerations about the deletion

DELETION SAFETY CHECKS:
  - Automatic removal of associated SNI mappings
  - Warning about services that may be using the certificate
  - Guidance on verifying no dependencies exist
  - Recommendations for replacement certificates

IMPACT ASSESSMENT:
  - Services configured with this certificate will lose SSL/TLS
  - Domain names (SNIs) associated with certificate become unprotected
  - Client connections to affected services will fail SSL handshake
  - Manual service reconfiguration required after deletion

BEST PRACTICES:
  - Always verify certificate usage before deletion
  - Have replacement certificate ready if needed
  - Plan maintenance window for service updates
  - Monitor service health after certificate removal

WARNING: This operation is irreversible. Ensure no services depend on this certificate before deletion.
`;
