import { sparqlInsertDelete, sparqlSelect } from "@foerderfunke/sem-ops-utils"
import { buildPrefixBlock, CDP, PATHS, shrink, sourceGraph, sourceName } from "../../utils.js"
import { DataFactory } from "n3"
import path from "path"
import fs from "fs"

const df = DataFactory

export const MAPPED_GRAPH = df.namedNode("urn:mapped")

// ---- Direct-mapping generator ------------------------------------------

const XYZ = "http://sparql.xyz/facade-x/data/"

const buildDirectInsert = ({ sourceGraph, source, targetClass, target }, fields) => {
    const prefixes = {
        xyz:    XYZ,
        cdp:    CDP,
        cdf:    "https://civic-data.de/federated-directory#",
        schema: "http://schema.org/",
        foaf:   "http://xmlns.com/foaf/0.1/",
        dct:    "http://purl.org/dc/terms/",
    }
    // shrink() returns the IRI verbatim if no prefix matches; wrap that as <…>.
    const short = (iri) => {
        const s = shrink(iri, prefixes)
        return s === iri ? `<${iri}>` : s
    }

    const v      = (path) => `?${path}`
    // STR() before the emptiness check so the guard works for any literal
    // datatype — a bare `?v != ""` errors on e.g. xsd:int and would silently
    // drop the field (AWO's numeric ids hit exactly this). Whitespace-only
    // values count as empty too — caritas emits " " categories, and resolve's
    // alphabeticFirst would pick them over real values.
    const optLit = (subj, path) =>
        `OPTIONAL { ${subj} xyz:${path} ${v(path)} . ` +
        `FILTER(isLiteral(${v(path)}) && REPLACE(STR(${v(path)}), "\\\\s+", "") != "") }`

    const insertBlock = fields
        .map(f => `        ?entity ${short(f.predicate)} ${v(f.fieldPath)} .`)
        .join("\n")

    const topLevel  = fields.filter(f => !f.parentPath)
    const subFields = fields.filter(f => f.parentPath)

    // Source subjects = federation IRIs after the clean step, identified via
    // cdp:fromSource — no minting from a key field. Where clean reshapes one
    // source into several entity kinds it tags each subject with cdp:targetSchema;
    // select only those for this mapping's schema. Subjects with no marker
    // (single-entity sources like caritas/dhs) match unconditionally.
    const bgp = [`?entity cdp:fromSource ${short(source)} .`]
    if (target) {
        bgp.push(`OPTIONAL { ?entity cdp:targetSchema ?_ts }`)
        bgp.push(`FILTER(!bound(?_ts) || ?_ts = ${short(target)})`)
    }
    for (const f of topLevel) bgp.push(optLit("?entity", f.fieldPath))

    const byParent = new Map()
    for (const f of subFields) {
        if (!byParent.has(f.parentPath)) byParent.set(f.parentPath, [])
        byParent.get(f.parentPath).push(f)
    }
    let parentIdx = 0
    for (const [parent, subs] of byParent) {
        const pv    = `?_p${parentIdx++}`
        const inner = subs.map(s => `    ${optLit(pv, s.fieldPath)}`).join("\n")
        bgp.push(`OPTIONAL {\n    ?entity xyz:${parent} ${pv} .\n${inner}\n  }`)
    }

    // The target schema's :targetClass becomes the record's rdf:type here in the
    // mapped graph — this is where schema: vocabulary first enters; the clean step
    // stays in xyz:/cdp: only.
    const typeClause = targetClass ? `a ${short(targetClass)} ; ` : ""

    return `${buildPrefixBlock(prefixes)}

INSERT {
    GRAPH <urn:mapped> {
        ?entity ${typeClause}cdp:fromSource ${short(source)} .
${insertBlock}
    }
} WHERE {
    GRAPH <${sourceGraph}> {
        ${bgp.join("\n        ")}
    }
}`
}

