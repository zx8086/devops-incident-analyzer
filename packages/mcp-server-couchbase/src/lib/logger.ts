/* src/lib/logger.ts */

import { config } from "../config";

interface LogMetadata {
	requestId?: string;
	operation?: string;
	duration?: number;
	[key: string]: any;
}

interface LogData {
	timestamp: string;
	level: string;
	context: string;
	message: string;
	[key: string]: any;
}

class Logger {
	private context: string;
	private metadata: LogMetadata;

	constructor(context: string = "app", metadata: LogMetadata = {}) {
		this.context = context;
		this.metadata = metadata;
	}

	private formatMessage(level: string, message: string, metadata: LogMetadata = {}): string {
		const timestamp = new Date().toISOString();
		const logData: LogData = {
			timestamp,
			level,
			context: this.context,
			message,
			...this.metadata,
			...metadata,
		};

		// Remove undefined values
		Object.keys(logData).forEach((key) => {
			if (logData[key] === undefined) {
				delete logData[key];
			}
		});

		// Format based on configuration
		const format = config?.logging?.format || "json";
		return format === "json" ? JSON.stringify(logData) : `${timestamp} [${level}] ${this.context}: ${message}`;
	}

	private shouldLog(level: string): boolean {
		const levels = ["debug", "info", "warn", "error"];
		const configLevel = config?.logging?.level || "info";
		return levels.indexOf(level) >= levels.indexOf(configLevel);
	}

	private writeToStderr(message: string): void {
		process.stderr.write(message + "\n");
	}

	debug(message: string, metadata: LogMetadata = {}): void {
		if (this.shouldLog("debug")) {
			this.writeToStderr(this.formatMessage("DEBUG", message, metadata));
		}
	}

	info(message: string, metadata: LogMetadata = {}): void {
		if (this.shouldLog("info")) {
			this.writeToStderr(this.formatMessage("INFO", message, metadata));
		}
	}

	warn(message: string, metadata: LogMetadata = {}): void {
		if (this.shouldLog("warn")) {
			this.writeToStderr(this.formatMessage("WARN", message, metadata));
		}
	}

	error(message: string, metadata: LogMetadata = {}): void {
		if (this.shouldLog("error")) {
			this.writeToStderr(this.formatMessage("ERROR", message, metadata));
		}
	}

	setContext(context: string): void {
		this.context = context;
	}

	setMetadata(metadata: LogMetadata): void {
		this.metadata = { ...this.metadata, ...metadata };
	}

	clearMetadata(): void {
		this.metadata = {};
	}
}

// Create a default logger instance
export const logger = new Logger();

// Helper function to create a child logger with a specific context
export function createContextLogger(context: string, metadata: LogMetadata = {}): Logger {
	return new Logger(context, metadata);
}

// Helper function to measure operation duration
export function measureOperation<T>(operation: string, fn: () => Promise<T>, metadata: LogMetadata = {}): Promise<T> {
	const startTime = Date.now();
	return fn().finally(() => {
		const duration = Date.now() - startTime;
		logger.debug(`Operation completed: ${operation}`, {
			...metadata,
			operation,
			duration,
		});
	});
}
