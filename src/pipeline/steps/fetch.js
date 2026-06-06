import { PATHS } from "../../utils.js"
import { execSync } from "child_process"
import { run } from "../run.js"
import fs from "fs"

// Fetch step: run the source's fetch.js. Live sources pass their :fetchUrl;
// static-file sources pass the absolute static dir instead — the script gets
// whichever applies, plus the federation's run params as one JSON argument.
// fetch.js is optional for static sources: without it, the default fetch
// copies static/ verbatim. Returns the harvest record for the ingest log.
export const runFetch = ({ abs, root }, { name, fetchUrl, paramsJson }) => {
    const outDir = PATHS.raw(name)
    const origin = fetchUrl ?? abs(PATHS.staticDir(name))
    console.log(`fetch  ${fetchUrl ?? PATHS.staticDir(name)} (params ${paramsJson}) → ${outDir}`)
    // Clear any prior output first, so changed run params (or changed records) can't leave stale files behind
    fs.rmSync(abs(outDir), { recursive: true, force: true })
    fs.mkdirSync(abs(outDir), { recursive: true })
    const script = abs(PATHS.fetchScript(name))
    if (fs.existsSync(script)) run("node", [script, abs(outDir), origin, paramsJson])
    else localCopyFallback({ name, fetchUrl, origin, outDir: abs(outDir) })
    const harvest = { time: new Date().toISOString() }
    // Static sources have no live harvest — record the files' git commit
    // time instead (the freshness the Sources page shows for them).
    if (!fetchUrl) try {
        const iso = execSync(`git log -1 --format=%cI -- "${PATHS.staticDir(name)}"`, { cwd: root, encoding: "utf8" }).trim()
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
