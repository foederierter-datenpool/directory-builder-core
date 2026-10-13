// Query opens the editor first; the complete directory loads on demand in a worker.

import { displayPrefixes, federationTtl, fetchTexts } from "./instanceData.js"
import { PATHS } from "@directory-builder/core/utils"
import { readQueryExamples } from "./queryExamples.js"
import { queryRequest } from "./queryWorkerClient.js"
import { buildSparnaturalConfig, buildSparnaturalQuery } from "./sparnaturalConfig.js"
import HelpTip from "./HelpTip.jsx"
import SparnaturalBuilder from "./SparnaturalBuilder.jsx"
import React, { useCallback, useEffect, useRef, useState } from "react"
import "@zazuko/yasgui/build/yasgui.min.css"
import Yasgui from "@zazuko/yasgui"

// Yasgui talks to a SPARQL endpoint over HTTP. We have no endpoint — queries
// run in-browser against an n3 Store. So we point Yasgui at this fake URL and
// install a fetch interceptor that routes those requests through Comunica.
const ENDPOINT = "http://local/sparql"
const EDITOR_HEIGHT = "300px"
const [queryExamplesTtl, querySparql] = await fetchTexts([PATHS.queryExamples, PATHS.query])

// Instances own the editor's starting query via webapp/content/query.sparql
// (fetched at runtime like the About prose); plain select-all without one.
const INITIAL_QUERY = querySparql || "SELECT * WHERE { ?s ?p ?o } LIMIT 100"
const QUERY_EXAMPLES = readQueryExamples(queryExamplesTtl)
    .map((example) => example.visual
        ? { ...example, visual: buildSparnaturalQuery(federationTtl, example.visual) }
        : example)
    .filter((example) => example.query || example.visual)
const TEXT_EXAMPLES = QUERY_EXAMPLES.filter((example) => example.query)
const VISUAL_EXAMPLES = QUERY_EXAMPLES.filter((example) => example.visual)
const HAS_VISUAL_BUILDER = Boolean(buildSparnaturalConfig(federationTtl))

Yasgui.Yasqe.defaults.value = INITIAL_QUERY

// Yasqe calls `fetch(new Request(url, opts))` rather than `fetch(url, opts)`,
// so we normalise both forms into one shape.
const requestParts = async (input, init) => {
    if (input instanceof Request) {
        return { url: input.url, method: input.method, headers: input.headers, body: input.method !== "GET" ? await input.text() : "" }
    }
    const headers = new Headers(init?.headers || {})
    const body = init?.body != null ? (typeof init.body === "string" ? init.body : String(init.body)) : ""
    return { url: typeof input === "string" ? input : input?.url, method: init?.method || "GET", headers, body }
}

const extractQuery = ({ url, method, headers, body }) => {
    const accept = headers.get("Accept")
    if (method !== "GET" && body) {
        const ct = headers.get("Content-Type") || ""
        if (ct.includes("application/sparql-query")) return { query: body, accept }
        const query = new URLSearchParams(body).get("query") || new URLSearchParams(body).get("update")
        if (query) return { query, accept }
    }
    return { query: new URL(url).searchParams.get("query"), accept }
}

const handleSparql = async (parts, onProgress) => {
    const { query } = extractQuery(parts)
    if (!query) return new Response("missing query", { status: 400 })
    try {
        const { body, contentType } = await queryRequest(query, onProgress)
        return new Response(body, { status: 200, headers: { "Content-Type": contentType } })
    } catch (error) {
        return new Response(error.message || String(error), { status: 400 })
    } finally {
        onProgress("")
    }
}

let intercepted = false
let reportProgress = () => {}
const installInterceptor = () => {
    if (intercepted) return
    intercepted = true
    const orig = window.fetch.bind(window)
    window.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : (typeof input === "string" ? input : input?.url)
        if (!url?.startsWith(ENDPOINT)) return orig(input, init)
        return handleSparql(await requestParts(input, init), status => reportProgress(status))
    }
}

// Yasgui's default share link clobbers the React Router hash. Emit one
// HashRouter accepts (#/query?<params>) instead, and reverse the parse on mount.
const SHARE_PREFIX = "#/query?"
const installShareOverride = () => {
    Yasgui.Tab.prototype.getShareableLink = function () {
        const cfg = this.getShareObject()
        const params = new URLSearchParams()
        for (const [k, v] of Object.entries(cfg)) {
            if (v == null || v === "") continue
            params.set(k, typeof v === "string" ? v : JSON.stringify(v))
        }
        return `${location.origin}${location.pathname}${SHARE_PREFIX}${params}`
    }
}

const sharedQueryFromUrl = () => {
    if (!location.hash.startsWith(SHARE_PREFIX)) return null
    return new URLSearchParams(location.hash.slice(SHARE_PREFIX.length)).get("query")
}

