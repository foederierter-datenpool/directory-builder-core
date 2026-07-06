import { CDP, parseTtl, PATHS, sourceName } from "../../utils.js"
import { writeTurtleFile } from "../write-turtle.js"
import { DataFactory } from "n3"
import fs from "fs"

const df = DataFactory
const XYZ = "http://sparql.xyz/facade-x/data/"
const P = (x) => df.namedNode(`${CDP}${x}`)

// All the xyz:<fieldPath> → literal values a lifted-input directory holds, one
// entry per node — the raw side of an in-place normalisation.
const liftedNodes = (dir) => {
    if (!fs.existsSync(dir)) return []
    const byNode = new Map()
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".ttl")))
        for (const q of parseTtl(fs.readFileSync(`${dir}/${f}`, "utf8")))
            if (q.object.termType === "Literal" && q.predicate.value.startsWith(XYZ)) {
                const m = byNode.get(q.subject.value) ?? byNode.set(q.subject.value, new Map()).get(q.subject.value)
                m.set(q.predicate.value.slice(XYZ.length), q.object.value)
            }
    return [...byNode.values()]
}

// Preparation artifact: the value-hygiene surface of the clean step, per source —
// the changes clean makes that are invisible in every other view. For each entity
// it records the otherwise-hidden cdp:matchString (the match step's comparison
// key) and two kinds of before→after value change:
//   • parsed: a :derivedFrom field's raw origin value → its cleaned value. Both
//     live in the cleaned output — clean copies the origin field verbatim onto
//     the parent entity and links it — so this is a pure projection.
//   • normalised in place: a field clean rewrote under the same xyz:<fieldPath>
//     (whitespace collapsed, phone reduced to digits, …). Its raw value survives
//     only in the lifted input, so each entity is paired to its progenitor lifted
//     node(s) — the ones sharing the most identical field values — and same-named
//     fields are diffed. The two kinds never overlap: parsed changes a value's
//     fieldPath, in-place keeps it.
// Reads cleaned/<name>.ttl (+ lifted/<name>/ for the in-place raw side);
// writes preparation/<name>.ttl.
export async function runPreparation({ abs, quads }, sources) {
    const litOf = (s, p) => quads.find((q) => q.subject.value === s && q.predicate.value === `${CDP}${p}`)?.object.value
    // Derived source fields: IRI + its own :fieldPath + its origin's :fieldPath.
    const derived = quads
        .filter((q) => q.predicate.value === `${CDP}derivedFrom`)
        .map((q) => ({ iri: q.subject.value, derivedPath: litOf(q.subject.value, "fieldPath"), originPath: litOf(q.object.value, "fieldPath") }))
        .filter((d) => d.derivedPath && d.originPath)

    for (const src of sources) {
        const name = sourceName(src)
        const cq = parseTtl(fs.readFileSync(abs(PATHS.cleaned(name)), "utf8"))
        const entities = new Set(cq.filter((q) => q.predicate.value === `${CDP}targetSchema`).map((q) => q.subject.value))
        const fieldsOf = new Map()   // entity → Map(fieldPath → value)
        const matchStrOf = new Map()
        for (const q of cq) {
            if (q.predicate.value.startsWith(XYZ)) {
                const m = fieldsOf.get(q.subject.value) ?? fieldsOf.set(q.subject.value, new Map()).get(q.subject.value)
                m.set(q.predicate.value.slice(XYZ.length), q.object.value)
            } else if (q.predicate.value === `${CDP}matchString`) matchStrOf.set(q.subject.value, q.object.value)
        }
        // Entity→entity relationship links (origin entity → derived entity).
        const links = cq
            .filter((q) => q.predicate.value.startsWith(CDP) && entities.has(q.object.value))
            .map((q) => [q.subject.value, q.object.value])

        // Per entity: its matchString and its deduped, actually-changed diffs.
        // A diff's field is either a :SourceField IRI (parsed) or a bare
        // fieldPath string (in-place); `iri` says which, for the emit below.
        const prep = new Map()
        const bucket = (e) => prep.get(e) ?? prep.set(e, { diffs: new Map() }).get(e)
        for (const d of derived) for (const [origin, target] of links) {
            const raw = fieldsOf.get(origin)?.get(d.originPath)
            const clean = fieldsOf.get(target)?.get(d.derivedPath)
            if (raw === undefined || clean === undefined || raw === clean) continue
            bucket(target).diffs.set(`${d.iri}|${raw}|${clean}`, { field: d.iri, iri: true, raw, clean })
        }
        // In-place normalisations: for each entity, its progenitor lifted node(s)
        // are those sharing the most identical field values; a field whose raw
        // value they agree on but differs from the cleaned value is a diff.
        const lifted = liftedNodes(abs(PATHS.lifted(name)))
        for (const entity of entities) {
            const ef = fieldsOf.get(entity)
            if (!ef) continue
            let best = 0, progs = []
            for (const lf of lifted) {
                let ov = 0
                for (const [p, v] of ef) if (lf.get(p) === v) ov++
                if (ov > best) { best = ov; progs = [lf] } else if (ov === best && ov > 0) progs.push(lf)
            }
            if (!best) continue
            for (const [p, clean] of ef) {
                const raws = new Set(progs.map((lf) => lf.get(p)).filter((v) => v !== undefined))
                if (raws.size !== 1) continue
                const raw = [...raws][0]
                if (raw === clean) continue
                bucket(entity).diffs.set(`${p}|${raw}|${clean}`, { field: p, iri: false, raw, clean })
            }
        }
        for (const [entity, ms] of matchStrOf) bucket(entity).matchString = ms

        const out = []
        for (const [entity, v] of prep) {
            const s = df.namedNode(entity)
            if (v.matchString !== undefined) out.push(df.quad(s, P("matchString"), df.literal(v.matchString)))
            for (const { field, iri, raw, clean } of v.diffs.values()) {
                const b = df.blankNode()
                out.push(df.quad(s, P("prepared"), b))
                out.push(df.quad(b, P("field"), iri ? df.namedNode(field) : df.literal(field)))
                out.push(df.quad(b, P("rawValue"), df.literal(raw)))
                out.push(df.quad(b, P("cleanValue"), df.literal(clean)))
            }
        }
        await writeTurtleFile(abs(PATHS.preparation(name)), out, { cdp: CDP })
        console.log(`prepare ${name}: ${prep.size} entities → ${PATHS.preparation(name)}`)
    }
}
