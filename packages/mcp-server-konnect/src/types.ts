export interface ApiRequestFilter {
	field: string;
	operator: string;
	value: string | number | string[] | number[];
}

export interface TimeRange {
	type: "relative";
	time_range: string;
}

export interface ApiRequestResult {
	request_id: string;
	request_start: string;
	http_method: string;
	request_uri: string;
	status_code: number;
	response_http_status?: number;
	consumer?: string;
	gateway_service?: string;
	route?: string;
	latencies_response_ms: number;
	latencies_kong_gateway_ms: number;
	latencies_upstream_ms: number;
	client_ip: string;
	api_product?: string;
	api_product_version?: string;
	application?: string;
	auth_type?: string;
	header_host?: string;
	header_user_agent?: string;
	data_plane_node?: string;
	data_plane_node_version?: string;
	control_plane?: string;
	control_plane_group?: string;
	ratelimit_enabled?: boolean;
	ratelimit_limit?: number;
	ratelimit_remaining?: number;
	ratelimit_reset?: number;
	ratelimit_enabled_second?: boolean;
	ratelimit_limit_second?: number;
	ratelimit_remaining_second?: number;
	ratelimit_enabled_minute?: boolean;
	ratelimit_limit_minute?: number;
	ratelimit_remaining_minute?: number;
	ratelimit_enabled_hour?: boolean;
	ratelimit_limit_hour?: number;
	ratelimit_remaining_hour?: number;
	ratelimit_enabled_day?: boolean;
	ratelimit_limit_day?: number;
	ratelimit_remaining_day?: number;
	ratelimit_enabled_month?: boolean;
	ratelimit_limit_month?: number;
	ratelimit_remaining_month?: number;
	ratelimit_enabled_year?: boolean;
	ratelimit_limit_year?: number;
	ratelimit_remaining_year?: number;
	service_port?: string;
	service_protocol?: string;
	request_body_size?: number;
	response_body_size?: number;
	response_header_content_type?: string;
	response_header_content_length?: string;
	trace_id?: string;
	upstream_uri?: string;
	upstream_status?: string;
}

export interface ApiRequestsResponse {
	meta: {
		size: number;
		time_range: {
			start: string;
			end: string;
		};
	};
	results: ApiRequestResult[];
}

export interface ControlPlane {
	id: string;
	name: string;
	description?: string;
	type: string;
	cluster_type: string;
	control_plane_endpoint: string;
	telemetry_endpoint: string;
	has_cloud_gateway: boolean;
	cloud_gateway?: boolean;
	auth_type?: string;
	proxy_urls?: string[];
	status?: string;
	credentials?: Record<string, unknown>;
	labels?: Record<string, string>;
	created_at: string;
	updated_at: string;
	[key: string]: unknown;
}

export interface EntityMetadata {
	created_at: string;
	updated_at: string;
}

export interface Service {
	id: string;
	name: string;
	host: string;
	port: number;
	protocol: string;
	path?: string;
	retries?: number;
	connect_timeout?: number;
	write_timeout?: number;
	read_timeout?: number;
	tags?: string[];
	client_certificate?: string;
	tls_verify?: boolean;
	tls_verify_depth?: number;
	ca_certificates?: string[];
	enabled: boolean;
	created_at: string;
	updated_at: string;
}

export interface Route {
	id: string;
	name: string;
	protocols: string[];
	methods?: string[];
	hosts?: string[];
	paths?: string[];
	https_redirect_status_code?: number;
	regex_priority?: number;
	strip_path?: boolean;
	preserve_host?: boolean;
	request_buffering?: boolean;
	response_buffering?: boolean;
	tags?: string[];
	service?: {
		id: string;
	};
	enabled: boolean;
	created_at: string;
	updated_at: string;
}

export interface Consumer {
	id: string;
	username?: string;
	custom_id?: string;
	tags?: string[];
	enabled: boolean;
	created_at: string;
	updated_at: string;
}

export interface Plugin {
	id: string;
	name: string;
	enabled: boolean;
	config: Record<string, unknown>;
	protocols: string[];
	tags?: string[];
	consumer?: {
		id: string;
	};
	service?: {
		id: string;
	};
	route?: {
		id: string;
	};
	created_at: string;
	updated_at: string;
}

export interface GroupMember {
	id: string;
	name: string;
	description?: string;
	type: string;
	cluster_type: string;
	cp_group_member_status?: {
		status: string;
		message: string;
		conflicts?: unknown[];
	};
	created_at: string;
	updated_at: string;
	[key: string]: unknown;
}

export interface GroupMembershipStatus {
	is_member?: boolean;
	group_id?: string;
	group_name?: string;
	status?: string;
	message?: string;
	conflicts?: unknown[];
	[key: string]: unknown;
}