export default function Query() {
    const editorRef = useRef(null)
    const yasguiRef = useRef(null)
    const [visualOpen, setVisualOpen] = useState(false)
    const [visualExample, setVisualExample] = useState(null)
    const [visualConfig, setVisualConfig] = useState(null)
    const [status, setStatus] = useState("")
    const [visualError, setVisualError] = useState("")
    useEffect(() => {
        reportProgress = setStatus
        return () => { reportProgress = () => {} }
    }, [])
    useEffect(() => {
        if (!visualOpen || visualConfig) return
        let cancelled = false
        setVisualError("")
        queryRequest(null, status => { if (!cancelled) setStatus(status) }).then(hints => {
            if (!cancelled) {
                setVisualConfig(buildSparnaturalConfig(federationTtl, "", hints))
                setStatus("")
            }
        }).catch(error => {
            if (!cancelled) { setVisualError(error.message); setStatus("") }
        })
        return () => { cancelled = true; setStatus("") }
    }, [visualOpen, visualConfig])

    const setEditorQuery = useCallback((query, run = false) => {
        const tab = yasguiRef.current?.getTab()
        if (!tab || !query) return
        tab.setQuery(query)
        if (run) tab.getYasqe()?.query()
    }, [])

    const runEditorQuery = useCallback(() => {
        yasguiRef.current?.getTab()?.getYasqe()?.query()
    }, [])

    useEffect(() => {
        installInterceptor()
        installShareOverride()
        const el = editorRef.current
        if (!el) return
        const y = new Yasgui(el, {
            requestConfig: { endpoint: ENDPOINT, method: "POST" },
            copyEndpointOnNewTab: false,
            populateFromUrl: false,
            yasqe: { editorHeight: EDITOR_HEIGHT },
            yasr: { prefixes: displayPrefixes },
        })
        yasguiRef.current = y
        y.getTab()?.getYasqe()?.setSize(null, EDITOR_HEIGHT)
        const shared = sharedQueryFromUrl()
        if (shared) {
            y.getTab()?.setQuery(shared)
            if (new URLSearchParams(location.hash.slice(SHARE_PREFIX.length)).get("run") === "1") y.getTab()?.getYasqe()?.query()
        }
        return () => {
            yasguiRef.current = null
            el.innerHTML = ""
            y?.destroy?.()
        }
    }, [])

    const selectExample = (event) => {
        const example = QUERY_EXAMPLES.find(({ id }) => id === event.target.value)
        if (!example) return
        if (example.visual) {
            setVisualExample(example)
            setVisualOpen(true)
            return
        }
        setVisualExample(null)
        setVisualOpen(false)
        setEditorQuery(example.query, true)
    }

    return (
        <div className="query-page">
            <div className="query-toolbar">
                <HelpTip title="Query" label="About the query editor">
                    <div>
                        An editor for SPARQL, the query language for graph data, running entirely
                        in your browser against the finished directory: no server, no endpoint.
                        Share links carry the query in the URL.
                    </div>
                    <div>
                        Choose a prepared example or build a query visually. The visual builder
                        writes SPARQL into the editor; its play button runs the query there.
                    </div>
                </HelpTip>
                {QUERY_EXAMPLES.length > 0 && (
                    <select className="query-example-select" defaultValue="" onChange={selectExample}
                        aria-label="Example queries">
                        <option value="" disabled>Choose an example…</option>
                        {TEXT_EXAMPLES.map((example) => (
                            <option key={example.id} value={example.id}>{example.name}</option>
                        ))}
                        {VISUAL_EXAMPLES.length > 0 && (
                            <optgroup label="Visual query builder">
                                {VISUAL_EXAMPLES.map((example) => (
                                    <option key={example.id} value={example.id}>{example.name}</option>
                                ))}
                            </optgroup>
                        )}
                    </select>
                )}
                {HAS_VISUAL_BUILDER && (
                    <button className="query-visual-toggle" type="button"
                        aria-expanded={visualOpen} title="Powered by Sparnatural"
                        onClick={() => setVisualOpen((open) => !open)}>
                        Build visually <span className="query-toggle-caret" aria-hidden="true">▾</span>
                    </button>
                )}
            </div>
            {status && <p role="status" style={{ margin: "0.25rem 0", fontSize: 13 }}>{status}</p>}
            {visualOpen && visualError && <p>{visualError}</p>}
            <SparnaturalBuilder
                open={visualOpen && Boolean(visualConfig)}
                config={visualConfig}
                endpoint={ENDPOINT}
                onQuery={setEditorQuery}
                onSubmit={runEditorQuery}
                example={visualExample}
            />
            <div ref={editorRef} className="query-editor page" />
        </div>
    )
}
