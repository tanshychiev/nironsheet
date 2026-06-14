import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";


export default defineConfig({
  plugins: [react()],

  build: {
    outDir: "../static/niron_builder",
    emptyOutDir: true,
    cssCodeSplit: false,

    rollupOptions: {
      input: resolve(__dirname, "src/main.jsx"),

      output: {
        entryFileNames: "builder.js",

        chunkFileNames: "chunks/[name]-[hash].js",

        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith(".css")) {
            return "builder.css";
          }

          return "assets/[name]-[hash][extname]";
        },
      },
    },
  },
});