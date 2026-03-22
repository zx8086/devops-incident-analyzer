export const queryApiRequestsPrompt = () => `
Query and analyze Kong API Gateway requests with customizable filters. 
Before calling this it's necessary to have a controlPlaneID and a serviceID or routeID. 
These can be obtained using the list-control-planes, list-services, and list-routes tools.

INPUT:
  - timeRange: String - Time range for data retrieval (15M, 1H, 6H, 12H, 24H, 7D)
  - statusCodes: Number[] (optional) - Filter by specific HTTP status codes
  - excludeStatusCodes: Number[] (optional) - Exclude specific HTTP status codes
  - httpMethods: String[] (optional) - Filter by HTTP methods (e.g., GET, POST)
  - consumerIds: String[] (optional) - Filter by consumer IDs
  - serviceIds: String[] (optional) - Filter by service IDs. The format of this field must be "<controlPlaneID>:<serviceID>". 
  - routeIds: String[] (optional) - Filter by route IDs. The format of this field must be "<controlPlaneID:routeID>"
  - maxResults: Number - Maximum number of results to return (1-1000)

OUTPUT:
  - metadata: Object - Contains totalRequests, timeRange, and applied filters
  - requests: Array - List of request objects with details including:
    - requestId: String - Unique request identifier
    - timestamp: String - When the request occurred
    - httpMethod: String - HTTP method used (GET, POST, etc.)
    - uri: String - Request URI path
    - statusCode: Number - HTTP status code of the response
    - consumerId: String - ID of the consumer making the request
    - serviceId: String - ID of the service handling the request
    - routeId: String - ID of the matched route
    - latency: Object - Response time metrics
    - clientIp: String - IP address of the client
    - and many more detailed fields...

ANALYSIS TIPS:
  - Use status code filters to focus on errors (4xx, 5xx) or successes (2xx, 3xx)
  - Analyze latency patterns to identify performance bottlenecks
  - Group by service or route to identify high-traffic endpoints
  - Use consumer filters to analyze specific user behavior
  - Check rate limiting data to understand throttling patterns
`;

export const getConsumerRequestsPrompt = () => `
Retrieve and analyze API requests made by a specific consumer with detailed statistics.

INPUT:
  - consumerId: String - ID of the consumer to analyze. The format of this field must be "controlPlaneID:consumerId".
  - timeRange: String - Time range for data retrieval (15M, 1H, 6H, 12H, 24H, 7D)
  - successOnly: Boolean - Filter to only show successful (2xx) requests (default: false)
  - failureOnly: Boolean - Filter to only show failed (non-2xx) requests (default: false)
  - maxResults: Number - Maximum number of results to return (1-1000)

OUTPUT:
  - metadata: Object - Contains consumerId, totalRequests, timeRange, and filters
  - statistics: Object - Comprehensive usage statistics including:
    - averageLatencyMs: Number - Average response time in milliseconds
    - successRate: Number - Percentage of successful requests
    - statusCodeDistribution: Array - Breakdown of requests by status code with percentages
    - serviceDistribution: Array - Breakdown of requests by service with status code details
  - requests: Array - Detailed list of individual requests with:
    - timestamp: String - When the request occurred
    - httpMethod: String - HTTP method used
    - uri: String - Request URI
    - statusCode: Number - Response status code
    - serviceId: String - Service that handled the request
    - routeId: String - Route that matched the request
    - latency: Object - Detailed timing information
    - clientIp: String - Client IP address
    - traceId: String - Trace ID for request tracking

ANALYSIS FEATURES:
  - Automatic calculation of success rates and error patterns
  - Service usage breakdown to identify consumer behavior
  - Latency analysis to spot performance issues
  - Status code distribution for error analysis
  - Time-based request patterns
`;
