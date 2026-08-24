import { CDP, localName, NAMESPACES, objectsOf, parseTtl, PATHS, PUBLICATION_PREFIXES, turtlePrefixBlock } from "./utils.js"
import path from "path"
import fs from "fs"

// ---- publication.ttl skeleton ----------------------------------------------
// A first draft of the publish step's config, derived from federation.ttl as far
// as a federation can be: the catalog node, its homepage from :baseUrl, and one
// dcat:Dataset per :TargetSchema hung off it with :publishedAs. The rest cannot
// be derived — a publisher, a contact, a licence and the prose are decisions —
// so they land as TODO placeholders.
//
// The draft is deliberately valid on arrival: `directory-builder validate` and
// the DCAT-AP.de shapes pass on it unedited, so an author sees a working publish
// step first and fills in the substance after, rather than debugging shape
// violations while still deciding what to say. Two consequences of that choice:
//
//   - The licence placeholder is other-closed, the DCAT-AP.de code list's
//     "andere geschlossene Lizenz". Grants nothing, so an unedited draft cannot
//     accidentally publish data under an open licence nobody chose.
//   - Placeholders read "TODO: …" in the data itself, not just in comments —
//     a catalog whose title is "TODO: …" is unmistakable in a portal, whereas an
//     empty string or a plausible fake could ship unnoticed.
//
// One-shot, like init: config/ holds hand-edited files, and this becomes one the
// moment it is written. It refuses to overwrite, and nothing regenerates it.

const RDFS_LABEL = `${NAMESPACES.rdfs}label`

// The label of a config node as a Turtle literal, language tag preserved
// (federation.ttl labels are tagged: rdfs:label "Organisation"@en), or the
// fallback as a TODO placeholder.
const labelLiteral = (quads, subject, fallback) => {
    const label = quads.find((q) => q.subject.value === subject && q.predicate.value === RDFS_LABEL)?.object
    if (!label) return `"TODO: ${fallback}"`
    return `"${label.value}"${label.language ? `@${label.language}` : ""}`
}

// :organisationSchema → :organisationDataset, the pairing the example uses.
const datasetIri = (schemaIri) => `:${localName(schemaIri).replace(/Schema$/, "")}Dataset`

export function scaffoldPublication(root = process.cwd()) {
    const fedPath = path.join(root, PATHS.federation)
    if (!fs.existsSync(fedPath)) throw new Error(`no ${PATHS.federation} at ${root} — nothing to derive a draft from`)
    const target = path.join(root, PATHS.publication)
    if (fs.existsSync(target)) throw new Error(`${PATHS.publication} already exists at ${root} — refusing to overwrite`)

    const fed = parseTtl(fs.readFileSync(fedPath, "utf8"))
    // :hasTargetSchema declaration order when the federation states it (the same
    // order the webapp lanes and exports follow); otherwise the schemas the
    // mappings actually target, which is what the engines run on either way.
    const schemas = objectsOf(fed, `${CDP}hasTargetSchema`).length
        ? objectsOf(fed, `${CDP}hasTargetSchema`)
        : objectsOf(fed, `${CDP}toTarget`)
    if (!schemas.length) throw new Error(`${PATHS.federation} declares no target schema — nothing to publish`)
    const baseUrl = objectsOf(fed, `${CDP}baseUrl`)[0]

    const datasets = schemas.map((schema) => `
${datasetIri(schema)} a dcat:Dataset ;
    dct:title       ${labelLiteral(fed, schema, `title of the ${localName(schema)} dataset`)} ;
    dct:description "TODO: what is in this dataset, and what a consumer can do with it" ;
    dct:publisher   :publisher ;
    dcat:contactPoint :contact ;
    # From the EU data theme authority: http://publications.europa.eu/resource/authority/data-theme
    dcat:theme      theme:GOVE ;
    dcat:keyword    "TODO: keyword" ;
    # How often the pipeline runs, from the EU frequency authority.
    dct:accrualPeriodicity freq:UNKNOWN ;
    # The smallest administrative level the entities are located at, if any:
    # http://dcat-ap.de/def/politicalGeocoding/Level/
    # dcatde:politicalGeocodingLevelURI pgl:municipality ;
    dcatap:availability <http://publications.europa.eu/resource/authority/planned-availability/EXPERIMENTAL> .`)

    const ttl = `${turtlePrefixBlock({ "": CDP, ...PUBLICATION_PREFIXES })}

# DCAT-AP.de 3.0 metadata for publishing this directory. Generated from
# federation.ttl as a first draft — hand-edited from here on, nothing
# regenerates it. It is valid as it stands (\`directory-builder validate\`
# passes), so the publish step works immediately; every "TODO:" is a decision
# only you can make, and each one you leave is visible in the published catalog.
#
# The deployment URL is not here: :federation :baseUrl in federation.ttl states
# it once, for both the webapp build and the IRIs published below.

:federation a dcat:Catalog ;
    dct:title       ${labelLiteral(fed, `${CDP}federation`, "title of this directory")} ;
    dct:description "TODO: what this directory federates, for whom" ;
    dct:publisher   :publisher ;
    dct:language    <http://publications.europa.eu/resource/authority/language/DEU> ;${baseUrl ? `
    foaf:homepage   <${baseUrl}> ;` : ""}
    dcat:themeTaxonomy <http://publications.europa.eu/resource/authority/data-theme> .

:publisher a foaf:Agent ;
    foaf:name "TODO: the organisation publishing this directory" .
    # For delivery to GovData, add the contributor ID they assign:
    # dcatde:contributorID <http://dcat-ap.de/def/contributors/yourorganisation> .

:contact a vcard:Kind ;
    vcard:fn "TODO: who to contact about this data" ;
    vcard:hasEmail <mailto:TODO@example.org> .

# One dcat:Dataset per :TargetSchema, hung off the schema IRI federation.ttl
# declares. The publish step derives each one's distribution, landing page,
# dct:conformsTo and the sources it was merged from.
${schemas.map((s) => `:${localName(s)} :publishedAs ${datasetIri(s)} .`).join("\n")}
${datasets.join("\n")}

# Stamped onto the distribution the publish step derives (its accessURL is
# directory.ttl under :federation :baseUrl, which the webapp serves verbatim).
:distributionDefaults a :DistributionTemplate ;
    # "Andere geschlossene Lizenz" — a placeholder that grants nothing. Replace
    # it with the licence you publish under: http://dcat-ap.de/def/licenses/
    dct:license <http://dcat-ap.de/def/licenses/other-closed> ;
    # Required for attribution licences (dl-by-de, cc-by): who to credit, and
    # for what. Name the upstream sources as well as this directory.
    dcatde:licenseAttributionByText "TODO: attribution for the sources and this directory" ;
    dcatap:availability <http://publications.europa.eu/resource/authority/planned-availability/EXPERIMENTAL> .
`

    fs.writeFileSync(target, ttl)
    return { path: PATHS.publication, datasets: schemas.length, todos: (ttl.match(/TODO/g) ?? []).length }
}
