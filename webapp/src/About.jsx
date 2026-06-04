import React from "react"

export default function About() {
    return (
        <div className="page" style={{ maxWidth: "100ch", lineHeight: 1.5 }}>
            <h2>Federated directory of social support services in Germany</h2>
            <p>Builds a federated directory by mapping heterogeneous source schemas into a unified target schema.<br/>The directory can be queried, downloaded, or accessed via APIs.<br/>This site serves both its users and those interested in the federation process itself.<br/>Toggle "Show federation process" in the top bar to inspect the steps.</p>
        </div>
    )
}
