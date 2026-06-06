import { buildValidator, turtleToDataset } from "@foerderfunke/sem-ops-utils"
import { CDP, identifierFieldPath, objectsOf, parseTtl, PATHS, shrink, sourceName } from "./utils.js"
import path from "path"
import fs from "fs"

// Instance integrity checks. Each check takes { abs, ttl, quads } (path
// resolver rooted at the instance, federation.ttl raw + parsed) and returns
// problem strings. validate() runs them all; empty result = valid. Runs
// automatically before the engines; `directory-builder validate` triggers it
// on its own.

const checks = [sourcesFoldersInSync, federationConformsToShape]

export async function validate(root = process.cwd()) {
    const abs = (p) => path.join(root, p)
    if (!fs.existsSync(abs(PATHS.federation))) return [`${PATHS.federation} missing`]
    const ttl = fs.readFileSync(abs(PATHS.federation), "utf8")
    const ctx = { abs, ttl, quads: parseTtl(ttl) }
    return (await Promise.all(checks.map((check) => check(ctx)))).flat()
}

// Every :hasSource in federation.ttl has what its engine steps need: a
// fetch.js or static/ to default to, a clean.sparql or a schema:identifier
// mapping to derive the default clean from - and no sources/ folder exists
// that the federation doesn't declare. Checks all declared sources, enabled
// or not: folder presence is a repo-layout contract.
function sourcesFoldersInSync({ abs, quads }) {
    const declared = objectsOf(quads, `${CDP}hasSource`)
    const problems = []
    for (const iri of declared) {
        const name = sourceName(iri)
        if (![PATHS.fetchScript(name), PATHS.staticDir(name)].some((f) => fs.existsSync(abs(f))))
            problems.push(`${PATHS.fetchScript(name)} missing and no ${PATHS.staticDir(name)} to default to`)
        if (!fs.existsSync(abs(PATHS.cleanQuery(name))) && !identifierFieldPath(quads, iri))
            problems.push(`${PATHS.cleanQuery(name)} missing and no schema:identifier mapping to derive the default clean from`)
    }
    const declaredNames = declared.map(sourceName)
    const folders = fs.existsSync(abs("sources"))
        ? fs.readdirSync(abs("sources"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
        : []
    for (const name of folders) {
        if (!declaredNames.includes(name)) problems.push(`sources/${name}/ has no :hasSource declaration in ${PATHS.federation}`)
    }
    return problems
}

// federation.ttl conforms to the engine's config contract, expressed as SHACL
// in federation.shacl.ttl next to this file - the shape ships with the
// package, instances never carry it.
const validator = buildValidator(fs.readFileSync(path.join(import.meta.dirname, "validate/federation.shacl.ttl"), "utf8"))

async function federationConformsToShape({ ttl }) {
    const report = await validator.validate({ dataset: turtleToDataset(ttl) })
    return report.results.map((r) =>
        `${PATHS.federation}: ${shrink(r.focusNode.value, { "": CDP })} ${r.message.map((m) => m.value).join("; ")}`)
}
