import { CDP, NAMESPACES, parseTtl } from "@directory-builder/core/utils"

const RDF_TYPE = `${NAMESPACES.rdf}type`
const RDFS_LABEL = `${NAMESPACES.rdfs}label`
const QUERY_EXAMPLE = `${CDP}QueryExample`
const QUERY = `${CDP}query`
const ORDER = `${CDP}order`
const VISUAL_FROM = `${CDP}visualFrom`
const VISUAL_BRANCH = `${CDP}visualBranch`
const VISUAL_THROUGH = `${CDP}visualThrough`
const VISUAL_TO = `${CDP}visualTo`

const termsOf = (quads, subject, predicate) => quads
    .filter((quad) => quad.subject.value === subject && quad.predicate.value === predicate)
    .map((quad) => quad.object)

const preferredLabel = (terms, language) =>
    terms.find((term) => term.language === language)?.value
    ?? terms.find((term) => !term.language)?.value
    ?? terms[0]?.value

export function readQueryExamples(turtle, language = "en") {
    if (!turtle) return []
    const quads = parseTtl(turtle)
    const subjects = quads
        .filter((quad) => quad.predicate.value === RDF_TYPE && quad.object.value === QUERY_EXAMPLE)
        .map((quad) => quad.subject.value)

    return subjects.map((subject, index) => {
        const branches = termsOf(quads, subject, VISUAL_BRANCH).map((branch) => ({
            throughField: termsOf(quads, branch.value, VISUAL_THROUGH)[0]?.value,
            toSchema: termsOf(quads, branch.value, VISUAL_TO)[0]?.value,
        })).filter((branch) => Object.values(branch).every(Boolean))
        const visual = {
            fromSchema: termsOf(quads, subject, VISUAL_FROM)[0]?.value,
            branches,
        }
        const hasVisualPath = visual.fromSchema && visual.branches.length > 0

        return {
            id: subject,
            name: preferredLabel(termsOf(quads, subject, RDFS_LABEL), language),
            query: termsOf(quads, subject, QUERY)[0]?.value,
            visual: hasVisualPath ? visual : undefined,
            order: Number(termsOf(quads, subject, ORDER)[0]?.value ?? index),
        }
    })
        .filter((example) => example.name && (example.query || example.visual))
        .sort((left, right) => left.order - right.order)
}
