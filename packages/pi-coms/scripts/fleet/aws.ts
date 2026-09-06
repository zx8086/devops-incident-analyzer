// scripts/fleet/aws.ts
// SIO-1653: the AWS calls the fleet CLI makes, behind one interface so the
// decision logic (preflight, tokens, status) is unit-tested with a fake.
// Every call names the local profile it runs under; no ambient credentials.
import {
	BedrockClient,
	GetFoundationModelAvailabilityCommand,
	ListInferenceProfilesCommand,
} from "@aws-sdk/client-bedrock";
import {
	DescribeInstancesCommand,
	DescribeRouteTablesCommand,
	DescribeSubnetsCommand,
	EC2Client,
} from "@aws-sdk/client-ec2";
import { GetRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { DescribeOrganizationCommand, OrganizationsClient } from "@aws-sdk/client-organizations";
import {
	type BucketLocationConstraint,
	CreateBucketCommand,
	HeadBucketCommand,
	PutBucketVersioningCommand,
	PutPublicAccessBlockCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import {
	GetParameterCommand,
	GetParametersByPathCommand,
	PutParameterCommand,
	SendCommandCommand,
	SSMClient,
} from "@aws-sdk/client-ssm";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { fromIni } from "@aws-sdk/credential-providers";

export type Identity = { account: string; arn: string };
export type RouteSummary = { vpcId: string; cidr: string; transitGatewayRoute: boolean };
export type TrustSummary = { arn: string; statements: Array<{ sid?: string; principals: string[] }> };

export interface FleetAws {
	callerIdentity(profile: string, region: string): Promise<Identity>;
	parameterExists(profile: string, region: string, name: string): Promise<boolean>;
	listParameterNames(profile: string, region: string, path: string): Promise<string[]>;
	putSecureParameter(profile: string, region: string, name: string, value: string): Promise<void>;
	subnetRoutes(profile: string, region: string, subnetId: string): Promise<RouteSummary>;
	organizationId(profile: string, region: string): Promise<string | undefined>;
	inferenceProfileVisible(profile: string, region: string, id: string): Promise<boolean>;
	roleTrust(profile: string, region: string, roleName: string): Promise<TrustSummary | undefined>;
	bucketExists(profile: string, region: string, bucket: string): Promise<boolean>;
	createStateBucket(profile: string, region: string, bucket: string): Promise<void>;
	instanceIdByName(profile: string, region: string, nameTag: string): Promise<string | undefined>;
	runShell(profile: string, region: string, instanceId: string, commands: string[]): Promise<string>;
}

function creds(profile: string) {
	return fromIni({ profile });
}

export function isExpiredCredential(error: unknown): boolean {
	const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
	return /ExpiredToken|expired|InvalidClientTokenId|UnrecognizedClientException|could not be found|Token is invalid/i.test(
		text,
	);
}

export const realFleetAws: FleetAws = {
	async callerIdentity(profile, region) {
		const out = await new STSClient({ region, credentials: creds(profile) }).send(new GetCallerIdentityCommand({}));
		return { account: out.Account ?? "", arn: out.Arn ?? "" };
	},
	async parameterExists(profile, region, name) {
		try {
			await new SSMClient({ region, credentials: creds(profile) }).send(new GetParameterCommand({ Name: name }));
			return true;
		} catch (error) {
			if (error instanceof Error && error.name === "ParameterNotFound") return false;
			throw error;
		}
	},
	async listParameterNames(profile, region, path) {
		const client = new SSMClient({ region, credentials: creds(profile) });
		const names: string[] = [];
		let token: string | undefined;
		do {
			const out = await client.send(new GetParametersByPathCommand({ Path: path, Recursive: true, NextToken: token }));
			for (const p of out.Parameters ?? []) if (p.Name) names.push(p.Name);
			token = out.NextToken;
		} while (token);
		return names;
	},
	async putSecureParameter(profile, region, name, value) {
		await new SSMClient({ region, credentials: creds(profile) }).send(
			new PutParameterCommand({ Name: name, Type: "SecureString", Value: value, Overwrite: true }),
		);
	},
	async subnetRoutes(profile, region, subnetId) {
		const ec2 = new EC2Client({ region, credentials: creds(profile) });
		const subnets = await ec2.send(new DescribeSubnetsCommand({ SubnetIds: [subnetId] }));
		const subnet = subnets.Subnets?.[0];
		if (!subnet?.VpcId) throw new Error(`subnet ${subnetId} not found`);
		// The subnet's own association wins; otherwise the VPC main table applies.
		const explicit = await ec2.send(
			new DescribeRouteTablesCommand({ Filters: [{ Name: "association.subnet-id", Values: [subnetId] }] }),
		);
		let tables = explicit.RouteTables ?? [];
		if (tables.length === 0) {
			const main = await ec2.send(
				new DescribeRouteTablesCommand({
					Filters: [
						{ Name: "vpc-id", Values: [subnet.VpcId] },
						{ Name: "association.main", Values: ["true"] },
					],
				}),
			);
			tables = main.RouteTables ?? [];
		}
		const transitGatewayRoute = tables.some((t) => (t.Routes ?? []).some((r) => !!r.TransitGatewayId));
		return { vpcId: subnet.VpcId, cidr: subnet.CidrBlock ?? "", transitGatewayRoute };
	},
	async organizationId(profile, region) {
		try {
			const out = await new OrganizationsClient({ region, credentials: creds(profile) }).send(
				new DescribeOrganizationCommand({}),
			);
			return out.Organization?.Id;
		} catch (error) {
			if (error instanceof Error && /AccessDenied|AWSOrganizationsNotInUse/.test(`${error.name} ${error.message}`))
				return undefined;
			throw error;
		}
	},
	async inferenceProfileVisible(profile, region, id) {
		const bedrock = new BedrockClient({ region, credentials: creds(profile) });
		try {
			const out = await bedrock.send(new ListInferenceProfilesCommand({}));
			if ((out.inferenceProfileSummaries ?? []).some((p) => p.inferenceProfileId === id)) return true;
			// A bare foundation model id: ask for its availability instead.
			const avail = await bedrock.send(new GetFoundationModelAvailabilityCommand({ modelId: id }));
			return avail.agreementAvailability?.status === "AVAILABLE";
		} catch {
			return false;
		}
	},
	async roleTrust(profile, region, roleName) {
		try {
			const out = await new IAMClient({ region, credentials: creds(profile) }).send(
				new GetRoleCommand({ RoleName: roleName }),
			);
			const raw = out.Role?.AssumeRolePolicyDocument ? decodeURIComponent(out.Role.AssumeRolePolicyDocument) : "{}";
			const doc = JSON.parse(raw) as { Statement?: Array<{ Sid?: string; Principal?: { AWS?: string | string[] } }> };
			return {
				arn: out.Role?.Arn ?? "",
				statements: (doc.Statement ?? []).map((st) => ({
					...(st.Sid ? { sid: st.Sid } : {}),
					principals:
						st.Principal?.AWS === undefined
							? []
							: Array.isArray(st.Principal.AWS)
								? st.Principal.AWS
								: [st.Principal.AWS],
				})),
			};
		} catch (error) {
			if (error instanceof Error && error.name === "NoSuchEntityException") return undefined;
			throw error;
		}
	},
	async bucketExists(profile, region, bucket) {
		try {
			await new S3Client({ region, credentials: creds(profile) }).send(new HeadBucketCommand({ Bucket: bucket }));
			return true;
		} catch (error) {
			if (error instanceof Error && /NotFound|404/.test(`${error.name} ${error.message}`)) return false;
			throw error;
		}
	},
	async createStateBucket(profile, region, bucket) {
		const s3 = new S3Client({ region, credentials: creds(profile) });
		await s3.send(
			new CreateBucketCommand({
				Bucket: bucket,
				...(region === "us-east-1"
					? {}
					: { CreateBucketConfiguration: { LocationConstraint: region as BucketLocationConstraint } }),
			}),
		);
		await s3.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } }));
		await s3.send(
			new PutPublicAccessBlockCommand({
				Bucket: bucket,
				PublicAccessBlockConfiguration: {
					BlockPublicAcls: true,
					BlockPublicPolicy: true,
					IgnorePublicAcls: true,
					RestrictPublicBuckets: true,
				},
			}),
		);
	},
	async instanceIdByName(profile, region, nameTag) {
		const out = await new EC2Client({ region, credentials: creds(profile) }).send(
			new DescribeInstancesCommand({
				Filters: [
					{ Name: "tag:Name", Values: [nameTag] },
					{ Name: "instance-state-name", Values: ["running"] },
				],
			}),
		);
		return out.Reservations?.[0]?.Instances?.[0]?.InstanceId;
	},
	async runShell(profile, region, instanceId, commands) {
		const out = await new SSMClient({ region, credentials: creds(profile) }).send(
			new SendCommandCommand({
				InstanceIds: [instanceId],
				DocumentName: "AWS-RunShellScript",
				Parameters: { commands },
			}),
		);
		return out.Command?.CommandId ?? "";
	},
};
