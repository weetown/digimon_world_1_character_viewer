import { resolve } from "node:path";

import arrayBufferFilesTransformer from "./arrayBufferFilesTransformer";

// One app, two pages: the viewer at / and the poser at /poser/, served and built together
/** @type {import('vite').UserConfig} */
export default {
  plugins: [arrayBufferFilesTransformer()],
  build: {
    rollupOptions: {
      input: {
        viewer: resolve(__dirname, "index.html"),
        poser: resolve(__dirname, "poser/index.html"),
      },
    },
  },
};
