import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `npm run web:dev` serves the page with hot reload and forwards /api to the
// signup server (`npm run dev` at the repo root, port 8788). `npm run web:build`
// writes web/dist, which the signup server serves at / in place of its fallback page.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8788" } },
});