export const runMap = async ({ store, defStore, abs }, queriesDir) => {
    const mappings = await sparqlSelect(`
        PREFIX : <${CDP}>
        SELECT ?mapping ?source ?target ?targetClass WHERE {
            ?mapping a :Mapping ;
                :fromSource ?source .
            OPTIONAL { ?mapping :toTarget ?target }
            OPTIONAL { ?mapping :toTarget/:targetClass ?targetClass }
        } ORDER BY ?mapping`, [defStore])

    for (const m of mappings) {
        const directRows = await sparqlSelect(`
            PREFIX : <${CDP}>
            SELECT ?fieldPath ?predicate ?parentPath WHERE {
                <${m.mapping}> :hasFieldMapping ?fm .
                ?fm :from ?src ; :to ?tgt .
                FILTER NOT EXISTS { ?fm :via ?_v }
                ?tgt :targetPredicate ?predicate .
                ?src :fieldPath ?fieldPath .
                OPTIONAL { ?parent :hasSubField ?src . ?parent :fieldPath ?parentPath }
            }`, [defStore])

        if (directRows.length) {
            const localName = m.mapping.split("#").pop()
            // The mapping's source graph follows by convention from :fromSource —
            // the load step names it the same way.
            const query = buildDirectInsert({ ...m, sourceGraph: sourceGraph(sourceName(m.source)) }, directRows)
            const queryPath = abs(path.join(queriesDir, `${localName}.sparql`))
            fs.mkdirSync(path.dirname(queryPath), { recursive: true })
            fs.writeFileSync(queryPath, query)
            console.log(`map  ${localName} direct (${directRows.length} mappings) → ${queryPath}`)
            await sparqlInsertDelete(query, store)
        }

        // :via names a transform of the mapping's source — the script path
        // follows by convention (sources/<source>/transform-<via>.sparql).
        const viaRows = await sparqlSelect(`
            PREFIX : <${CDP}>
            SELECT DISTINCT ?via WHERE {
                <${m.mapping}> :hasFieldMapping/:via ?via .
            } ORDER BY ?via`, [defStore])

        for (const v of viaRows) {
            const script = PATHS.transform(sourceName(m.source), v.via)
            console.log(`map  ${script}`)
            await sparqlInsertDelete(fs.readFileSync(abs(script), "utf8"), store)
        }
    }

    // A mapping's :hasRelationship turns the clean step's source-level link
    // (e.g. :providedBy) into a target predicate (schema:provider), matching the
    // two ends by their cdp:targetSchema. Both ends are still source IRIs here;
    // the merge step rewrites them to the minted cluster IRIs.
    const linkRows = await sparqlSelect(`
        PREFIX : <${CDP}>
        SELECT ?mapping ?source ?fromSchema ?sourcePredicate ?targetPredicate ?toSchema WHERE {
            ?mapping a :Mapping ;
                :fromSource      ?source ;
                :toTarget        ?fromSchema ;
                :hasRelationship ?rel .
            ?rel :sourcePredicate ?sourcePredicate ;
                 :toTargetField   ?field ;
                 :toTargetSchema  ?toSchema .
            ?field :targetPredicate ?targetPredicate .
        } ORDER BY ?mapping`, [defStore])

    for (const rel of linkRows) {
        const prefixes = { cdp: CDP, schema: "http://schema.org/" }
        const short = (iri) => { const s = shrink(iri, prefixes); return s === iri ? `<${iri}>` : s }
        const query = `${buildPrefixBlock(prefixes)}

INSERT {
    GRAPH <urn:mapped> {
        ?from ${short(rel.targetPredicate)} ?to .
    }
} WHERE {
    GRAPH <${sourceGraph(sourceName(rel.source))}> {
        ?from ${short(rel.sourcePredicate)} ?to ;
              cdp:targetSchema ${short(rel.fromSchema)} .
        ?to cdp:targetSchema ${short(rel.toSchema)} .
    }
}`
        console.log(`map  ${rel.mapping.split("#").pop()} link (${short(rel.targetPredicate)})`)
        await sparqlInsertDelete(query, store)
    }
}
