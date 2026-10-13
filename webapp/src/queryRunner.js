// Query and the visual builder share one complete directory store, loaded on demand.
import { storeFromTurtles } from "@foerderfunke/sem-ops-utils/core"
import { queryEngine } from "@foerderfunke/sem-ops-utils/sparql"
import { Writer } from "n3"
import { bindingsToJson } from "./queryResults.js"
import { datatypeByPredicate } from "./sparnaturalConfig.js"

const collectTurtle = stream => new Promise((resolve, reject) => {
    const writer = new Writer({ format: "text/turtle" })
    stream.on("data", quad => writer.addQuad(quad))
    stream.on("end", () => writer.end((error, ttl) => error ? reject(error) : resolve(ttl)))
    stream.on("error", reject)
})

export function createQueryRunner(readTurtle) {
    let pending, loaded = false
    const getStore = (onProgress) => {
        if (!loaded) onProgress("Loading directory…")
        pending ??= Promise.resolve().then(readTurtle).then(ttl => {
            const store = storeFromTurtles([ttl])
            loaded = true
            return store
        })
            .catch(error => { pending = null; throw error })
        return pending
    }
    return {
        async datatypes(onProgress = () => {}) {
            const store = await getStore(onProgress)
            onProgress("Preparing visual builder…")
            return Object.fromEntries(datatypeByPredicate(store.getQuads(null, null, null, null)))
        },
        async run(query, onProgress = () => {}) {
            const store = await getStore(onProgress)
            onProgress("Running query…")
            const result = await queryEngine.query(query, { sources: [store] })
            const contentType = "application/sparql-results+json"
            if (result.resultType === "bindings") return { body: JSON.stringify(await bindingsToJson(result)), contentType }
            if (result.resultType === "boolean") return { body: JSON.stringify({ head: {}, boolean: await result.execute() }), contentType }
            if (result.resultType === "quads") return { body: await collectTurtle(await result.execute()), contentType: "text/turtle" }
            return { body: "", contentType }
        },
    }
}
