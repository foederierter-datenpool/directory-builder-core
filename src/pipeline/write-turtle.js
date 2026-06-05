import { newStore } from "@foerderfunke/sem-ops-utils"
import { DataFactory, Writer } from "n3"
import path from "path"
import fs from "fs"

const df = DataFactory

export const COMMON_PREFIXES = {
    schema: "http://schema.org/",
    foaf:   "http://xmlns.com/foaf/0.1/",
    dct:    "http://purl.org/dc/terms/",
}

// Dedupe via a Store and sort by subject so the Writer can emit grouped
// "subject p1 o1; p2 o2." blocks instead of repeating subjects. Strips
// graph names (writes triples, not quads).
export const writeTurtleFile = (filePath, quads, prefixes = {}) => new Promise((resolve, reject) => {
    const store = newStore()
    for (const q of quads) store.addQuad(df.quad(q.subject, q.predicate, q.object))
    const dedup = store.getQuads(null, null, null, null)
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
