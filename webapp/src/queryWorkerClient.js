// Start a worker only when a query or visual builder needs the directory.
import { PATHS } from "@directory-builder/core/utils"

let worker, sequence = 0
const pending = new Map()
export function queryRequest(query, onProgress = () => {}) {
    if (!worker) {
        worker = new Worker(new URL("./queryWorker.js", import.meta.url), { type: "module" })
        worker.onmessage = ({ data }) => {
            const request = pending.get(data.id)
            if (!request) return
            if (data.progress) { request.onProgress(data.progress); return }
            pending.delete(data.id)
            data.error ? request.reject(new Error(data.error)) : request.resolve(data.result)
        }
        worker.onerror = error => {
            for (const request of pending.values()) request.reject(new Error(error.message || "Query worker failed"))
            pending.clear()
            worker.terminate()
            worker = null
        }
    }
    return new Promise((resolve, reject) => {
        const id = ++sequence
        pending.set(id, { resolve, reject, onProgress })
        const url = new URL(`${import.meta.env.BASE_URL}${PATHS.final}`, document.baseURI).href
        worker.postMessage({ id, url, query })
    })
}
