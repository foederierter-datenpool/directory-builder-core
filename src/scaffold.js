import fs from "fs"
import path from "path"
import { PATHS } from "./utils.js"

// Scaffold a fresh use-case instance: copy the bundled example's config/ and
// sources/ into the target dir, giving a runnable federation to edit down from.
// data/ and tools/ are regenerable (the lift step downloads the jar on demand),
// so they're not scaffolded. Refuses to clobber an existing federation.

// The example ships with the package: .gitignore keeps its generated dirs
// (data/, tools/, webapp/) out, leaving config/ + sources/ to publish — the two
// we copy. It doubles as the starting dataset for a new instance.
const EXAMPLE = path.join(import.meta.dirname, "..", "example")
const SCAFFOLD_DIRS = ["config", "sources"]

function copyDir(from, to) {
    fs.mkdirSync(to, { recursive: true })
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const src = path.join(from, entry.name)
        const dst = path.join(to, entry.name)
        if (entry.isDirectory()) copyDir(src, dst)
        else fs.copyFileSync(src, dst)
    }
}

export function init(target = process.cwd()) {
    const federation = path.join(target, PATHS.federation)
    if (fs.existsSync(federation))
        throw new Error(`${PATHS.federation} already exists at ${target} — refusing to overwrite`)
    for (const dir of SCAFFOLD_DIRS) copyDir(path.join(EXAMPLE, dir), path.join(target, dir))
    return SCAFFOLD_DIRS
}
