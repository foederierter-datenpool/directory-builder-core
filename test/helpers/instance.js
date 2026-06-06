import { PATHS } from "@directory-builder/core/utils"
import path from "path"
import fs from "fs"

// SPARQL Anything cache shared with example/ — a fixture's tools/ symlinks
// here, so test runs never re-download the jar.
const TOOLS_CACHE = path.join(import.meta.dirname, "../../example/tools")

// Materialize an in-test instance definition (federation.ttl string + records
// per source) into test/tmp/<name>/ — a real instance folder the engines run
// against, wiped at setup and left in place afterwards for inspection.
export const makeInstance = (name, { federation, sources }) => {
    const root = path.join(import.meta.dirname, "../tmp", name)
    fs.rmSync(root, { recursive: true, force: true })
    fs.mkdirSync(path.join(root, "config"), { recursive: true })
    fs.writeFileSync(path.join(root, PATHS.federation), federation)
    for (const [source, records] of Object.entries(sources)) {
        fs.mkdirSync(path.join(root, PATHS.staticDir(source)), { recursive: true })
        fs.writeFileSync(path.join(root, PATHS.staticDir(source), "data.json"), JSON.stringify(records, null, 4))
    }
    fs.mkdirSync(TOOLS_CACHE, { recursive: true })
    fs.symlinkSync(TOOLS_CACHE, path.join(root, "tools"))
    return root
}
