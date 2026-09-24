import { DataFactory, Parser, Store, Writer } from "n3"
import { CDP, NAMESPACES as NS, prefixesOf } from "./utils.js"

const { namedNode, quad } = DataFactory
const SH = "http://www.w3.org/ns/shacl#"
const TYPE = `${NS.rdf}type`
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const termKey = (term) => `${term.termType}:${term.value}:${term.language ?? ""}:${term.datatype?.value ?? ""}`
const quadKey = (q) => [q.subject, q.predicate, q.object].map(termKey).join("\n")

// No IO or observed-data inference: identical config produces identical Turtle
// in Node and in the browser, including nested SHACL lists and blank nodes.
export async function buildTargetVocabulary(federationTtl) {
    let blank = 0
    const factory = { ...DataFactory, blankNode: (label) => DataFactory.blankNode(label ?? `generated${blank++}`) }
    const configQuads = new Parser({ factory, blankNodePrefix: "config_" }).parse(federationTtl)
    const config = new Store(configQuads)
    const vocabulary = new Store()
    const objects = (s, p) => config.getObjects(s, p, null)
    const one = (s, p) => objects(s, p)[0]
    const typed = (type) => config.getSubjects(TYPE, type, null).sort((a, b) => compare(a.value, b.value))
    const add = (s, p, o) => vocabulary.addQuad(quad(s, namedNode(p), o))
    const metadata = new Set([`${NS.rdfs}label`, `${NS.rdfs}comment`, `${NS.rdfs}seeAlso`, `${CDP}typeDerivation`])
    const copied = new Set()

    const federation = typed(`${CDP}Federation`)[0]

    // Follow shape references and RDF lists, not unrelated source/mapping config.
    const copyDependency = (term) => {
        if (term.termType === "Literal" || copied.has(termKey(term))) return
        const rows = config.getQuads(term, null, null, null)
        if (term.termType !== "BlankNode" && !rows.some((q) => q.predicate.value.startsWith(SH)
            || (q.predicate.value === TYPE && q.object.value.startsWith(SH)))) return
        copied.add(termKey(term))
        for (const q of rows) {
            if (term.termType !== "BlankNode" && !q.predicate.value.startsWith(SH)
                && !metadata.has(q.predicate.value) && q.predicate.value !== TYPE) continue
            // Config roles are replaced by the generated shape roles below.
            if (q.predicate.value === TYPE && [`${CDP}TargetField`, `${CDP}TargetSchema`].includes(q.object.value)) continue
            vocabulary.addQuad(q)
            copyDependency(q.object)
        }
    }
    const annotations = (subject) => {
        for (const q of config.getQuads(subject, null, null, null)) {
            if (!q.predicate.value.startsWith(SH) && !metadata.has(q.predicate.value)) continue
            vocabulary.addQuad(q)
            copyDependency(q.object)
        }
    }
    const termDescription = (term, kind) => {
        add(term, TYPE, namedNode(kind))
        // Only explicitly authored RDFS statements describe the global term.
        // Local labels, comments and constraints stay on their shapes.
        for (const q of config.getQuads(term, null, null, null)) {
            if (q.predicate.value.startsWith(NS.rdfs)) vocabulary.addQuad(q)
        }
    }

    const mappings = typed(`${CDP}Mapping`)
    for (const schema of typed(`${CDP}TargetSchema`)) {
        const targetClass = one(schema, `${CDP}targetClass`)
        if (!targetClass) continue
        termDescription(targetClass, `${NS.rdfs}Class`)
        add(schema, TYPE, namedNode(`${SH}NodeShape`))
        add(schema, `${SH}targetClass`, targetClass)
        annotations(schema)

        // Older instances may declare fields only through their mappings.
        const fields = new Set(objects(schema, `${CDP}hasTargetField`).map((term) => term.value))
        for (const mapping of mappings.filter((m) => one(m, `${CDP}toTarget`)?.equals(schema))) {
            for (const fieldMapping of objects(mapping, `${CDP}hasFieldMapping`)) {
                for (const field of objects(fieldMapping, `${CDP}to`)) fields.add(field.value)
            }
            for (const relationship of objects(mapping, `${CDP}hasRelationship`)) {
                for (const field of objects(relationship, `${CDP}toTargetField`)) fields.add(field.value)
            }
        }
        for (const field of [...fields].sort()) {
            if (one(field, `${CDP}targetPredicate`)) add(schema, `${SH}property`, namedNode(field))
        }
    }
    for (const field of typed(`${CDP}TargetField`)) {
        const predicate = one(field, `${CDP}targetPredicate`)
        if (!predicate) continue
        termDescription(predicate, `${NS.rdf}Property`)
        add(field, TYPE, namedNode(`${SH}PropertyShape`))
        add(field, `${SH}path`, predicate)
        annotations(field)
    }
    for (const cls of vocabulary.getObjects(null, `${SH}class`, null))
        termDescription(cls, `${NS.rdfs}Class`)

    // Geocoding adds these predicates outside the target field lists. Include
    // them in the inventory, without guessing datatype constraints from data.
    for (const rule of typed(`${CDP}EnrichRule`)) {
        if (objects(rule, `${CDP}geocode`).length) {
            for (const name of ["latitude", "longitude"])
                termDescription(namedNode(`${NS.schema}${name}`), `${NS.rdf}Property`)
        }
    }

    // Shapes already identify their predicates. Keep standalone declarations
    // for documented terms and predicates introduced only by enrichment.
    for (const q of vocabulary.getQuads(null, TYPE, `${NS.rdf}Property`, null)) {
        if (vocabulary.countQuads(q.subject, null, null, null) === 1
            && vocabulary.countQuads(null, `${SH}path`, q.subject, null)) vocabulary.removeQuad(q)
    }

    const prefixes = { ...prefixesOf(federationTtl), rdf: NS.rdf, rdfs: NS.rdfs, dct: NS.dct, sh: SH, xsd: NS.xsd }
    const serialize = async (store, description) => {
        const quads = [...store].sort((a, b) => compare(quadKey(a), quadKey(b)))
        const iris = quads.flatMap((q) => [q.subject, q.predicate, q.object, q.object.datatype])
            .filter((term) => term?.termType === "NamedNode").map((term) => term.value)
        const used = Object.fromEntries(Object.entries(prefixes).sort(([a], [b]) => compare(a, b))
            .filter(([, ns]) => iris.some((iri) => iri.startsWith(ns))))
        const lists = store.extractLists({ remove: true })
        const references = new Map()
        for (const term of [...store].map((q) => q.object).concat(Object.values(lists).flat()))
            references.set(termKey(term), (references.get(termKey(term)) ?? 0) + 1)
        const inline = (term) => term.termType === "BlankNode" && references.get(termKey(term)) === 1

        // Group complete subject descriptions, keeping shared fields in one place.
        // Inline blank nodes and lists still use the complete graph across sections.
        const remaining = new Map(), sections = []
        for (const q of quads.filter((q) => store.has(q) && !inline(q.subject))) {
            const key = termKey(q.subject)
            if (!remaining.has(key)) remaining.set(key, [])
            remaining.get(key).push(q)
        }
        const section = (title, subjects) => {
            const rows = subjects.flatMap((subject) => {
                const key = termKey(subject), rows = remaining.get(key) ?? []
                remaining.delete(key)
                return rows
            })
            if (rows.length) sections.push({ title: title.replace(/\s+/g, " "), rows })
        }
        const compact = (term) => {
            const prefix = Object.entries(used).find(([, ns]) => term.value.startsWith(ns))
            return prefix ? `${prefix[0]}:${term.value.slice(prefix[1].length)}` : `<${term.value}>`
        }
        const fieldSubjects = (fields) => fields.flatMap((field) => [...store.getObjects(field, `${SH}path`, null), field])
        const declared = configQuads.filter((q) => q.subject.equals(federation) && q.predicate.value === `${CDP}hasTargetSchema`)
            .map((q) => q.object)
        const schemas = [...new Map([...declared, ...typed(`${CDP}TargetSchema`)]
            .map((schema) => [termKey(schema), schema])).values()]
        for (const schema of schemas) {
            const cls = one(schema, `${CDP}targetClass`)
            if (!cls) continue
            const label = one(schema, `${NS.rdfs}label`)?.value
            const fields = store.getObjects(schema, `${SH}property`, null)
                .filter((field) => store.countQuads(null, `${SH}property`, field, null) === 1)
                .sort((a, b) => compare(termKey(a), termKey(b)))
            section(label ? `${label} (${compact(cls)})` : compact(cls), [cls, schema, ...fieldSubjects(fields)])
        }
        const shared = store.getSubjects(TYPE, `${SH}PropertyShape`, null)
            .filter((field) => store.countQuads(null, `${SH}property`, field, null) > 1)
            .sort((a, b) => compare(termKey(a), termKey(b)))
        section("Shared fields", fieldSubjects(shared))
        section("Enrichment properties", store.getSubjects(TYPE, `${NS.rdf}Property`, null)
            .filter((term) => !store.countQuads(null, `${SH}path`, term, null)))
        section("Supporting definitions", [...remaining.values()].map((rows) => rows[0].subject))

        const documents = await Promise.all(sections.map(({ rows }) => new Promise((resolve, reject) => {
            const writer = new Writer({ prefixes: used, lists })
            const render = (term, ancestors = new Set()) => {
                if (ancestors.has(termKey(term))) return term
                const next = new Set([...ancestors, termKey(term)])
                if (lists[term.value]) return writer.list(lists[term.value].map((item) => render(item, next)))
                if (inline(term)) return writer.blank(store.getQuads(term, null, null, null)
                    .sort((a, b) => compare(quadKey(a), quadKey(b)))
                    .map((q) => ({ predicate: q.predicate, object: render(q.object, next) })))
                return term
            }
            for (const q of rows) writer.addQuad(quad(q.subject, q.predicate, render(q.object)))
            writer.end((error, text) => error ? reject(error) : resolve(text))
        })))
        // Each writer shares the same prefixes; emit their preamble only once.
        const preamble = /^(?:@prefix[^\n]*\n)+\n/
        return `# ${description}\n# Generated from config/federation.ttl.\n\n`
            + (documents[0]?.match(preamble)?.[0] ?? "")
            + documents.map((text, i) => `# ---- ${sections[i].title} `.padEnd(78, "-")
                + `\n\n${text.replace(preamble, "").replace(/\.\n(?=\S)/g, ".\n\n")}`).join("\n")
    }
    return serialize(vocabulary, "Target application profile: RDFS vocabulary and SHACL shapes. Only explicitly configured constraints are enforced.")
}
