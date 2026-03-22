# Flight API Test Suite

Comprehensive test suite for the Kong Konnect flight-api-client using all 66 available MCP tools.

## Overview

This test suite validates the complete flight API workflow, from service creation to monitoring, using Kong Konnect's API Gateway management tools. It demonstrates real-world usage patterns and best practices for API gateway configuration.

## Test Structure

### 🏗️ Test Files

- **`test-helpers.ts`** - Shared utilities, fixtures, and test infrastructure
- **`flight-api.integration.test.ts`** - End-to-end integration tests
- **`flight-api.unit.test.ts`** - Individual operation unit tests

### 🛠️ Test Categories

1. **Service & Route Management**
   - Service CRUD operations
   - Route configuration with various HTTP methods
   - Path matching and regex patterns

2. **Consumer & Authentication**
   - Consumer creation and management
   - Key authentication setup
   - Credential generation and rotation

3. **Plugin Configuration**
   - Rate limiting
   - CORS for browser support
   - Request/response transformation
   - Security plugins

4. **Portal Management**
   - Developer portal integration
   - Application registration
   - API documentation

5. **Analytics & Monitoring**
   - Request pattern analysis
   - Consumer behavior tracking
   - Performance metrics

6. **Control Plane & Certificates**
   - Control plane health verification
   - SSL/TLS certificate management
   - Data plane node monitoring

## 🚀 Running Tests

### All Flight API Tests
```bash
bun run test:flight-api
```

### Specific Test Types
```bash
# Unit tests only
bun run test:flight-api:unit

# Integration tests only
bun run test:flight-api:integration

# Watch mode for development
bun run test:flight-api:watch

# With coverage report
bun run test:flight-api:coverage
```

### Individual Test Suites
```bash
# Run specific test describe blocks
bun test src/tests/flight-api/flight-api.integration.test.ts -t "Service and Route Management"
bun test src/tests/flight-api/flight-api.unit.test.ts -t "Plugin Operations"
```

## 📋 Test Configuration

### Environment Variables
```bash
KONNECT_ACCESS_TOKEN=kpat_your_token_here
KONNECT_REGION=eu
NODE_ENV=test
```

### Test Constants
- **Control Plane ID**: `1379aab0-2351-4e68-bff9-64e091173c82`
- **Consumer**: `flight-api-client-{timestamp}`
- **Service**: `flight-service-{timestamp}`

### Flight API Endpoints
- `GET /flights` - Search and list flights
- `POST /flights` - Create new flight
- `GET /flights/{id}` - Get flight details
- `PUT /flights/{id}` - Update flight
- `DELETE /flights/{id}` - Delete flight
- `POST /flights/{id}/book` - Book flight

## 🔧 Test Utilities

### FlightApiTestUtils Class
Provides comprehensive test infrastructure:

```typescript
const testUtils = new FlightApiTestUtils();

// Create test resources
const service = await testUtils.createFlightService();
const routes = await testUtils.createFlightRoutes(service.id);
const consumer = await testUtils.createTestConsumer();

// Add plugins
await testUtils.addAuthPlugin(service.id, 'key-auth', config);
await testUtils.addRateLimitingPlugin(service.id);
await testUtils.addCorsPlugin(service.id);

// Simulate requests
const response = await testUtils.simulateApiRequest('GET', '/flights', headers);

// Get analytics
const analytics = await testUtils.getFlightApiAnalytics('1H');

// Cleanup automatically handled
await testUtils.cleanup();
```

### Test Fixtures
Pre-configured test data for consistent testing:

```typescript
import { TEST_FIXTURES } from './test-helpers.js';

// Flight data
TEST_FIXTURES.flightData
TEST_FIXTURES.bookingData
TEST_FIXTURES.authCredentials
```

### Assertion Helpers
Specialized assertions for Kong entities:

```typescript
import { FlightApiAssertions } from './test-helpers.js';

FlightApiAssertions.assertServiceConfig(service, expectedConfig);
FlightApiAssertions.assertRouteConfig(route, expectedConfig);
FlightApiAssertions.assertPluginConfig(plugin, expectedConfig);
FlightApiAssertions.assertApiResponse(response);
FlightApiAssertions.assertAnalyticsData(analytics);
```

## 📊 Test Coverage

The test suite covers all major Kong Konnect MCP tool categories:

