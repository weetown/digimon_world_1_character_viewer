// Builds src/runtime/digimon-swaps.ts as a standalone ES module (three as a peer).
// `yarn build:runtime` -> dist/runtime/digimon-swaps.js

import { resolve } from "node:path";

/** @type {import('vite').UserConfig} */
export default {
  build: {
    outDir: "dist/runtime",
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, "src/runtime/digimon-swaps.ts"),
      formats: ["es"],
      fileName: () => "digimon-swaps.js",
    },
    rollupOptions: {
      external: ["three"],
    },
  },
};
