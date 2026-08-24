import { existsSync, readFileSync, readdirSync } from "fs"
import path from "path"

const DATA_FILES_MODULE = "virtual:instance-data-files"
const RESOLVED_DATA_FILES_MODULE = `\0${DATA_FILES_MODULE}`

// Every public artifact under data/, as a URL-shaped relative path. Hidden
// operating-system files are not pipeline artifacts and stay out of the index.
export function instanceDataFiles(root) {
    const dataRoot = path.join(root, "data")
    if (!existsSync(dataRoot)) return []

    const files = []
    const visit = (directory, relative = "data") => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (entry.name.startsWith(".")) continue
            const file = path.join(directory, entry.name)
            const publicPath = `${relative}/${entry.name}`
            if (entry.isDirectory()) visit(file, publicPath)
            else if (entry.isFile()) files.push(publicPath)
        }
    }
    visit(dataRoot)
    return files.sort()
}

// Pipeline.jsx needs a directory inventory, while the files themselves remain
// runtime-served static artifacts. A virtual module puts the build-time list in
// the bundle without creating another public metadata file.
export function instanceDataIndex({ root = process.cwd() } = {}) {
    return {
        name: "instance-data-index",
        resolveId(id) {
            if (id === DATA_FILES_MODULE) return RESOLVED_DATA_FILES_MODULE
        },
        load(id) {
            if (id === RESOLVED_DATA_FILES_MODULE)
                return `export default ${JSON.stringify(instanceDataFiles(root))}`
        },
    }
}

// instanceData.js fetches config/ and data/ at runtime relative to BASE_URL,
// and Download.jsx dynamic-imports declared exporters/ the same way. A deploy
// publishes them next to the bundle; in dev (and preview) this middleware
// serves them from the instance directory instead. `root` is the instance dir
// holding config/, data/ and (optionally) webapp/{content,exporters}/.
export function serveInstanceData({ root = process.cwd() } = {}) {
    let base = "/"
    const middleware = (req, res, next) => {
        const url = req.url.split("?")[0]
        const rel = url.startsWith(base) ? url.slice(base.length) : null
        if (!rel || !/^(config|data|webapp\/(content|exporters))\//.test(rel)) return next()
        const file = path.join(root, rel)
        // Own the 404: falling through would hit the SPA fallback, which
        // serves index.html with 200 — instanceData would parse HTML as TTL.
        if (!existsSync(file)) { res.statusCode = 404; return res.end() }
        res.setHeader("Content-Type", { js: "text/javascript", md: "text/markdown", sparql: "application/sparql-query" }[rel.split(".").pop()] ?? "text/turtle")
        res.end(readFileSync(file))
    }
    return {
        name: "serve-instance-data",
        configResolved(c) { base = c.base },
        configureServer(server) { server.middlewares.use(middleware) },
        configurePreviewServer(server) { server.middlewares.use(middleware) },
    }
}
