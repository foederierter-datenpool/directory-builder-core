import { buildDataFileTree, encodedPath, githubDataUrl } from "./dataFiles.js"
import React from "react"

const fileUrl = (filePath) =>
    new URL(`${import.meta.env.BASE_URL}${encodedPath(filePath)}`, window.location.origin).href

function DirectoryContents({ directory }) {
    const directories = [...directory.directories.values()]
    return (
        <ul className="data-tree-children">
            {directories.map((child) => (
                <li key={child.path}><Directory directory={child} /></li>
            ))}
            {directory.files.map((file) => (
                <li key={file.path} className="data-tree-file">
                    <a href={fileUrl(file.path)} target="_blank" rel="noreferrer">
                        <code>{file.name}</code>
                    </a>
                </li>
            ))}
        </ul>
    )
}

function Directory({ directory }) {
    return (
        <details className="data-tree-directory">
            <summary><code>{directory.name}/</code></summary>
            <DirectoryContents directory={directory} />
        </details>
    )
}

export default function DataFileTree({ files, repositoryUrl }) {
    if (!files.length) return null
    const tree = buildDataFileTree(files)
    const branchUrl = githubDataUrl(repositoryUrl)

    return (
        <details className="data-file-menu">
            <summary>
                Pipeline files
            </summary>
            <div className="data-file-menu-panel">
                <p>
                    {files.length} files: raw source data and every generated pipeline artifact
                    published with this directory.
                    {" "}Browse <code>data/</code> on:{" "}
                    <a href={fileUrl("data/")} target="_blank" rel="noreferrer">
                        this site
                    </a>
                    {branchUrl && <> or on <a href={branchUrl} target="_blank" rel="noreferrer">
                        GitHub
                    </a></>}.
                </p>
                <DirectoryContents directory={tree} />
            </div>
        </details>
    )
}
