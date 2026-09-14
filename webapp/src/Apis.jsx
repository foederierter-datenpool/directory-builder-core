// Instance content replaces the default API guide when provided.
import React from "react"
import { marked } from "marked"
import HelpTip from "./HelpTip.jsx"
import { apisMd } from "./instanceData.js"
import guide from "./api-guide.md?raw"

export default function Apis() {
    return (
        <div className="page api-page">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <h2>APIs</h2>
                <HelpTip title="APIs" label="About the APIs">
                    <div>
                        Access the directory from other applications. SPARQL queries the
                        published RDF graph directly; REST offers convenient predefined
                        methods. Swagger documents the REST methods and lets you try them.
                    </div>
                    <div>
                        The Query page runs in your browser. These endpoints run on a
                        server and may use a different data snapshot.
                    </div>
                </HelpTip>
            </div>
            <section aria-label={apisMd ? "This directory's API" : "Directory API guide"}
                dangerouslySetInnerHTML={{ __html: marked.parse(apisMd || guide) }} />
        </div>
    )
}
