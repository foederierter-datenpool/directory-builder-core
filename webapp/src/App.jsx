import { HashRouter, Routes, Route, NavLink } from "react-router-dom"
import "./styles.css"
import { federationLabel, repositoryUrl } from "./instanceData.js"
import About from "./About.jsx"
import React, { lazy, Suspense, useState } from "react"

// Lazy-load route views so their heavy deps load only when the route is
// visited: comunica + yasgui (Query), comunica + jsonld (Download), xyflow
// (Map/Match). About stays eager as the landing route.
const Directory   = lazy(() => import("./Directory.jsx"))
const Download    = lazy(() => import("./Download.jsx"))
const Pipeline    = lazy(() => import("./Pipeline.jsx"))
const MapGraph    = lazy(() => import("./MapGraph.jsx"))
const MatchGraph  = lazy(() => import("./MatchGraph.jsx"))
const MergeTables = lazy(() => import("./MergeTables.jsx"))
const Query       = lazy(() => import("./Query.jsx"))
const Sources     = lazy(() => import("./Sources.jsx"))

if (federationLabel) document.title = federationLabel

const STORAGE_KEY = "showFederation"

const initialShowFed = () => {
    try { return localStorage.getItem(STORAGE_KEY) === "true" } catch { return false }
}

function Nav() {
    const [showFed, setShowFed] = useState(initialShowFed)
    const update = (v) => {
        setShowFed(v)
        try { localStorage.setItem(STORAGE_KEY, String(v)) } catch {}
    }
    return (
        <nav>
            <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                <NavLink to="/" end>About</NavLink>
                {showFed && (
                    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", border: "1px solid #aaa", borderRadius: 4, padding: "0.3rem 0.6rem" }}>
                        <NavLink to="/sources">Sources</NavLink>
                        <NavLink to="/pipeline">Pipeline</NavLink>
                        <NavLink to="/map">Map</NavLink>
                        <NavLink to="/match">Match</NavLink>
                        <NavLink to="/merge">Merge</NavLink>
                    </div>
                )}
                <NavLink to="/directory">Directory</NavLink>
                <NavLink to="/query">Query</NavLink>
                <NavLink to="/download">Download</NavLink>
                <NavLink to="/apis">APIs</NavLink>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                <label style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem", fontSize: 13, color: "#666" }}>
                    <input type="checkbox" checked={showFed} onChange={(e) => update(e.target.checked)} />
                    Show federation process
                </label>
                {repositoryUrl && <a href={repositoryUrl} target="_blank" rel="noreferrer">GitHub</a>}
            </div>
        </nav>
    )
}

function Apis() {
    return (
        <div className="page">
            <p><strong>TODO</strong>:</p>
            <ul>
                <li>OpenAPI / Swagger</li>
                <li>SPARQL endpoint</li>
            </ul>
        </div>
    )
}

export default function App() {
    return (
        <HashRouter>
            <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
                <Nav />
                <main>
                    <Suspense fallback={<div className="page">Loading…</div>}>
                        <Routes>
                            <Route path="/" element={<About />} />
                            <Route path="/pipeline" element={<Pipeline />} />
                            <Route path="/sources" element={<Sources />} />
                            <Route path="/map" element={<MapGraph />} />
                            <Route path="/match" element={<MatchGraph />} />
                            <Route path="/merge" element={<MergeTables />} />
                            <Route path="/directory" element={<Directory />} />
                            <Route path="/query" element={<Query />} />
                            <Route path="/download" element={<Download />} />
                            <Route path="/apis" element={<Apis />} />
                        </Routes>
                    </Suspense>
                </main>
            </div>
        </HashRouter>
    )
}
