import { serveInstanceData } from "./vite.js"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import path from "path"

// Core's own dev shell: serves the webapp against an instance directory —
// example/ by default, any other via INSTANCE (path relative to cwd):
//   INSTANCE=../sosuse-directory-builder npm run webapp
const instance = path.resolve(process.env.INSTANCE ?? path.join(import.meta.dirname, "../example"))

export default defineConfig({
    plugins: [react(), serveInstanceData({ root: instance })],
    build: { target: "es2022" },  // top-level await in instanceData.js
})
