/* src/types/mcp.d.ts */

declare module "@modelcontextprotocol/sdk/server/sse.js" {
	export interface JSONRPCMessage {
		method: string;
		jsonrpc: "2.0";
		id: string | number;
		params?: {
			[x: string]: unknown;
			_meta?: {
				[x: string]: unknown;
				progressToken?: string | number;
			};
		};
	}

	export interface TransportSendOptions {
		[key: string]: unknown;
	}

	export interface Transport {
		start(): Promise<void>;
		send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>;
		close(): Promise<void>;
	}

	export class SSEServerTransport implements Transport {
		constructor(port: string | number, path: string);
		start(): Promise<void>;
		send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>;
		close(): Promise<void>;
	}
}

declare module "@modelcontextprotocol/sdk/server/stdio.js" {
	import { Transport, JSONRPCMessage, TransportSendOptions } from "@modelcontextprotocol/sdk/server/sse.js";

	export class StdioServerTransport implements Transport {
		constructor();
		start(): Promise<void>;
		send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>;
		close(): Promise<void>;
	}
}
