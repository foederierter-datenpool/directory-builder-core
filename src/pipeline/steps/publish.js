import { CDP, enabledSources, localName, objectsOf, parseTtl, PATHS, sourceName, subjectsOfType } from "../../utils.js"
import { COMMON_PREFIXES, writeTurtleFile } from "../write-turtle.js"
import { DataFactory } from "n3"
import fs from "fs"

const df = DataFactory
const DCAT = "http://www.w3.org/ns/dcat#"
const DCT = "http://purl.org/dc/terms/"
const DCATDE = "http://dcat-ap.de/def/dcatde/"
const RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label"
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
const DATETIME = df.namedNode("http://www.w3.org/2001/XMLSchema#dateTime")
const TURTLE_MEDIA_TYPE = df.namedNode("https://www.iana.org/assignments/media-types/text/turtle")
// Webapp routes (hash router). Download is where a human gets the other
// formats: they are built in the browser from final.ttl on click, so they have
// no URL and cannot be distributions — this page is how they are reachable.
// Pipeline is the run's own methodology view (per-source lanes, fetch → lift →
// extract → map → match → merge → resolve), which is what
// dcatde:qualityProcessURI asks for.
const DOWNLOAD_ROUTE = "#/download"
const PIPELINE_ROUTE = "#/pipeline"

// ---- Publish step ----------------------------------------------------------
// DCAT-AP.de catalog metadata for the directory: publication.ttl carried
// through, plus what only the run knows — dct:modified and the Turtle
// distribution. Its accessURL is final.ttl under the deployed webapp, which
// serves data/ verbatim; the :DistributionTemplate's remaining properties
// (license, attribution) are stamped onto it. Turtle is the only distribution
// there can be — the webapp's other formats (JSON-LD, the per-schema CSV/JSON
// zips, the instance's exporters) are built in the browser and never exist as
// files — so each dataset also carries a dcat:landingPage to that page.
//
// The origins are derived too, per dataset rather than per catalog: a
// :Mapping declares :fromSource and :toTarget, so the sources behind a dataset
// are exactly those mapping into its schema — for the example, all three behind
// the organisations, ReadCity alone behind the programmes. They become a
// dct:ProvenanceStatement (a merged directory whose upstreams are invisible is
// not open data); @en because the labels are the config's own, untranslated.
//
// The schema each dataset was built to — its :TargetSchema's :targetClass —
// goes out as dct:conformsTo. DCAT has no property for "class of thing
// described" (dct:type on a Dataset is bound to the EU dataset-type list, which
// has no slot for schema:Organization), and dct:conformsTo strictly wants a
// standard rather than a class; pointing it at the class is the loose but usual
// reading, and it is the one triple that tells a consumer what is inside.

export async function runPublish({ abs }, out) {
    const pub = parseTtl(fs.readFileSync(abs(PATHS.publication), "utf8"))
    const fed = parseTtl(fs.readFileSync(abs(PATHS.federation), "utf8"))
    const configCatalog = [...subjectsOfType(pub, `${DCAT}Catalog`)][0]
    const template = [...subjectsOfType(pub, `${CDP}DistributionTemplate`)][0]
    // :federation :baseUrl — the deployment URL, a federation-level fact like
    // :repository, and the ground every published IRI here is built on.
    const baseUrl = objectsOf(fed, `${CDP}baseUrl`)[0]
    if (!baseUrl) throw new Error(`publish: ${PATHS.publication} exists, so ${PATHS.federation} must declare :federation :baseUrl "<where the webapp is deployed>/"`)
    const dist = df.namedNode(`${baseUrl}${PATHS.final}`)

    // Instance-data terms only: predicates stay in the vocabulary namespace.
    const rebase = (term) => term.termType === "NamedNode" && term.value.startsWith(CDP)
        ? df.namedNode(`${baseUrl}#${term.value === configCatalog ? "catalog" : localName(term.value)}`)
        : term
    const catalog = rebase(df.namedNode(configCatalog))

    // Source labels behind one target schema, in :hasSource declaration order
    // (disabled sources contributed nothing, so enabledSources skips them).
    const one = (quads, s, p) => quads.find((q) => q.subject.value === s && q.predicate.value === p)?.object.value
    const mappings = [...subjectsOfType(fed, `${CDP}Mapping`)]
        .map((m) => ({ from: one(fed, m, `${CDP}fromSource`), to: one(fed, m, `${CDP}toTarget`) }))
    const originsOf = (schema) => {
        const contributing = new Set(mappings.filter((m) => m.to === schema).map((m) => m.from))
        return enabledSources(fed).filter((s) => contributing.has(s))
            .map((s) => one(fed, s, RDFS_LABEL) ?? sourceName(s))
    }

    const carried = pub.filter((q) => q.subject.value !== template && q.predicate.value !== `${CDP}publishedAs`)
    const quads = [
        ...carried.map((q) => df.quad(rebase(q.subject), q.predicate, rebase(q.object))),
        ...pub.filter((q) => q.subject.value === template && q.predicate.value !== RDF_TYPE)
            .map((q) => df.quad(dist, q.predicate, rebase(q.object))),
        df.quad(catalog, df.namedNode(`${DCT}modified`), df.literal(new Date().toISOString(), DATETIME)),
        df.quad(dist, df.namedNode(RDF_TYPE), df.namedNode(`${DCAT}Distribution`)),
        df.quad(dist, df.namedNode(`${DCAT}accessURL`), dist),
        df.quad(dist, df.namedNode(`${DCAT}mediaType`), TURTLE_MEDIA_TYPE),
        ...pub.filter((q) => q.predicate.value === `${CDP}publishedAs`).flatMap((q) => {
            const d = rebase(q.object)
            const origins = originsOf(q.subject.value)
            const targetClass = one(fed, q.subject.value, `${CDP}targetClass`)
            const statement = df.namedNode(`${d.value}-provenance`)
            return [
                df.quad(catalog, df.namedNode(`${DCAT}dataset`), d),
                df.quad(d, df.namedNode(`${DCAT}distribution`), dist),
                df.quad(d, df.namedNode(`${DCAT}landingPage`), df.namedNode(`${baseUrl}${DOWNLOAD_ROUTE}`)),
                df.quad(d, df.namedNode(`${DCATDE}qualityProcessURI`), df.namedNode(`${baseUrl}${PIPELINE_ROUTE}`)),
                ...(targetClass ? [df.quad(d, df.namedNode(`${DCT}conformsTo`), df.namedNode(targetClass))] : []),
                ...(origins.length ? [
                    df.quad(d, df.namedNode(`${DCT}provenance`), statement),
                    df.quad(statement, df.namedNode(RDF_TYPE), df.namedNode(`${DCT}ProvenanceStatement`)),
                    df.quad(statement, df.namedNode(RDFS_LABEL),
                        df.literal(`Merged from ${origins.join(", ")} by this directory's pipeline.`, "en")),
                ] : []),
            ]
        }),
    ]
    await writeTurtleFile(out, quads, { ...COMMON_PREFIXES, dcat: DCAT, dcatde: DCATDE, rdfs: RDFS_LABEL.replace(/label$/, "") })
    console.log(`publish: wrote ${quads.length} triples → ${PATHS.catalog}`)
}
