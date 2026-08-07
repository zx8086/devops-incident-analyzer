// src/tools/output-schemas.ts
import { ListTruncationMarkerSchema } from "@devops-agent/shared";
import { z } from "zod";

// Mirrors packages/mcp-server-aws/src/tools/types.ts ToolError (the local wrapListTool error
// shape, NOT packages/shared/src/agent-state.ts's ToolErrorSchema -- different owner, different
// fields). Loose on purpose: this validates the wire contract wrapListTool's error branch emits,
// not a redeclaration of the AWS SDK's error surface.
const AwsToolErrorSchema = z.object({
	kind: z.string(),
	action: z.string().optional(),
	awsErrorName: z.string().optional(),
	awsErrorMessage: z.string().optional(),
	awsRequestId: z.string().optional(),
	httpStatusCode: z.number().optional(),
	advice: z.string().optional(),
});

// aws_cloudwatch_describe_alarms: wrapListTool (wrap.ts) can return the raw AWS SDK
// DescribeAlarmsCommand response, a byte-truncated variant of it (+ _truncated/_summary), or
// { _error }. Deliberately passthrough on the AWS-shaped payload fields (MetricAlarms/
// CompositeAlarms/NextToken -- 20+ optional fields per alarm in the underlying SDK type) rather
// than re-typing the SDK: this is a structural envelope contract, not a field-level one, and
// nothing currently consumes structuredContent (agent-side consumption is deferred, SIO-1425).
// Must be passed to registerTool's outputSchema as the SCHEMA OBJECT, not `.shape` -- the MCP
// SDK's normalizeObjectSchema rebuilds a bare z.object(shape) from a raw shape (zod-compat.js
// objectFromShape), which would silently drop .passthrough() and reject any AWS SDK field this
// schema doesn't enumerate.
export const describeAlarmsOutputSchema = z
	.object({
		MetricAlarms: z.array(z.record(z.string(), z.unknown())).optional(),
		CompositeAlarms: z.array(z.record(z.string(), z.unknown())).optional(),
		NextToken: z.string().optional(),
		_truncated: ListTruncationMarkerSchema.optional(),
		_summary: z.array(z.record(z.string(), z.unknown())).optional(),
		_error: AwsToolErrorSchema.optional(),
	})
	.passthrough();
