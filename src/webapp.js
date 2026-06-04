import path from "path"

// The webapp ships with this package as source; these run it through vite's
// JS API for an instance directory — dev server or dist build. The vite
// project root is the package's webapp/; the instance root reaches the config
// via the INSTANCE env var (see webapp/vite.config.js). vite is imported
// lazily so engine-only CLI runs never load it.

const WEBAPP = path.join(import.meta.dirname, "../webapp")
const CONFIG = path.join(WEBAPP, "vite.config.js")

export async function webappDev(root = process.cwd()) {
    const { createServer } = await import("vite")
    process.env.INSTANCE = root
    const server = await createServer({ configFile: CONFIG, root: WEBAPP })
    await server.listen()
    server.printUrls()
}

export async function webappBuild(root = process.cwd(), { base } = {}) {
    const { build } = await import("vite")
    process.env.INSTANCE = root
    await build({
        configFile: CONFIG,
        root: WEBAPP,
        ...(base ? { base } : {}),
        build: { outDir: path.join(root, "dist"), emptyOutDir: true },
    })
}
