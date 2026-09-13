import { existsSync, readFileSync, readdirSync, statSync } from "fs"
import path from "path"

const DATA_FILES_MODULE = "virtual:instance-data-files"
const RESOLVED_DATA_FILES_MODULE = `\0${DATA_FILES_MODULE}`
const directoryEntries = (root, relative) => readdirSync(path.join(root, relative), { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isFile()))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))

// Every public artifact under data/, as a URL-shaped relative path. Hidden
// operating-system files are not pipeline artifacts and stay out of the index.
export function instanceDataFiles(root) {
    const dataRoot = path.join(root, "data")
    if (!existsSync(dataRoot)) return []

    const files = []
    const visit = (directory, relative = "data") => {
        for (const entry of directoryEntries(root, relative)) {
            const file = path.join(directory, entry.name)
            const publicPath = `${relative}/${entry.name}`
            if (entry.isDirectory()) visit(file, publicPath)
            else if (entry.isFile()) files.push(publicPath)
        }
    }
    visit(dataRoot)
    return files.sort()
}

const escapeHtml = (text) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])

const directoryIndex = (relative, entries) => {
    const title = escapeHtml(`${relative}/`)
    const items = entries.map((entry) => {
        const suffix = entry.isDirectory() ? "/" : ""
        return `<li><a href="${encodeURIComponent(entry.name)}${suffix}">${escapeHtml(entry.name)}${suffix}</a></li>`
    })
    return `<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n<title>${title}</title>\n<h1>${title}</h1>\n<ul>\n<li><a href="../">../</a></li>\n${items.join("\n")}\n</ul>\n</html>\n`
}

// Pipeline.jsx reads a virtual file inventory. Every data directory also has a
// plain HTML index for browsing artifacts without the webapp.
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
        generateBundle() {
            const visit = (relative) => {
                const entries = directoryEntries(root, relative)
                if (!entries.some((entry) => entry.name === "index.html"))
                    this.emitFile({ type: "asset", fileName: `${relative}/index.html`, source: directoryIndex(relative, entries) })
                for (const entry of entries.filter((entry) => entry.isDirectory())) visit(`${relative}/${entry.name}`)
            }
            if (existsSync(path.join(root, "data"))) visit("data")
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
        let url
        try { url = decodeURIComponent(req.url.split("?")[0]) }
        catch { res.statusCode = 400; return res.end() }
        const rel = url.startsWith(base) ? url.slice(base.length) : null
        if (!rel || !/^(config|data|webapp\/(content|exporters))(\/|$)/.test(rel)) return next()
        if (rel.split("/").some((part) => part.startsWith("."))) { res.statusCode = 404; return res.end() }
        const directory = rel.replace(/\/index\.html$/, "").replace(/\/$/, "")
        const directoryPath = path.join(root, directory)
        if (/^data(\/|$)/.test(directory) && existsSync(directoryPath) && statSync(directoryPath).isDirectory()) {
            if (rel === directory) {
                res.writeHead(301, { Location: `${base}${directory.split("/").map(encodeURIComponent).join("/")}/` })
                return res.end()
            }
            const index = path.join(directoryPath, "index.html")
            res.setHeader("Content-Type", "text/html; charset=utf-8")
            return res.end(existsSync(index) ? readFileSync(index) : directoryIndex(directory, directoryEntries(root, directory)))
        }
        const file = path.join(root, rel)
        // Own the 404: falling through would hit the SPA fallback, which
        // serves index.html with 200 — instanceData would parse HTML as TTL.
        if (!existsSync(file) || !statSync(file).isFile()) { res.statusCode = 404; return res.end() }
        res.setHeader("Content-Type", { html: "text/html", js: "text/javascript", md: "text/markdown", sparql: "application/sparql-query" }[rel.split(".").pop()] ?? "text/turtle")
        res.end(readFileSync(file))
    }
    return {
        name: "serve-instance-data",
        configResolved(c) { base = c.base },
        configureServer(server) { server.middlewares.use(middleware) },
        configurePreviewServer(server) { server.middlewares.use(middleware) },
    }
}
