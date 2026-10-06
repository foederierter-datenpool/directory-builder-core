import { PATHS } from "../../utils.js"
import { execSync } from "child_process"
import { run } from "../run.js"
import fs from "fs"
import path from "path"
import { randomUUID } from "node:crypto"

// Fetch step: run the source's fetch.js. Live sources pass their :fetchUrl;
// static-file sources pass the absolute static dir instead — the script gets
// whichever applies, plus the effective run params as one JSON argument.
// fetch.js is optional for static sources: without it, the default fetch
// copies static/ verbatim. Returns the harvest record for the ingest log.
export const runFetch = async ({ abs, root }, { name, fetchUrl, paramsJson }) => {
    const outDir = PATHS.raw(name)
    const origin = fetchUrl ?? abs(PATHS.staticDir(name))
    console.log(`fetch  ${fetchUrl ?? PATHS.staticDir(name)} (params ${paramsJson}) → ${outDir}`)
    const target = path.resolve(abs(outDir))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const staged = fs.mkdtempSync(path.join(path.dirname(target), `.${name}-fetch-`))
    const script = abs(PATHS.fetchScript(name))
    try {
        if (fs.existsSync(script)) await run("node", [script, staged, origin, paramsJson], { label: name })
        else localCopyFallback({ name, fetchUrl, origin, outDir: staged })
        const backup = `${target}.previous-${randomUUID()}`
        if (fs.existsSync(target)) fs.renameSync(target, backup)
        try { fs.renameSync(staged, target) }
        catch (error) {
            if (fs.existsSync(backup)) fs.renameSync(backup, target)
            throw error
        }
        fs.rmSync(backup, { recursive: true, force: true })
    } finally {
        fs.rmSync(staged, { recursive: true, force: true })
    }
    const harvest = { time: new Date().toISOString() }
    // Static sources have no live harvest — record the files' git commit
    // time instead (the freshness the Sources page shows for them).
    // stderr is discarded, not inherited: the failure here is expected and
    // already handled — an instance that isn't a git repo, or static files not
    // committed yet — but git still prints "fatal: not a git repository", once
    // per static source, which reads like a real error in an otherwise clean run.
    if (!fetchUrl) try {
        const iso = execSync(`git log -1 --format=%cI -- "${PATHS.staticDir(name)}"`,
            { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
        if (iso) harvest.staticCommittedAt = iso
    } catch { /* not committed yet / no git → omit */ }
    return harvest
}

// Fallback when a source ships no dedicated fetch.js: static sources get
// their static/ dir copied verbatim; live sources have no fallback yet.
const localCopyFallback = ({ name, fetchUrl, origin, outDir }) => {
    if (fetchUrl) throw new Error(`${PATHS.fetchScript(name)} missing (no default fetch for live sources yet)`)
    fs.cpSync(origin, outDir, { recursive: true })
}
