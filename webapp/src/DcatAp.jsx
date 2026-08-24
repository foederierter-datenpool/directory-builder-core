// DCAT-AP view: the published catalog, as the file a portal actually reads.
// Reads:  data/catalog.ttl (written by the publish step, which only
//         runs when the instance declares a config/publication.ttl)
// Does:   links to the served catalog.ttl and renders it syntax-highlighted

import { catalogTtl } from "./instanceData.js"
import { PATHS } from "@directory-builder/core/utils"
import HelpTip from "./HelpTip.jsx"
import React from "react"
import Prism from "prismjs"
import "prismjs/components/prism-turtle.js"
import "prismjs/themes/prism-okaidia.css"

// The deployed catalog: the webapp serves data/ verbatim, so the file behind
// this link is the one a harvester dereferences.
const CATALOG_URL = `${import.meta.env.BASE_URL}${PATHS.catalog}`

// Prism escapes the source as it highlights, so the returned markup is safe to
// inject; highlighting once at module load keeps re-renders free.
const HIGHLIGHTED = Prism.highlight(catalogTtl, Prism.languages.turtle, "turtle")

export default function DcatAp() {
    return (
        <div className="page" style={{ overflowY: "auto", height: "100%" }}>
            <div style={{ display: "flex", marginBottom: "0.5rem" }}>
                <HelpTip title="DCAT-AP" label="About this catalog">
                    <div>
                        Catalog metadata describing this directory as a dataset: who publishes
                        it, under which licence, how often it updates, and which sources it was
                        merged from. The pipeline writes it on every run from the
                        <code> config/publication.ttl</code> the instance declares, so it never
                        drifts from the data it describes.
                    </div>
                    <div>
                        The standard is <a href="https://www.dcat-ap.de/def/dcatde/3.0/spec/" target="_blank" rel="noreferrer">DCAT-AP.de 3.0</a>,
                        the German profile of the European DCAT-AP.
                    </div>
                </HelpTip>
            </div>
            <p style={{ fontSize: 13, lineHeight: 1.55, color: "#444", maxWidth: 720, marginTop: 0 }}>
                This catalog can be uploaded to, or harvested from, an Open Data portal such as GovData.
            </p>
            <p style={{ fontSize: 13, marginBottom: "1rem" }}>
                <a href={CATALOG_URL} target="_blank" rel="noreferrer"><code>{PATHS.catalog}</code></a>
            </p>
            {/* Both elements carry the language class: the theme paints its dark
                background off `pre[class*="language-"]`, and without it the block
                keeps okaidia's near-white text on the page's white. */}
            {/* 92ch holds ~90% of the catalog's lines (median 50, p90 82); the few
                long IRIs scroll inside the block rather than widening the page. */}
            <pre className="language-turtle" style={{ margin: 0, fontSize: 14, maxWidth: "120ch" }}>
                <code className="language-turtle" dangerouslySetInnerHTML={{ __html: HIGHLIGHTED }} />
            </pre>
        </div>
    )
}
