import React, { useEffect, useMemo } from "react"
import { PATHS } from "@directory-builder/core/utils"
import { federationTtl } from "./instanceData.js"
import { loadVocabulary } from "./loadVocabulary.js"
import { highlightTurtle } from "./highlightTurtle.js"
import "prismjs/themes/prism-okaidia.css"

const vocabulary = await loadVocabulary(federationTtl, async (path) => {
    const response = await fetch(`${import.meta.env.BASE_URL}${path}`).catch(() => null)
    if (!response?.ok || response.headers.get("content-type")?.includes("text/html")) return ""
    return response.text()
})
const highlighted = highlightTurtle(vocabulary)

export default function Vocabulary() {
    const downloadUrl = useMemo(() => URL.createObjectURL(new Blob([vocabulary], { type: "text/turtle;charset=utf-8" })), [])
    useEffect(() => () => URL.revokeObjectURL(downloadUrl), [downloadUrl])

    return (
        <div className="page vocabulary-page">
            <h1>Target vocabulary</h1>
            <p>This application profile combines the directory’s vocabulary (RDFS) and validation rules (SHACL)
                in one document, derived from its configuration.</p>
            <p>Some configured fields may be absent from the published data. Fields are optional unless a minimum
                count is declared; additional properties are allowed unless a shape is closed.</p>
            <p><a href={downloadUrl} download={PATHS.targetVocabulary.split("/").pop()}>Download target-vocabulary.ttl</a></p>
            <pre className="language-turtle">
                <code className="language-turtle" dangerouslySetInnerHTML={{ __html: highlighted }} />
            </pre>
        </div>
    )
}
