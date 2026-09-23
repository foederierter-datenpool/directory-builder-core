import { Pipeline } from "@directory-builder/core"
import { PATHS, parseTtl } from "@directory-builder/core/utils"
import { makeInstance } from "./helpers/instance.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import path from "path"
import fs from "fs"

// The direct-mapping generator emits one UNION branch per field. Parallel
// OPTIONALs cartesian-product over multi-valued fields; these assert the shape
// and, more importantly, the case that shape could silently break.

const federation = `
@prefix :       <https://civic-data.de/pipeline#> .
@prefix schema: <http://schema.org/> .
@prefix ft:     <http://publications.europa.eu/resource/authority/file-type/> .

:federation a :Federation ; :hasSource :alphaSource .

:thingSchema a :TargetSchema ; :targetClass schema:Thing .

:t-name  a :TargetField ; :targetPredicate schema:name .
:t-kw    a :TargetField ; :targetPredicate schema:keywords ; :multiValued true .
:t-area  a :TargetField ; :targetPredicate schema:areaServed ; :multiValued true .

:alphaSource a :Source ; :format ft:JSON ;
    :hasField :a-id, :a-name, :a-kw1, :a-kw2, :a-area1, :a-area2 .

:a-id    a :SourceField ; :fieldPath "id" ; :iriSource true .
:a-name  a :SourceField ; :fieldPath "name" .
:a-kw1   a :SourceField ; :fieldPath "kw1" .
:a-kw2   a :SourceField ; :fieldPath "kw2" .
:a-area1 a :SourceField ; :fieldPath "area1" .
:a-area2 a :SourceField ; :fieldPath "area2" .

:alpha-mapping a :Mapping ; :fromSource :alphaSource ; :toTarget :thingSchema ;
    :hasFieldMapping [ :from :a-name ; :to :t-name ] ,
                     [ :from :a-kw1 ; :to :t-kw ] , [ :from :a-kw2 ; :to :t-kw ] ,
                     [ :from :a-area1 ; :to :t-area ] , [ :from :a-area2 ; :to :t-area ] .

:match a :MatchRule ; :forTarget :thingSchema ; :targetNamespace "urn:test:" ;
    :mintedSubjectPrefix "t-" ; :minScore 1.0 ;
    :hasWeightedCriterion [ :on schema:name ; :weight 1.0 ] .
`

const records = [
    // Several values across two multi-valued predicates — the shape that used to
    // multiply out.
    { id: "full", name: "Full Record", kw1: "alpha", kw2: "beta", area1: "north", area2: "south" },
    // Every *mapped* field absent or whitespace -- id is the :iriSource only, so
    // no branch of the union matches this record at all. The INSERT still writes
    // entity's type and cdp:fromSource unconditionally, so it must survive: a
    // bare UNION would match no branch and drop it from the mapped graph, which
    // is how a record leaves the federation with nothing reported.
    { id: "empty", name: "   ", kw1: "", kw2: "   ", area1: "", area2: "" },
]

let root
const setup = async () => {
    if (root) return root
    root = makeInstance("map-branches", { federation, sources: { alpha: records } })
    await new Pipeline({ root }).run()
    return root
}

test("the generated query unions its field branches instead of stacking OPTIONALs", async () => {
    const dir = path.join(await setup(), PATHS.mappingQueries)
    const query = fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), "utf8")).join("\n")
    assert.match(query, /UNION/, "fields are union branches")
    // One OPTIONAL wraps the union; the targetSchema guard is the only other one.
    const optionals = (query.match(/OPTIONAL\s*\{/g) ?? []).length
    assert.ok(optionals <= 2, `no per-field OPTIONALs left, found ${optionals}`)
})

test("a record whose every mapped field is empty keeps its type and source", async () => {
    const mapped = parseTtl(fs.readFileSync(path.join(await setup(), PATHS.mapped), "utf8"))
    const empty = mapped.filter(q => q.subject.value.includes("empty"))
    assert.ok(empty.length > 0, "the record is still in the mapped graph")
    assert.ok(empty.some(q => q.predicate.value.endsWith("22-rdf-syntax-ns#type")), "it kept its rdf:type")
    assert.ok(empty.some(q => q.predicate.value.endsWith("fromSource")), "it kept cdp:fromSource")
})

test("every value of a multi-valued field is mapped", async () => {
    const mapped = parseTtl(fs.readFileSync(path.join(await setup(), PATHS.mapped), "utf8"))
    const valuesOf = (suffix) => mapped
        .filter(q => q.subject.value.includes("full") && q.predicate.value.endsWith(suffix))
        .map(q => q.object.value).sort()
    assert.deepEqual(valuesOf("keywords"), ["alpha", "beta"])
    assert.deepEqual(valuesOf("areaServed"), ["north", "south"])
})
