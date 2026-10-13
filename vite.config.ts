import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const apiPort = Number(process.env.PORT ?? 3001);

export default defineConfig({
  root: r("./src/web"),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": r("./src/web"),
      "@shared": r("./src/shared"),
      "@server": r("./src/server"),
    },
  },
  server: {
    port: 5173,
    proxy: { "/api": `http://localhost:${apiPort}` },
  },
  build: {
    outDir: r("./dist/web"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
});
