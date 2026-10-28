/**
 * BFF bundle configuration.
 *
 * Vite is already a dev dependency and can compile the server as an SSR
 * bundle, which keeps the build toolchain single-source (no esbuild/tsup
 * addition) and emits one ESM file with Node builtins left external.
 *
 *   vite build --config vite.bff.config.ts  →  dist-server/bff.mjs
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    ssr: path.resolve(__dirname, "server/bff/main.ts"),
    outDir: path.resolve(__dirname, "dist-server"),
    emptyOutDir: true,
    target: "node22",
    minify: false,
    sourcemap: true,
    rollupOptions: {
      output: {
        format: "es",
        entryFileNames: "bff.mjs",
      },
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
