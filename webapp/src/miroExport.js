// Generates the paste-into-console snippet that replicates the Map view on a
// Miro board: one round_rectangle per node (column colors and dashed borders
// preserved), a dashed background rectangle per source-entity group, and a
// connector per edge. Works without a Miro app or API key — the Web SDK is
// exposed as `miro.board` in the dev console of any open board:
// https://developers.miro.com/docs/use-the-developer-tools-with-the-miro-web-sdk
// Pure (flow layout in → code string out); the layout comes from the same
// toFlow() the Map page renders, so the board mirrors the current view.

export function buildMiroSnippet(flowNodes, flowEdges) {
    const rects = []  // group rectangles, created first so they sit behind the nodes
    const nodes = []
    for (const n of flowNodes) {
        if (n.type === "groupNode") {
            const { width: w, height: h } = n.style
            rects.push({ x: n.position.x + w / 2, y: n.position.y + h / 2, w, h, content: n.data.label ?? "" })
        } else if (n.type === "sideNode") {
            const w = n.style.width
            const h = n.data.estH ?? 36
            nodes.push({
                id: n.id,
                x: n.position.x + w / 2, y: n.position.y + h / 2, w, h,  // Miro coords are centre-based
                content: n.data.subtitle ? `${n.data.label}<br/><em>${n.data.subtitle}</em>` : String(n.data.label ?? ""),
                fill: n.style.background,
                ...(String(n.style.border).includes("dashed") && { dashed: 1 }),
            })
        }
    }
    // Links reference node array indices to keep the payload small.
    const indexOf = new Map(nodes.map((n, i) => [n.id, i]))
    const links = flowEdges.flatMap((e) =>
        indexOf.has(e.source) && indexOf.has(e.target) ? [[indexOf.get(e.source), indexOf.get(e.target)]] : [])
    for (const n of nodes) delete n.id

    // Top-left-normalise so the runtime anchor offset means "drop the layout here".
    const all = [...rects, ...nodes]
    const minX = Math.min(...all.map((s) => s.x - s.w / 2))
    const minY = Math.min(...all.map((s) => s.y - s.h / 2))
    for (const s of all) { s.x = Math.round(s.x - minX); s.y = Math.round(s.y - minY) }

    // The runtime: anchor below the selected element (board origin as fallback),
    // group rects sequentially (z-order = creation order), nodes and connectors
    // in parallel. Consoles support top-level await.
    return `const rects = ${JSON.stringify(rects)}
const nodes = ${JSON.stringify(nodes)}
const links = ${JSON.stringify(links)}
const [sel] = await miro.board.getSelection()
const ox = sel?.x ?? 0, oy = sel ? sel.y + (sel.height ?? 100) : 0
const shape = (it, style) => miro.board.createShape({
    shape: "round_rectangle", content: it.content,
    x: ox + it.x, y: oy + it.y, width: it.w, height: it.h, style,
})
for (const r of rects) await shape(r, { fillColor: "#787878", fillOpacity: 0.05, borderColor: "#c4c4c4", borderStyle: "dashed", borderWidth: 1, color: "#999999", fontSize: 10, textAlign: "left", textAlignVertical: "top" })
const made = await Promise.all(nodes.map((n) =>
    shape(n, { fillColor: n.fill, borderColor: "#888888", borderStyle: n.dashed ? "dashed" : "normal", borderWidth: 1, fontSize: 10, textAlign: "center", textAlignVertical: "middle" })))
await Promise.all(links.map(([f, t]) => miro.board.createConnector({
    start: { item: made[f].id, position: { x: 1, y: 0.5 } },  // right edge out, left edge in,
    end:   { item: made[t].id, position: { x: 0, y: 0.5 } },  // matching the webapp's fixed handles
    shape: "curved", style: { strokeColor: "#999999", strokeWidth: 1, endStrokeCap: "stealth" },
})))
`
}
