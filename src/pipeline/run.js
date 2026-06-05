import { spawnSync } from "child_process"

// Run an external command (a fetcher's node process, SPARQL Anything's java),
// inheriting stdio; non-zero exit aborts the step.
export const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { stdio: "inherit" })
    if (r.status !== 0) throw new Error(`Exit ${r.status}: ${cmd} ${args.join(" ")}`)
}
