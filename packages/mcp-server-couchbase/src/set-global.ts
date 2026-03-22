/* src/set-global.ts */

import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

// Set required global variables for Couchbase SDK
globalThis.CN_ROOT = path.join(rootDir, "node_modules", "couchbase");
globalThis.CXXCBC_CACHE_DIR = path.join(rootDir, "node_modules", "couchbase", "deps", "couchbase-cxx-cache");
globalThis.ENV_TRUE = ["true", "1", "y", "yes", "on"];

// Set other required environment variables
process.env.CB_SSL_MODE = "none";
process.env.CB_SSL_CERT = "";
process.env.CB_SSL_KEY = "";
