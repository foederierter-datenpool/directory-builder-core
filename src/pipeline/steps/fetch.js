import { PATHS } from "../../utils.js"
import { execSync } from "child_process"
import { run } from "../run.js"
import fs from "fs"

// Fetch step: run the source's fetch.js. Live sources pass their :fetchUrl;
// static-file sources pass the absolute static dir instead — the script gets
// whichever applies, plus the federation's run params as one JSON argument.
// Returns the harvest record for the ingest log.
export const runFetch = ({ abs, root }, { name, fetchUrl, paramsJson }) => {
    const outDir = PATHS.raw(name)
    const origin = fetchUrl ?? abs(PATHS.staticDir(name))
    console.log(`fetch  ${fetchUrl ?? PATHS.staticDir(name)} (params ${paramsJson}) → ${outDir}`)
    // Clear any prior output first, so changed run params (or changed records) can't leave stale files behind
    fs.rmSync(abs(outDir), { recursive: true, force: true })
    fs.mkdirSync(abs(outDir), { recursive: true })
    run("node", [abs(PATHS.fetchScript(name)), abs(outDir), origin, paramsJson])
    const harvest = { time: new Date().toISOString() }
    // Static sources have no live harvest — record the files' git commit
    // time instead (the freshness the Sources page shows for them).
    if (!fetchUrl) try {
        const iso = execSync(`git log -1 --format=%cI -- "${PATHS.staticDir(name)}"`, { cwd: root, encoding: "utf8" }).trim()
        if (iso) harvest.staticCommittedAt = iso
    } catch { /* not committed yet / no git → omit */ }
    return harvest
}
