import path from "path"
import fs from "fs"

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
    const outDir = path.join(root, "webapp/dist")
    await build({
        configFile: CONFIG,
        root: WEBAPP,
        ...(base ? { base } : {}),
        build: { outDir, emptyOutDir: true },
    })
    // The bundle fetches the instance's config, data and webapp/{content,
    // exporters} at runtime — they are part of the deployable, so stage them
    // next to it (URL paths mirror the repo paths).
    const staged = ["config", "data", "webapp/content", "webapp/exporters"].filter((dir) => {
        const from = path.join(root, dir)
        if (!fs.existsSync(from)) return false
        fs.cpSync(from, path.join(outDir, dir), { recursive: true })
        return true
    })
    console.log(`staged ${staged.join(", ")} → webapp/dist/`)
}
