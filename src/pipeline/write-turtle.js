import { newStore } from "@foerderfunke/sem-ops-utils"
import { prefixes } from "../utils.js"
import { DataFactory, Writer } from "n3"
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

// Dedupe via a Store and sort by subject so the Writer can emit grouped
// "subject p1 o1; p2 o2." blocks instead of repeating subjects. Strips
// graph names (writes triples, not quads).
//
// Takes either quads or a tripleStore already holding them. A step that
// produces its output in pieces should hand over the store it filled, rather
// than an array this would copy into a second one: the dedupe store has to hold
// everything regardless, so an array beside it is a whole redundant copy of the
// output at peak.
export const writeTurtleFile = (filePath, quads, prefixes = {}) => new Promise((resolve, reject) => {
    let store
    if (typeof quads?.quads === "function") store = quads
    else {
        store = tripleStore()
        for (const q of quads) store.add(q)
    }
    const dedup = store.quads()
        .sort((a, b) => a.subject.value.localeCompare(b.subject.value))
    const writer = new Writer({ prefixes })
    for (const q of dedup) writer.addQuad(q)
    writer.end((err, result) => {
        if (err) return reject(err)
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        fs.writeFileSync(filePath, result)
        resolve()
    })
})
