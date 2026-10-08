import { newStore } from "@foerderfunke/sem-ops-utils"
import { prefixes } from "../utils.js"
import { DataFactory, Writer } from "n3"
import { randomUUID } from "node:crypto"
import path from "path"
import fs from "fs"

const df = DataFactory

// The vocabularies the federated data itself speaks, on every artefact the
// pipeline writes. Steps add what only they use (cdp:, the instance's cdf:).
export const COMMON_PREFIXES = prefixes("schema", "foaf", "dct")

// The Writer emits every prefix it is handed, used or not. A step that carries
// an author's declarations through (publish, from publication.ttl) hands over
// more than its output can use — prefixesOf reads the file's text, so it also
// returns namespaces the author only mentions in a comment — so it narrows the
// map to the namespaces an IRI in the data actually starts with.
export const usedPrefixes = (prefixMap, quads) => {
    const iris = quads.flatMap((q) => [q.subject, q.predicate, q.object, q.object.datatype]
        .filter((t) => t?.termType === "NamedNode").map((t) => t.value))
    return Object.fromEntries(Object.entries(prefixMap).filter(([, ns]) => iris.some((iri) => iri.startsWith(ns))))
}

// A Store that holds quads as triples, dropping any graph name.
export const tripleStore = () => {
    const store = newStore()
    return {
        add: (q) => store.addQuad(df.quad(q.subject, q.predicate, q.object)),
        get size() { return store.size },
        quads: () => store.getQuads(null, null, null, null),
    }
}

// Accepts an iterable of quads or a tripleStore. By default, deduplicates triples,
// drops graph names and sorts by subject. With dedupe: false, streams input as-is.
// Replaces the destination only after the complete output is written.
export const writeTurtleFile = async (filePath, quads, prefixes = {}, { dedupe = true } = {}) => {
    if (dedupe) {
        let store
        if (typeof quads?.quads === "function") store = quads
        else {
            store = tripleStore()
            for (const q of quads) store.add(q)
        }
        quads = store.quads().sort((a, b) => a.subject.value.localeCompare(b.subject.value))
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const temporary = `${filePath}.tmp-${randomUUID()}`
    let fd
    try {
        fd = fs.openSync(temporary, "w")
        let buffer = ""
        const flush = () => { if (buffer) { fs.writeFileSync(fd, buffer); buffer = "" } }
        const writer = new Writer({
            write(chunk, _encoding, done) {
                buffer += chunk
                if (buffer.length >= 65536) flush()
                done?.()
            },
        }, { prefixes, end: false })
        const checkError = (error) => { if (error) throw error }
        for (const q of quads) writer.addQuad(q, checkError)
        writer.end()
        flush()
        fs.closeSync(fd)
        fd = undefined
        fs.renameSync(temporary, filePath)
    } catch (error) {
        if (fd !== undefined) fs.closeSync(fd)
        fs.rmSync(temporary, { force: true })
        throw error
    }
}
