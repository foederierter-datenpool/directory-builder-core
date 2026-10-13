// Parsing and SPARQL execution run off the page's main thread.
// Comunica's nodeify-fetch adapter reads window.Headers in its browser build.
globalThis.window = globalThis
let runner
self.onmessage = async ({ data: { id, url, query } }) => {
    const onProgress = progress => self.postMessage({ id, progress })
    try {
        runner ??= import("./queryRunner.js").then(({ createQueryRunner }) => createQueryRunner(async () => {
            const response = await fetch(url)
            if (!response.ok) throw new Error(`Could not load the directory (${response.status})`)
            return response.text()
        }))
        const queries = await runner
        const result = query == null ? await queries.datatypes(onProgress) : await queries.run(query, onProgress)
        self.postMessage({ id, result })
    } catch (error) {
        self.postMessage({ id, error: error.message ?? String(error) })
    }
}