// Additional types for enhanced features
export interface Certificate {
	id: string;
	cert: string;
	key: string;
	cert_alt?: string;
	key_alt?: string;
	cert_digest?: string;
	snis?: string[];
	tags?: string[];
	created_at: string;
	updated_at: string;
	[key: string]: unknown;
}

export interface Upstream {
	id: string;
	name: string;
	algorithm: string;
	hash_on?: string;
	hash_fallback?: string;
	hash_on_cookie?: string;
	hash_on_cookie_path?: string;
	hash_on_header?: string;
	hash_on_query_arg?: string;
	hash_fallback_header?: string;
	hash_fallback_query_arg?: string;
	hash_fallback_uri_capture?: string;
	hash_on_uri_capture?: string;
	slots: number;
	healthchecks?: unknown;
	tags?: string[];
	host_header?: string;
	client_certificate?: string;
	created_at: string;
	updated_at: string;
}

export interface UpstreamTarget {
	id: string;
	target: string;
	weight: number;
	tags?: string[];
	upstream: {
		id: string;
	};
	created_at: string;
	updated_at: string;
}

export interface DataPlaneNode {
	id: string;
	hostname: string;
	ip: string;
	last_seen: string;
	config_hash?: string;
	config_synced_at?: string;
	config_version?: string;
	cpu_usage?: number;
	memory_usage?: number;
	rps?: number;
	health_status?: string;
	health_checks?: Record<string, unknown>;
	last_health_check?: string;
	port?: number;
	protocol?: string;
	tls_enabled?: boolean;
	capabilities?: string[];
	last_sync?: string;
	recent_errors?: unknown[];
	registered_at?: string;
	labels?: Record<string, string>;
	status: string;
	version: string;
	created_at: string;
	updated_at: string;
	[key: string]: unknown;
}

// /control-planes/:id/nodes returns either { items, page, summary } or
// { data, meta } depending on Konnect version -- consumers fall back across
// both. Either field set may be absent at runtime, so both are optional and
// the additional health/connection fields land on each node via
// DataPlaneNode's index signature.
export interface DataPlaneNodeListResponse {
	items?: DataPlaneNode[];
	data?: DataPlaneNode[];
	summary?: {
		health_status?: string;
		[key: string]: unknown;
	};
	page?: {
		number?: number;
		size?: number;
		total?: number;
		total_count?: number;
	};
	meta?: KongPaginationMeta;
}

export interface SNI {
	id: string;
	name: string;
	certificate: {
		id: string;
	};
	tags?: string[];
	created_at: string;
	updated_at: string;
}

export interface ConsumerKey {
	id: string;
	key?: string;
	consumer: {
		id: string;
	};
	tags?: string[];
	created_at: string;
}

// Single-entity wrapper shape some endpoints use (e.g. POST/PUT certificate)
// where the response is `{ data: T }` rather than the entity directly. The
// existing consumer code reaches for `result.data.<field>` -- we mirror that.
export interface KongEntityResponse<T> {
	data: T;
}

// Generic list/paginated response shapes returned by the Kong Konnect API.
// Some endpoints use cursor-style pagination via `offset`/`total`, others use
// page[number]/page[size] and surface a `meta` object instead. Both are
// covered here so callers can pick whichever fits the endpoint.

export interface KongListResponse<T> {
	data: T[];
	offset?: string;
	total?: number;
	meta: KongPaginationMeta;
}

// Konnect's pagination meta shape varies a bit -- some endpoints surface
// page_count/total_count at the top level, others nest the same fields under
// page. Both are accepted; consumers reach for whichever the endpoint emits.
export interface KongPaginationMeta {
	page?: {
		number?: number;
		size?: number;
		total?: number;
		total_count?: number;
	};
	page_count?: number;
	total_count?: number;
	next_page?: {
		after?: string;
		before?: string;
	};
	[key: string]: unknown;
}

// Portal-* shapes carry an index signature for fields the Konnect API surfaces
// that aren't worth enumerating exhaustively (Konnect adds them faster than we
// can tighten -- consumers reach for them with optional chaining). The named
// fields cover the common path; the index keeps less-common ones accessible.

export interface PortalInfo {
	id: string;
	name: string;
	display_name?: string;
	description?: string;
	is_public?: boolean;
	auto_approve_developers?: boolean;
	auto_approve_applications?: boolean;
	default_domain: string;
	custom_domain?: string;
	custom_client_domain?: string;
	rbac_enabled?: boolean;
	default_application_auth_strategy_id?: string;
	developer_count?: number;
	application_count?: number;
	published_product_count?: number;
	created_at: string;
	updated_at: string;
	labels?: Record<string, string>;
	[key: string]: unknown;
}

