import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Same-origin in dev: /api/* is forwarded to the backend, so the API needs no CORS config.
    proxy: {
      "/api": { target: "http://127.0.0.1:3000", rewrite: (p) => p.replace(/^\/api/, "") },
    },
  },
});
