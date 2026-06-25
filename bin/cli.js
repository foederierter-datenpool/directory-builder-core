#!/usr/bin/env node
// Config-only entry: a default Pipeline rooted at the invoking instance
// (npm runs scripts with cwd = the instance's package dir, so a downstream
// repo needs nothing but config/ + sources/ and this on its PATH).
//   directory-builder                          run the full pipeline (ingest + federate)
//   directory-builder init                      scaffold config/ + sources/ from the bundled example
//   directory-builder ingest                   fetch + lift only
//   directory-builder federate                 clean → map → match → merge → resolve only
//   directory-builder validate                 check the instance's config ↔ sources/ integrity
//   directory-builder webapp                   dev server for the instance's webapp
//   directory-builder webapp build [--base /x/]  build the webapp → <instance>/webapp/dist/

import { webappBuild, webappDev } from "../src/webapp.js"
import { Pipeline } from "../src/pipeline.js"
import { validate } from "../src/validate.js"
import { init } from "../src/scaffold.js"

const [cmd = "run", ...rest] = process.argv.slice(2)
const flag = (name) => {
    const i = rest.indexOf(`--${name}`)
    return i >= 0 ? rest[i + 1] : rest.find((a) => a.startsWith(`--${name}=`))?.split("=")[1]
}

const pipeline = new Pipeline()
const commands = {
    init:     () => {
        let dirs
        try { dirs = init() }
        catch (e) { console.error(e.message); process.exit(1) }
        console.log(`scaffolded ${dirs.join("/, ")}/ — edit config/federation.ttl, then run \`npx directory-builder\``)
    },
    run:      () => pipeline.run(),
    ingest:   () => pipeline.ingest(),
    federate: () => pipeline.federate(),
    validate: async () => {
        const problems = await validate()
        if (problems.length) { console.error(problems.join("\n")); process.exit(1) }
        console.log("instance valid")
    },
    webapp:   () => {
        if (rest[0] && rest[0] !== "build") {
            console.error(`Unknown webapp subcommand "${rest[0]}" — expected "build" or nothing (dev server)`)
            process.exit(1)
        }
        return rest[0] === "build" ? webappBuild(process.cwd(), { base: flag("base") }) : webappDev()
    },
}

if (!commands[cmd]) {
    console.error(`Unknown command "${cmd}" — expected one of: ${Object.keys(commands).join(", ")}`)
    process.exit(1)
}
await commands[cmd]()