export interface PortalApiSummary {
	id: string;
	name: string;
	slug?: string;
	description?: string;
	version?: string;
	status?: string;
	has_documentation?: boolean;
	document_count?: number;
	endpoints?: unknown[];
	auth_required?: boolean;
	auth_strategies?: string[];
	rate_limit?: number | { requests?: number; window?: string };
	tags?: string[];
	published_at?: string;
	created_at: string;
	updated_at: string;
	labels?: Record<string, string>;
	[key: string]: unknown;
}

export interface PortalApplication {
	id: string;
	name: string;
	description?: string;
	reference_id?: string;
	auth_strategy_id?: string;
	auth_strategy?: string;
	client_id?: string;
	client_secret?: string;
	redirect_uri?: string;
	scopes?: string[];
	status?: string;
	registrations?: unknown[];
	credentials?: unknown[];
	request_count?: number;
	last_used_at?: string;
	created_at: string;
	updated_at: string;
	labels?: Record<string, string>;
	[key: string]: unknown;
}

export interface PortalApplicationRegistration {
	id: string;
	status: string;
	api_id?: string;
	api_name?: string;
	api_version?: string;
	application_id?: string;
	permissions?: string[];
	requires_approval?: boolean;
	approval_status?: string;
	request_count?: number;
	last_used_at?: string;
	rate_limit?: number | { requests?: number; window?: string };
	approval_history?: Array<Record<string, unknown>>;
	expires_at?: string;
	renewable?: boolean;
	created_at: string;
	updated_at: string;
	[key: string]: unknown;
}

export interface PortalCredential {
	id: string;
	display_name?: string;
	name?: string;
	type?: string;
	key?: string;
	secret?: string;
	scopes?: string[];
	status?: string;
	expires_at?: string;
	last_used_at?: string;
	created_at: string;
	updated_at: string;
}

// Returned by POST /applications/:id/regenerate-secret. Field set is small enough
// to enumerate; more advanced fields can land here if Konnect adds them.
export interface PortalApplicationSecret {
	client_secret?: string;
	generated_at?: string;
	expires_at?: string;
	[key: string]: unknown;
}

export interface PortalApiActions {
	can_view?: boolean;
	can_register?: boolean;
	can_view_documentation?: boolean;
	can_request_access?: boolean;
	requires_authentication?: boolean;
	requires_approval?: boolean;
	[key: string]: unknown;
}

export interface PortalApiDocumentTree {
	sections?: unknown[];
	pages?: unknown[];
	navigation?: Record<string, unknown>;
	[key: string]: unknown;
}

// fetchPortalApiDocument can return either structured JSON metadata or raw
// content (yaml/html/markdown body). Callers fall back to the raw payload via
// `result.content || result` -- index signature keeps that pattern viable.
export interface PortalApiDocument {
	content?: unknown;
	title?: string;
	type?: string;
	updated_at?: string;
	[key: string]: unknown;
}

export interface PortalDeveloper {
	id: string;
	email: string;
	full_name?: string;
	organization?: string;
	status?: string;
	email_verification_required?: boolean;
	permissions?: string[];
	application_count?: number;
	last_login_at?: string;
	custom_attributes?: Record<string, string>;
}

export interface PortalAuthSession {
	token?: string;
	expires_at?: string;
	developer_id?: string;
	email?: string;
	full_name?: string;
	permissions?: string[];
}

// Analytics responses are intentionally loose -- shape varies by metric/dimension
// combination requested. Callers cherry-pick fields with optional chaining.
export interface PortalAnalyticsResponse {
	summary?: Record<string, unknown>;
	data?: Array<Record<string, unknown>>;
	breakdowns?: Record<string, unknown>;
	trends?: Record<string, unknown>;
	insights?: unknown[];
}

export interface PortalProduct {
	id: string;
	name: string;
	description?: string;
	product_id?: string;
	product_name?: string;
	status?: string;
	published_at?: string;
	created_at: string;
	updated_at: string;
	[key: string]: unknown;
}

export interface DataPlaneToken {
	id: string;
	name?: string;
	token?: string;
	status?: string;
	control_plane_endpoint?: string;
	telemetry_endpoint?: string;
	config_hash?: string;
	created_at: string;
	expires_at?: string;
	[key: string]: unknown;
}

export interface PluginSchema {
	name: string;
	fields?: Record<string, unknown>;
}

export interface ControlPlaneConfig {
	proxy_url?: string;
	telemetry_url?: string;
	auth_type?: string;
	cloud_gateway?: boolean;
	analytics_enabled?: boolean;
	certificates?: Record<string, unknown>;
	proxy_endpoint?: string;
	admin_endpoint?: string;
	telemetry_endpoint?: string;
	enabled_features?: string[];
	limits?: Record<string, unknown>;
	config_version?: string;
	updated_at?: string;
	warnings?: string[];
	[key: string]: unknown;
}

export interface UpstreamHealth {
	id: string;
	name?: string;
	health?: string;
	nodes?: Array<{
		address?: string;
		status?: string;
		weight?: number;
	}>;
}
