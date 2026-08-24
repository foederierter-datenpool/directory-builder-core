// Query view: Yasgui and Sparnatural wired to an in-browser n3 store.
// Reads:  data/pipeline/final.ttl, config/federation.ttl, and the optional
//         webapp/content/{query.sparql,query-examples.ttl}
// Does:   renders prepared, textual and visual SPARQL queries; a fetch
//         interceptor routes the fake endpoint through Comunica

import { storeFromTurtles } from "@foerderfunke/sem-ops-utils/core"
import { NAMESPACES } from "@directory-builder/core/utils"
import { queryEngine } from "@foerderfunke/sem-ops-utils/sparql"
import { displayPrefixes, federationTtl, finalTtl, queryExamplesTtl, querySparql } from "./instanceData.js"
import { readQueryExamples } from "./queryExamples.js"
import { buildSparnaturalConfig, buildSparnaturalQuery } from "./sparnaturalConfig.js"
import HelpTip from "./HelpTip.jsx"
import SparnaturalBuilder from "./SparnaturalBuilder.jsx"
import React, { useCallback, useEffect, useRef, useState } from "react"
import "@zazuko/yasgui/build/yasgui.min.css"
import Yasgui from "@zazuko/yasgui"
import { Writer } from "n3"

// Yasgui talks to a SPARQL endpoint over HTTP. We have no endpoint — queries
// run in-browser against an n3 Store. So we point Yasgui at this fake URL and
// install a fetch interceptor that routes those requests through Comunica.
const ENDPOINT = "http://local/sparql"
const EDITOR_HEIGHT = "300px"

const store = storeFromTurtles([finalTtl])

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
const SPARNATURAL_CONFIG = buildSparnaturalConfig(federationTtl, finalTtl)

Yasgui.Yasqe.defaults.value = INITIAL_QUERY

const XSD_STRING = `${NAMESPACES.xsd}string`
const termToJson = (term) => {
    if (term.termType === "Literal") {
        const v = { type: "literal", value: term.value }
        if (term.language) v["xml:lang"] = term.language
        else if (term.datatype && term.datatype.value !== XSD_STRING) v.datatype = term.datatype.value
        return v
    }
    if (term.termType === "BlankNode") return { type: "bnode", value: term.value }
    return { type: "uri", value: term.value }
}

const collectBindings = (stream) => new Promise((resolve, reject) => {
    const vars = new Set()
    const bindings = []
    stream.on("data", (b) => {
        const row = {}
        for (const [k, v] of b) { vars.add(k.value); row[k.value] = termToJson(v) }
        bindings.push(row)
    })
    stream.on("end", () => resolve({ vars: [...vars], bindings }))
    stream.on("error", reject)
})

const collectQuadsAsTurtle = (stream) => new Promise((resolve, reject) => {
    const writer = new Writer({ format: "text/turtle" })
    stream.on("data", (q) => writer.addQuad(q))
    stream.on("end", () => writer.end((err, ttl) => err ? reject(err) : resolve(ttl)))
    stream.on("error", reject)
})

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

const SPARQL_JSON = "application/sparql-results+json"
const handleSparql = async (parts) => {
    const { query } = extractQuery(parts)
    if (!query) return new Response("missing query", { status: 400 })
    try {
        const result = await queryEngine.query(query, { sources: [store] })
        if (result.resultType === "bindings") {
            const { vars, bindings } = await collectBindings(await result.execute())
            return new Response(JSON.stringify({ head: { vars }, results: { bindings } }), { status: 200, headers: { "Content-Type": SPARQL_JSON } })
        }
        if (result.resultType === "boolean") {
            return new Response(JSON.stringify({ head: {}, boolean: await result.execute() }), { status: 200, headers: { "Content-Type": SPARQL_JSON } })
        }
        if (result.resultType === "quads") {
            const ttl = await collectQuadsAsTurtle(await result.execute())
            return new Response(ttl, { status: 200, headers: { "Content-Type": "text/turtle" } })
        }
        return new Response("", { status: 200 })
    } catch (e) {
        return new Response(String(e?.message || e), { status: 400 })
    }
}

let intercepted = false
const installInterceptor = () => {
    if (intercepted) return
    intercepted = true
    const orig = window.fetch.bind(window)
    window.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : (typeof input === "string" ? input : input?.url)
        if (!url?.startsWith(ENDPOINT)) return orig(input, init)
        return handleSparql(await requestParts(input, init))
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
        if (shared) y.getTab()?.setQuery(shared)
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
                {SPARNATURAL_CONFIG && (
                    <button className="query-visual-toggle" type="button"
                        aria-expanded={visualOpen} title="Powered by Sparnatural"
                        onClick={() => setVisualOpen((open) => !open)}>
                        Build visually <span className="query-toggle-caret" aria-hidden="true">▾</span>
                    </button>
                )}
            </div>
            <SparnaturalBuilder
                open={visualOpen}
                config={SPARNATURAL_CONFIG}
                endpoint={ENDPOINT}
                onQuery={setEditorQuery}
                onSubmit={runEditorQuery}
                example={visualExample}
            />
            <div ref={editorRef} className="query-editor page" />
        </div>
    )
}
