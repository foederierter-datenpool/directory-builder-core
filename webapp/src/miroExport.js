// Generates the paste-into-console snippet that replicates the Map view on a
// Miro board: one round_rectangle per node (column colors and dashed borders
// preserved), a dashed background rectangle per source-entity group, and a
// connector per edge. Works without a Miro app or API key — the Web SDK is
// exposed as `miro.board` in the dev console of any open board:
// https://developers.miro.com/docs/use-the-developer-tools-with-the-miro-web-sdk
// Pure (flow layout in → code string out); the layout comes from the same
// toFlow() the Map page renders, so the board mirrors the current view.

// Where connectors leave a shape, per flow direction (relative coords on the
// item, e.g. {x:1,y:0.5} = middle of the right edge); the entry point is
// always the mirror image. Matches the webapp's fixed handles.
const OUT_POS = {
    "left-right": { x: 1, y: 0.5 },
    "right-left": { x: 0, y: 0.5 },
    "top-down":   { x: 0.5, y: 1 },
    "down-top":   { x: 0.5, y: 0 },
}

export function buildMiroSnippet(flowNodes, flowEdges, direction = "left-right") {
    const outPos = OUT_POS[direction] ?? OUT_POS["left-right"]
    const inPos  = { x: 1 - outPos.x, y: 1 - outPos.y }
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
    // in parallel. Consoles support top-level await; the surrounding block
    // scopes the declarations so the snippet can be pasted repeatedly (the
    // console session would otherwise keep them and refuse re-declaration).
    return `{
const rects = ${JSON.stringify(rects)}
const nodes = ${JSON.stringify(nodes)}
const links = ${JSON.stringify(links)}
const [sel] = await miro.board.getSelection()
let ox = 0, oy = 0
if (sel) {
    ox = sel.x; oy = sel.y + (sel.height ?? 100)
    // A frame child's x/y are relative to the frame's TOP-LEFT corner, while
    // shapes are created in absolute board coords (a frame's own x/y is its
    // centre) — translate the anchor accordingly.
    if (sel.parentId) {
        const [frame] = await miro.board.get({ id: [sel.parentId] })
        ox += frame.x - frame.width / 2
        oy += frame.y - frame.height / 2
    }
}
const shape = (it, style) => miro.board.createShape({
    shape: "round_rectangle", content: it.content,
    x: ox + it.x, y: oy + it.y, width: it.w, height: it.h, style,
})
for (const r of rects) await shape(r, { fillColor: "#787878", fillOpacity: 0.05, borderColor: "#c4c4c4", borderStyle: "dashed", borderWidth: 1, color: "#999999", fontSize: 10, textAlign: "left", textAlignVertical: "top" })
const made = await Promise.all(nodes.map((n) =>
    shape(n, { fillColor: n.fill, borderColor: "#888888", borderStyle: n.dashed ? "dashed" : "normal", borderWidth: 1, fontSize: 10, textAlign: "center", textAlignVertical: "middle" })))
await Promise.all(links.map(([f, t]) => miro.board.createConnector({
    start: { item: made[f].id, position: ${JSON.stringify(outPos)} },
    end:   { item: made[t].id, position: ${JSON.stringify(inPos)} },
    shape: "curved", style: { strokeColor: "#999999", strokeWidth: 1, endStrokeCap: "stealth" },
})))
}
`
}
