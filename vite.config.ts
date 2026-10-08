import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 개발 모드: 화면은 5173, API 는 4100 서버로 넘김
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: { port: 5173, proxy: { "/api": "http://localhost:4100" } },
});
