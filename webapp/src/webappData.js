// Generated metadata is optional; older snapshots use the complete RDF files.
import { parseTtl, PATHS } from "@directory-builder/core/utils"
import { WEBAPP_DATA_VERSION, webappChunkingEnabled } from "@directory-builder/core/webapp-data"
import { federationTtl, fetchText } from "./instanceData.js"

const enabled = webappChunkingEnabled(parseTtl(federationTtl))
const pending = new Map()
export function loadWebappIndex(path = PATHS.webappIndex) {
    if (!enabled) return Promise.resolve(null)
    if (!pending.has(path)) pending.set(path, fetchText(path).then(text => {
        try {
            const index = JSON.parse(text)
            return index.version === WEBAPP_DATA_VERSION ? index : null
        } catch { return null }
    }))
    return pending.get(path)
}

export async function fetchChunk(path) {
    const response = await fetch(`${import.meta.env.BASE_URL}${path}`)
    if (!response.ok) throw new Error(`Could not load page data (${response.status})`)
    return response.json()
}
