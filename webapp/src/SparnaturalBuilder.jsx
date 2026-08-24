import React, { useEffect, useRef, useState } from "react"
import { formatSparql } from "./formatSparql.js"

const SPARNATURAL_VERSION = "12.2.1"
const cdn = (path) => `https://cdn.jsdelivr.net/npm/${path}`

let loadingSparnatural
const addStylesheet = (href) => {
    if (document.querySelector(`link[href="${href}"]`)) return
    const link = document.createElement("link")
    link.rel = "stylesheet"
    link.href = href
    document.head.append(link)
}

const loadSparnatural = () => {
    addStylesheet(cdn(`sparnatural@${SPARNATURAL_VERSION}/dist/browser/sparnatural.css`))
    addStylesheet(cdn("@fortawesome/fontawesome-free@6.5.2/css/all.min.css"))
    if (customElements.get("spar-natural")) return Promise.resolve()
    if (loadingSparnatural) return loadingSparnatural

    loadingSparnatural = new Promise((resolve, reject) => {
        const script = document.createElement("script")
        script.src = cdn(`sparnatural@${SPARNATURAL_VERSION}/dist/browser/sparnatural.js`)
        script.onload = resolve
        script.onerror = () => reject(new Error("Could not load the visual query builder."))
        document.head.append(script)
    }).then(() => customElements.whenDefined("spar-natural"))
        .catch((error) => { loadingSparnatural = undefined; throw error })
    return loadingSparnatural
}

export default function SparnaturalBuilder({ open, config, endpoint, onQuery, onSubmit, example }) {
    const hostRef = useRef(null)
    const elementRef = useRef(null)
    const callbacks = useRef({ onQuery, onSubmit })
    const teardown = useRef(null)
    const runExample = useRef(false)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState("")
    const [ready, setReady] = useState(false)
    callbacks.current = { onQuery, onSubmit }

    useEffect(() => {
        if (!open || !config || elementRef.current) return
        let cancelled = false
        setLoading(true)
        setError("")
        setReady(false)

        loadSparnatural().then(() => {
            if (cancelled || !hostRef.current) return
            const element = document.createElement("spar-natural")
            const attributes = {
                src: config,
                endpoint,
                lang: "en",
                defaultLang: "en",
                distinct: "true",
                limit: "100",
                maxDepth: "4",
            }
            for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value)

            const initialized = () => setReady(true)
            const queryUpdated = (event) => {
                const rawQuery = event.detail?.queryString
                if (!rawQuery) return
                const shouldRun = runExample.current
                runExample.current = false
                const expandedQuery = element.expandSparql?.(rawQuery) ?? rawQuery
                callbacks.current.onQuery(formatSparql(expandedQuery), shouldRun)
            }
            const submit = () => callbacks.current.onSubmit()
            element.addEventListener("init", initialized)
            element.addEventListener("queryUpdated", queryUpdated)
            element.addEventListener("submit", submit)
            hostRef.current.replaceChildren(element)
            elementRef.current = element
            teardown.current = () => {
                element.removeEventListener("init", initialized)
                element.removeEventListener("queryUpdated", queryUpdated)
                element.removeEventListener("submit", submit)
                element.remove()
                elementRef.current = null
            }
        }).catch((loadError) => {
            if (!cancelled) setError(String(loadError?.message ?? loadError))
        }).finally(() => {
            if (!cancelled) setLoading(false)
        })

        return () => { cancelled = true }
    }, [open, config, endpoint])

    useEffect(() => {
        if (!open || !ready || !example?.visual || !elementRef.current) return
        runExample.current = true
        elementRef.current.loadQuery(structuredClone(example.visual))
    }, [open, ready, example])

    useEffect(() => () => teardown.current?.(), [])

    return (
        <div className="sparnatural-wrap" hidden={!open}>
            {loading && <div className="query-builder-status">Loading visual query builder…</div>}
            {error && <div className="query-builder-error">{error}</div>}
            <div ref={hostRef} />
        </div>
    )
}
