import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // ws: the presence WebSocket upgrades through the same proxy.
      "/api": { target: "http://127.0.0.1:8787", ws: true },
    },
  },
});
