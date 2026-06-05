import { existsSync, readFileSync } from "fs"
import path from "path"

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
