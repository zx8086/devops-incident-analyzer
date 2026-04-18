// apps/web/test-preload.ts
import { plugin } from "bun";
import { SveltePlugin } from "bun-plugin-svelte";

plugin(SveltePlugin({ forceSide: "server" }));
