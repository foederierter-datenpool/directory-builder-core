import { spawn } from "child_process"

// Run an external command (a fetcher's node process, SPARQL Anything's java);
// non-zero exit aborts the step.
//
// Output is captured and re-emitted a line at a time behind `label` rather than
// inherited, because sources run concurrently: several children writing to one
// terminal at once interleave mid-line and the result is unreadable. The label
// is what makes concurrent output attributable to a source at all.
//
// A child that redraws a line (a progress counter writing \r) gets one line per
// redraw here instead. That is the cost of attributable output; a fetcher that
// wants terse logs should print less rather than redraw.
// `out`/`err` exist so a test can read what a child produced without
// commandeering the process's own streams; production always uses the defaults.
export const run = (cmd, args, { label, out = process.stdout, err = process.stderr } = {}) => new Promise((resolve, reject) => {
    const child = spawn(cmd, args)
    const prefix = label ? `[${label}] ` : ""
    // Partial lines are held until their newline arrives, so a chunk boundary
    // mid-line cannot split one source's output across another's.
    const pump = (stream, sink) => {
        let held = ""
        stream.setEncoding("utf8")
        stream.on("data", (chunk) => {
            const lines = (held + chunk).split(/\r?\n|\r/)
            held = lines.pop() ?? ""
            for (const line of lines) if (line !== "") sink.write(`${prefix}${line}\n`)
        })
        stream.on("end", () => { if (held !== "") sink.write(`${prefix}${held}\n`) })
    }
    pump(child.stdout, out)
    pump(child.stderr, err)
    child.on("error", reject)
    child.on("close", (status) => status === 0
        ? resolve()
        : reject(new Error(`Exit ${status}: ${cmd} ${args.join(" ")}`)))
})
