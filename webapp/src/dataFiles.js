const directoryNode = (name, path) => ({
    name,
    path,
    directories: new Map(),
    files: [],
})

// Convert ["data/directory.ttl", ...] into a directory tree. The virtual
// module already sorts paths; sorting here keeps this helper safe on any input.
export function buildDataFileTree(paths) {
    const root = directoryNode("data", "data")

    for (const filePath of [...paths].sort()) {
        const parts = filePath.split("/").filter(Boolean)
        if (parts.shift() !== "data" || !parts.length) continue

        const filename = parts.pop()
        let directory = root
        for (const name of parts) {
            if (!directory.directories.has(name)) {
                directory.directories.set(name, directoryNode(name, `${directory.path}/${name}`))
            }
            directory = directory.directories.get(name)
        }
        directory.files.push({ name: filename, path: filePath })
    }

    return root
}

export const encodedPath = (filePath) =>
    filePath.split("/").map(encodeURIComponent).join("/")
