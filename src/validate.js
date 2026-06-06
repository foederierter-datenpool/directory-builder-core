import { CDP, objectsOf, parseTtl, PATHS, sourceName } from "./utils.js"
import path from "path"
import fs from "fs"

// Instance integrity checks. Each check takes { abs, quads } (path resolver
// rooted at the instance, parsed federation.ttl) and returns problem strings.
// validate() runs them all; empty result = valid. Runs automatically before
// the engines; `directory-builder validate` triggers it on its own.

const checks = [sourcesFoldersInSync, secondValidationTest]

export function validate(root = process.cwd()) {
    const abs = (p) => path.join(root, p)
    if (!fs.existsSync(abs(PATHS.federation))) return [`${PATHS.federation} missing`]
    const quads = parseTtl(fs.readFileSync(abs(PATHS.federation), "utf8"))
    return checks.flatMap((check) => check({ abs, quads }))
}

// Every :hasSource in federation.ttl has its sources/<name>/ folder with
// fetch.js + clean.sparql - and no folder exists that the federation doesn't
// declare. Checks all declared sources, enabled or not: folder presence is a
// repo-layout contract.
function sourcesFoldersInSync({ abs, quads }) {
    const declared = objectsOf(quads, `${CDP}hasSource`).map(sourceName)
    const problems = []
    for (const name of declared) {
        for (const file of [PATHS.fetchScript(name), PATHS.cleanQuery(name)]) {
            if (!fs.existsSync(abs(file))) problems.push(`${file} missing`)
        }
    }
    const folders = fs.existsSync(abs("sources"))
        ? fs.readdirSync(abs("sources"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
        : []
    for (const name of folders) {
        if (!declared.includes(name)) problems.push(`sources/${name}/ has no :hasSource declaration in ${PATHS.federation}`)
    }
    return problems
}

function secondValidationTest({ abs, quads }) {
    // TODO
    return []
}
