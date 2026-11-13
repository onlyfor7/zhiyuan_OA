import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// https://vite.dev/config/
export default defineConfig({
  base: '/',
  plugins: [inspectAttr(), react()],
  server: {
    port: 3000,
    proxy: {
      "/trpc": "http://localhost:3001",
      "/files": "http://localhost:3001",
      /** §20.3 SSE 透传（dev）：/events 走 server 事件流，vite 默认 SPA 兜底会吞流 */
      "/events": "http://localhost:3001",
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom", "scheduler"],
          "vendor-data": ["@tanstack/react-query", "@trpc/client", "@trpc/tanstack-react-query"],
          "vendor-router": ["react-router"],
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
