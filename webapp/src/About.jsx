// About page: instances own the content by providing webapp/content/about.md
// (fetched at runtime like config and data); without one, a generic default
// renders. Markdown, single newlines = line breaks.

import { aboutMd } from "./instanceData.js"
import { marked } from "marked"
import React from "react"

const DEFAULT = `## Federated directory

Builds a federated directory by mapping heterogeneous source schemas into a unified target schema.
The directory can be queried or downloaded.
This site serves both its users and those interested in the federation process itself.
Toggle "Show federation process" in the top bar to inspect the steps.

*The data shown here is example data: two fictional library directories exercising the pipeline and this webapp.
A real use case replaces it with its own sources and this text with its own about page.*`

export default function About() {
    return (
        <div className="page" style={{ maxWidth: "100ch", lineHeight: 1.5 }}
             dangerouslySetInnerHTML={{ __html: marked.parse(aboutMd || DEFAULT, { breaks: true }) }} />
    )
}
