import { vocabularyTables } from "../webapp/src/vocabularyTables.js"
import assert from "node:assert/strict"
import { test } from "node:test"

test("schema tables query the profile's memberships, labels, shared fields and value types", async () => {
    const ttl = `
        @prefix ex: <https://example.org/> .
        @prefix sh: <http://www.w3.org/ns/shacl#> .
        @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
        @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
        ex:OfferShape a sh:NodeShape ; sh:targetClass ex:Offer ; rdfs:label "Offers"@en ;
            sh:property ex:nameField, ex:providerField, ex:unknownField .
        ex:ProviderShape a sh:NodeShape ; sh:targetClass ex:Provider ; rdfs:label "Providers"@en ;
            sh:property ex:nameField .
        ex:OtherShape a sh:NodeShape ; sh:targetClass ex:Other .
        ex:nameField a sh:PropertyShape ; sh:path ex:name ; sh:name "Local name"@en ; sh:datatype xsd:string .
        ex:name rdfs:label "Upstream name"@en, "Name"@de .
        ex:providerField a sh:PropertyShape ; sh:path ex:provider ; sh:nodeKind sh:IRI ;
            sh:or ( [ sh:class ex:Provider ] [ sh:node ex:otherConstraint ] ) .
        ex:otherConstraint a sh:NodeShape ; sh:class ex:Other .
        ex:unknownField a sh:PropertyShape ; sh:path ex:unknown .
        ex:unusedField a sh:PropertyShape ; sh:path ex:unused ; sh:datatype xsd:boolean .`
    const schemas = await vocabularyTables(ttl)
    assert.deepEqual(schemas.map((schema) => schema.label), ["Offers", "Providers", "ex:Other"])
    const [offer, provider, other] = schemas
    assert.equal(offer.fields.length, 3)
    assert.equal(provider.fields.length, 1)
    assert.equal(other.fields.length, 0)
    assert.deepEqual(offer.fields[0], provider.fields[0])
    assert.deepEqual(offer.fields[0].values, ["Text"])
    assert.deepEqual(offer.fields[1].values, ["Link to ", "(",
        { label: "Providers", schema: provider.iri }, " or ", { label: "ex:Other", schema: other.iri }, ")"])
    assert.equal(offer.fields[2].predicateName, "ex:unknown")
    assert.deepEqual(offer.fields[2].values, ["Not specified"])
    const changed = await vocabularyTables(ttl.replace('sh:datatype xsd:string', 'sh:datatype xsd:integer'))
    assert.deepEqual(changed[0].fields[0].values, ["Whole number"])
    assert.deepEqual(await vocabularyTables(""), [])
})
