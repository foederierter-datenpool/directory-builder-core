import { NAMESPACES } from "@directory-builder/core/utils"

const termToJson = (term) => {
    if (term.termType === "Literal") {
        const value = { type: "literal", value: term.value }
        if (term.language) value["xml:lang"] = term.language
        else if (term.datatype && term.datatype.value !== `${NAMESPACES.xsd}string`) value.datatype = term.datatype.value
        return value
    }
    return { type: term.termType === "BlankNode" ? "bnode" : "uri", value: term.value }
}

export async function bindingsToJson(result) {
    // Columns come from the query, even when no rows or only unbound values exist.
    const { variables } = await result.metadata()
    const bindings = []
    for await (const binding of await result.execute()) {
        bindings.push(Object.fromEntries([...binding].map(([key, value]) => [key.value, termToJson(value)])))
    }
    return { head: { vars: variables.map(({ value }) => value) }, results: { bindings } }
}
