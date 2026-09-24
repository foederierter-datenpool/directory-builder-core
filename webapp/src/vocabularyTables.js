import { sparqlSelect } from "@foerderfunke/sem-ops-utils/sparql"
import { NAMESPACES as NS, parseTtl, prefixesOf, shrink } from "@directory-builder/core/utils"
import { Store } from "n3"

const SH = "http://www.w3.org/ns/shacl#"
const DATATYPES = {
    string: "Text", boolean: "Yes/no", integer: "Whole number", int: "Whole number",
    decimal: "Number", double: "Number", float: "Number", date: "Date",
    dateTime: "Date and time", time: "Time", anyURI: "URL", language: "Language code",
}
const NODE_KINDS = { IRI: "Link", Literal: "Value (type not specified)", BlankNode: "Embedded record",
    BlankNodeOrIRI: "Record or link", BlankNodeOrLiteral: "Record or value", IRIOrLiteral: "Link or value" }
const join = (groups, separator) => groups.flatMap((group, i) => i ? [separator, ...group] : group)

export function vocabularyTablesCsv(schemas) {
    const rows = schemas.flatMap((schema, index) => [
        ...(index ? [["", ""]] : []),
        [schema.label, ""],
        ["Field", "Expected value"],
        ...schema.fields.map((field) => [
            field.predicateName, field.values.map((part) => typeof part === "string" ? part : part.label).join(""),
        ]),
    ])
    return rows.map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(",")).join("\r\n") + "\r\n"
}

// The same Turtle powers the tables and the source view; no federation config
// or directory data is used to reconstruct schema membership or value types.
export async function vocabularyTables(turtle) {
    const quads = parseTtl(turtle), store = new Store(quads), prefixes = prefixesOf(turtle)
    const objects = (subject, predicate) => store.getObjects(subject, predicate, null)
    const short = (iri) => shrink(iri, prefixes)
    const label = (subject, fallback) => {
        const labels = [SH + "name", NS.rdfs + "label"].map((p) => objects(subject, p)).find((values) => values.length) ?? []
        return (labels.find((term) => term.language === "en") ?? labels.find((term) => !term.language) ?? labels[0])?.value ?? fallback
    }
    const rows = await sparqlSelect(`
        PREFIX sh: <${SH}>
        SELECT DISTINCT ?schema ?class ?field ?predicate WHERE {
            ?schema a sh:NodeShape ; sh:targetClass ?class .
            OPTIONAL { ?schema sh:property ?field . ?field sh:path ?predicate . }
        }`, [store])
    const schemas = new Map()
    for (const row of rows) {
        if (!schemas.has(row.schema)) schemas.set(row.schema, {
            iri: row.schema, classIri: row.class, className: short(row.class),
            label: label(row.schema, label(row.class, short(row.class))), fields: [],
        })
        if (row.field) schemas.get(row.schema).fields.push({
            iri: row.field, predicate: row.predicate, predicateName: short(row.predicate),
        })
    }
    const lists = store.extractLists()
    const values = (shape, seen = new Set()) => {
        const key = shape.value ?? shape
        if (seen.has(key)) return ["See Turtle"]
        const next = new Set([...seen, key])
        const groups = objects(shape, SH + "datatype").map(({ value }) =>
            [value.startsWith(NS.xsd) ? DATATYPES[value.slice(NS.xsd.length)] ?? short(value) : short(value)])
        for (const cls of objects(shape, SH + "class")) {
            const target = [...schemas.values()].find((schema) => schema.classIri === cls.value)
            groups.push([{ label: target?.label ?? label(cls, short(cls.value)), schema: target?.iri }])
        }
        for (const node of objects(shape, SH + "node")) groups.push(values(node, next))
        for (const operator of ["or", "and"]) {
            for (const list of objects(shape, SH + operator)) {
                const branches = lists[list.value]?.map((node) => values(node, next))
                groups.push(branches?.length ? ["(", ...join(branches, ` ${operator} `), ")"] : ["See Turtle"])
            }
        }
        const kind = objects(shape, SH + "nodeKind")[0]?.value
        if (!groups.length) return [kind ? NODE_KINDS[kind.slice(SH.length)] ?? short(kind) : "Not specified"]
        const parts = join(groups, " and ")
        return kind === SH + "IRI" ? [parts.some((part) => typeof part === "object") ? "Link to " : "Link; ", ...parts] : parts
    }
    // Follow the schema order of the displayed document.
    const order = new Map(quads.filter((q) => q.predicate.value === SH + "targetClass").map((q, i) => [q.subject.value, i]))
    return [...schemas.values()].sort((a, b) => order.get(a.iri) - order.get(b.iri)).map((schema) => ({
        ...schema, fields: schema.fields.sort((a, b) => a.predicate.localeCompare(b.predicate)).map((field) => ({
            ...field, values: values(field.iri),
        })),
    }))
}
