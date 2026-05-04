// tests/providers/msk.test.ts
import { describe, expect, test } from "bun:test";
import { MskKafkaProvider, pickBrokerString } from "../../src/providers/msk.ts";

describe("MskKafkaProvider.getConnectionConfig", () => {
	const brokers = "b-1.example.kafka.eu-west-1.amazonaws.com:9092,b-2.example.kafka.eu-west-1.amazonaws.com:9092";

	test("authMode=none returns config without sasl or tls", async () => {
		const provider = new MskKafkaProvider(brokers, "arn:aws:kafka:::cluster/x", "eu-west-1", "test-client", "none");
		const config = await provider.getConnectionConfig();

		expect(config.bootstrapBrokers).toEqual([
			"b-1.example.kafka.eu-west-1.amazonaws.com:9092",
			"b-2.example.kafka.eu-west-1.amazonaws.com:9092",
		]);
		expect(config.sasl).toBeUndefined();
		expect(config.tls).toBeUndefined();
		expect(config.connectTimeout).toBeUndefined();
	});

	test("authMode=tls returns config with tls but no sasl", async () => {
		const provider = new MskKafkaProvider(brokers, "arn:aws:kafka:::cluster/x", "eu-west-1", "test-client", "tls");
		const config = await provider.getConnectionConfig();

		expect(config.tls).toEqual({ rejectUnauthorized: true });
		expect(config.sasl).toBeUndefined();
	});

	test("authMode=iam returns config with sasl OAUTHBEARER and tls", async () => {
		const provider = new MskKafkaProvider(brokers, "arn:aws:kafka:::cluster/x", "eu-west-1", "test-client", "iam");
		const config = await provider.getConnectionConfig();

		expect(config.tls).toEqual({ rejectUnauthorized: true });
		expect(config.sasl?.mechanism).toBe("OAUTHBEARER");
		// SASL OAUTHBEARER uses a token callback, not username/password
		expect(typeof (config.sasl as { token?: () => Promise<string> }).token).toBe("function");
		expect(config.connectTimeout).toBe(60_000);
		expect(config.requestTimeout).toBe(60_000);
		expect(config.retries).toBe(5);
	});

	test("default authMode is iam", async () => {
		const provider = new MskKafkaProvider(brokers, "arn:aws:kafka:::cluster/x", "eu-west-1", "test-client");
		const config = await provider.getConnectionConfig();

		expect(config.sasl?.mechanism).toBe("OAUTHBEARER");
		expect(config.tls).toEqual({ rejectUnauthorized: true });
	});

	test("provider name reflects auth mode", () => {
		const none = new MskKafkaProvider(brokers, "", "eu-west-1", "c", "none");
		const tls = new MskKafkaProvider(brokers, "", "eu-west-1", "c", "tls");
		const iam = new MskKafkaProvider(brokers, "", "eu-west-1", "c", "iam");
		expect(none.name).toBe("AWS MSK (none)");
		expect(tls.name).toBe("AWS MSK (tls)");
		expect(iam.name).toBe("AWS MSK (iam)");
	});
});

describe("pickBrokerString", () => {
	const fullResponse = {
		BootstrapBrokerString: "plaintext.example:9092",
		BootstrapBrokerStringTls: "tls.example:9094",
		BootstrapBrokerStringSaslIam: "iam.example:9098",
		BootstrapBrokerStringPublic: "public-plaintext.example:9092",
		BootstrapBrokerStringPublicTls: "public-tls.example:9094",
		BootstrapBrokerStringPublicSaslIam: "public-iam.example:9198",
	};

	test("iam prefers SASL/IAM, falls back to public IAM", () => {
		expect(pickBrokerString(fullResponse, "iam")).toBe("iam.example:9098");
		expect(pickBrokerString({ BootstrapBrokerStringPublicSaslIam: "public-iam.example:9198" }, "iam")).toBe(
			"public-iam.example:9198",
		);
	});

	test("tls prefers TLS-only, falls back to public TLS", () => {
		expect(pickBrokerString(fullResponse, "tls")).toBe("tls.example:9094");
		expect(pickBrokerString({ BootstrapBrokerStringPublicTls: "public-tls.example:9094" }, "tls")).toBe(
			"public-tls.example:9094",
		);
	});

	test("none prefers PLAINTEXT, falls back to public PLAINTEXT", () => {
		expect(pickBrokerString(fullResponse, "none")).toBe("plaintext.example:9092");
		expect(pickBrokerString({ BootstrapBrokerStringPublic: "public-plaintext.example:9092" }, "none")).toBe(
			"public-plaintext.example:9092",
		);
	});

	test("returns undefined when no matching broker string is present", () => {
		expect(pickBrokerString({ BootstrapBrokerString: "plain.example:9092" }, "iam")).toBeUndefined();
		expect(pickBrokerString({ BootstrapBrokerStringSaslIam: "iam.example:9098" }, "none")).toBeUndefined();
	});

	test("does not cross-pick: iam mode never returns plaintext brokers even if present", () => {
		expect(pickBrokerString({ BootstrapBrokerString: "plain.example:9092" }, "iam")).toBeUndefined();
	});
});
