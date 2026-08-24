const INDENT = "    "
const DECLARATION = /^(BASE\s+<[^>]+>|PREFIX\s+[^\s:]*:\s*<[^>]+>)\s*/i

const extractDeclarations = (query) => {
    const declarations = []
    let body = query.trim()

    for (let match = body.match(DECLARATION); match; match = body.match(DECLARATION)) {
        declarations.push(match[1])
        body = body.slice(match[0].length)
    }
    return { declarations, body }
}

const linesAroundBraces = (query) => {
    const lines = []
    let current = ""
    let quoted = ""
    let escaped = false
    let inIri = false
    let inComment = false

    const finishLine = () => {
        const line = current.trim()
        if (line) lines.push(line)
        current = ""
    }

    for (let index = 0; index < query.length; index += 1) {
        const character = query[index]

        if (inComment) {
            if (character === "\n") { inComment = false; finishLine() }
            else current += character
            continue
        }
        if (escaped) { current += character; escaped = false; continue }
        if (quoted && character === "\\") { current += character; escaped = true; continue }
        if (quoted) { current += character; if (character === quoted) quoted = ""; continue }
        if (inIri) { current += character; if (character === ">") inIri = false; continue }

        if (character === "#") { current += character; inComment = true }
        else if (character === "\"" || character === "'") { current += character; quoted = character }
        else if (character === "<" && /[A-Za-z/.#:_-]/.test(query[index + 1] ?? "")) {
            current += character
            inIri = true
        } else if (character === "{") { current = `${current.trimEnd()} {`; finishLine() }
        else if (character === "}") { finishLine(); lines.push("}") }
        else if (character === "." && /\s/.test(query[index + 1] ?? "")) {
            current += character
            finishLine()
        }
        else if (character === "\n") finishLine()
        else current += character
    }
    finishLine()
    return lines
}

const indentGroups = (lines) => {
    let depth = 0
    return lines.map((line) => {
        if (line === "}") depth = Math.max(0, depth - 1)
        const formatted = `${INDENT.repeat(depth)}${line}`
        if (line.endsWith("{")) depth += 1
        return formatted
    })
}

export function formatSparql(query) {
    if (!query) return query
    const { declarations, body } = extractDeclarations(query)
    const formattedBody = indentGroups(linesAroundBraces(body))
    return [...declarations, ...(declarations.length ? [""] : []), ...formattedBody].join("\n")
}