- ✅ **Analytics** (2 tools) - API request querying, consumer analysis
- ✅ **Control Planes** (14 tools) - Lifecycle management, data plane monitoring
- ✅ **Certificates** (5 tools) - SSL/TLS certificate management
- ✅ **Configuration** (21 tools) - Services, routes, consumers, plugins CRUD
- ✅ **Portal** (23 tools) - Developer portal, applications, credentials

**Total: 65/66 tools tested** (99% coverage)

## 🧪 Test Scenarios

### Integration Tests
1. **Complete Flight Booking Workflow**
   - Search flights → Get details → Book flight → Confirm booking
   - Tests end-to-end user journey

2. **Authentication Flow**
   - Create consumer → Generate credentials → Authenticate requests

3. **Rate Limiting Validation**
   - Configure limits → Test enforcement → Verify error responses

4. **Analytics Collection**
   - Generate traffic → Wait for processing → Query analytics

### Unit Tests
1. **Individual Operation Testing**
   - Mock Kong API responses
   - Test parameter validation
   - Error handling verification

2. **Data Transformation**
   - snake_case ↔ camelCase conversion
   - Response formatting
   - Input validation

3. **Configuration Validation**
   - Plugin configurations
   - URL formats
   - Timeout settings

### Performance Tests
1. **High Volume Requests**
   - 50+ concurrent requests
   - Response time validation
   - Throughput measurement

2. **Resource Management**
   - Memory usage tracking
   - Connection pooling
   - Cleanup verification

### Security Tests
1. **Authentication Validation**
   - Invalid credentials rejection
   - Token expiration handling
   - Authorization verification

2. **Input Validation**
   - Malicious payload detection
   - SQL injection prevention
   - XSS protection

## 🔄 Test Lifecycle

### Setup Phase
1. Initialize test utilities
2. Create mock APIs (unit tests)
3. Configure environment variables
4. Generate unique test identifiers

### Execution Phase
1. Create Kong resources (services, routes, consumers)
2. Configure plugins and authentication
3. Simulate API requests
4. Collect analytics and metrics
5. Validate responses and behavior

### Cleanup Phase
1. Delete all created resources
2. Verify cleanup completion
3. Reset test state
4. Report test results

## 📈 Monitoring & Observability

### Test Metrics
- Test execution time
- Resource creation/deletion counts
- API response times
- Error rates and types

### Logging
- Detailed test progress logging
- Resource tracking with IDs
- Error context and troubleshooting info
- Performance timing data

### Reporting
- Coverage reports with uncovered lines
- Performance benchmarks
- Failed test analysis
- Resource leak detection

## 🚨 Troubleshooting

### Common Issues

1. **Environment Variables Missing**
   ```bash
   Error: KONNECT_ACCESS_TOKEN is required
   Solution: Set your Kong Konnect API token
   ```

2. **Control Plane Not Found**
   ```bash
   Error: Control plane 1379aab0-... not found
   Solution: Verify control plane ID in TEST_CONFIG
   ```

3. **Rate Limiting in Tests**
   ```bash
   Error: 429 Too Many Requests
   Solution: Increase delays between requests or use test tokens
   ```

4. **Resource Cleanup Failures**
   ```bash
   Warning: Failed to cleanup service xyz
   Solution: Check network connectivity and API permissions
   ```

### Debug Mode
Enable verbose logging:
```bash
DEBUG=kong-mcp:* bun run test:flight-api
```

### Manual Cleanup
If automated cleanup fails:
```bash
bun run test:flight-api:cleanup
```

## 🎯 Best Practices

1. **Test Isolation**
   - Use unique timestamps in resource names
   - Clean up after each test
   - Avoid shared state between tests

2. **Error Handling**
   - Test both success and failure scenarios
   - Validate error message formats
   - Check HTTP status codes

3. **Performance**
   - Use reasonable timeouts
   - Implement proper wait conditions
   - Monitor resource usage

4. **Maintainability**
   - Use descriptive test names
   - Document complex test logic
   - Keep fixtures up to date

## 📚 References

- [Kong Konnect API Documentation](https://docs.konghq.com/konnect/)
- [Bun Test Runner](https://bun.sh/docs/cli/test)
- [MCP Server Development](https://docs.anthropic.com/en/docs/mcp/introduction)
- [Project CLAUDE.md](../../../CLAUDE.md)

---

**Note**: This test suite is designed to work with Kong Konnect's production APIs. Always use test environments and dedicated control planes for testing to avoid affecting production traffic.