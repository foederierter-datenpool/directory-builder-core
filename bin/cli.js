#!/usr/bin/env node
// Config-only entry: a default Pipeline rooted at the invoking instance
// (npm runs scripts with cwd = the instance's package dir, so a downstream
// repo needs nothing but config/ + sources/ and this on its PATH).
//   directory-builder            run the full pipeline (ingest + federate)
//   directory-builder ingest     fetch + lift only
//   directory-builder federate   clean → map → match → merge → resolve only

import { Pipeline } from "../src/pipeline.js"

const pipeline = new Pipeline()
const commands = {
    run:      () => pipeline.run(),
    ingest:   () => pipeline.ingest(),
    federate: () => pipeline.federate(),
}

const cmd = process.argv[2] ?? "run"
if (!commands[cmd]) {
    console.error(`Unknown command "${cmd}" — expected one of: ${Object.keys(commands).join(", ")}`)
    process.exit(1)
}
await commands[cmd]()
