// Generic column-layout graph (xyflow): arranges nodes into typed columns with
// labelled edges. Pure view — no data loading.
// Reads:  props (nodes, edges, columns, colors, …)
// Does:   renders the flow graph; used by Pipeline, Map and Match

import { ReactFlow, Background, Controls, MarkerType, Handle, Position, useNodesState, useEdgesState, BaseEdge, EdgeLabelRenderer, getBezierPath } from "@xyflow/react"
import React, { createContext, useContext, useEffect, useMemo, useState } from "react"
import "@xyflow/react/dist/style.css"

const DEFAULT_COL_SPACING = 260
const DEFAULT_SIBLING_GAP = 80
const DEFAULT_NODE_WIDTH = 160

function SideNode({ data, style }) {
    const targetPos = data.targetPos ?? Position.Left
    const sourcePos = data.sourcePos ?? Position.Right
    return (
        <div style={style}>
            <Handle type="target" position={targetPos} />
            <div title={data.label} style={{ textAlign: "center", fontWeight: data.props?.length ? 600 : 400, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", wordBreak: "break-word" }}>{data.label}</div>
            {data.subtitle && (
                <div title={data.subtitle} style={{ textAlign: "center", fontSize: 10, color: "#888", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{data.subtitle}</div>
            )}
            {data.props?.length > 0 && (
                <div style={{ marginTop: 6, fontSize: 9, lineHeight: "13px", color: "#888" }}>
                    {data.props.map((p, i) => (
                        <div key={i} style={{ display: "flex", gap: 4, whiteSpace: "nowrap", overflow: "hidden" }} title={`${p.key}: ${p.value}`}>
                            <span>{p.key}:</span>
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{p.value}</span>
                        </div>
                    ))}
                </div>
            )}
            <Handle type="source" position={sourcePos} />
        </div>
    )
}

// Shared state so hovering an edge or its label highlights the other.
const HoveredEdgeContext = createContext({ id: null, set: () => {} })

const HOVER_COLOR = "#ff6a00"

// Renders `data.value` near the bezier midpoint with a small per-edge offset
// (so parallel edges don't pile up). `data.bg` tints the label by the
// transformation "moment" — source-field outgoing vs. transform outgoing.
function ValueEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd, style }) {
    const [edgePath, midX, midY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
    const idx = data.idx ?? 0
    const dx = targetX - sourceX
    const dy = targetY - sourceY
    const len = Math.hypot(dx, dy) || 1
    const tShift = data.centered ? 0 : (((idx % 5) - 2) / 2) * 0.15
    const perp   = data.centered ? 0 : ((idx % 3) - 1) * 14
    const labelX = midX + dx * tShift + (-dy / len) * perp
    const labelY = midY + dy * tShift + ( dx / len) * perp

    const { id: hoveredId, set } = useContext(HoveredEdgeContext)
    const hovered = hoveredId === id
    // Edges attached to a node being dragged are highlighted by the parent
    // (orange stroke); we mirror that highlight on the label here.
    const highlight = hovered || data.attached
    const onIn = () => set(id)
    const onOut = () => set(null)

    const edgeStyle = hovered ? { ...style, stroke: HOVER_COLOR, strokeWidth: 2 } : style
    const edgeMarker = hovered ? { type: MarkerType.ArrowClosed, color: HOVER_COLOR } : markerEnd

    return (
        <>
            <g onPointerEnter={onIn} onPointerLeave={onOut} style={{ cursor: "grab" }}>
                <BaseEdge id={id} path={edgePath} markerEnd={edgeMarker} style={edgeStyle} />
            </g>
            <EdgeLabelRenderer>
                <div
                    title={data.value}
                    onPointerEnter={onIn}
                    onPointerLeave={onOut}
                    style={{
                        position: "absolute",
                        transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
                        background: data.bg ?? "white",
                        border: `1px solid ${highlight ? HOVER_COLOR : "#bbb"}`,
                        borderRadius: 3,
                        padding: "2px 5px",
                        fontSize: 10,
                        lineHeight: "12px",
                        color: "#444",
                        pointerEvents: "auto",
                        cursor: "default",
                        maxWidth: 150,
                        wordBreak: "break-word",
                        whiteSpace: "pre-line",
                        display: "-webkit-box",
                        WebkitLineClamp: 3,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                        ...(highlight && { zIndex: 1000, boxShadow: "0 4px 14px rgba(0,0,0,0.35)" }),
                    }}
                >{data.value}</div>
            </EdgeLabelRenderer>
        </>
    )
}

// Decorative, non-interactive nodes: a per-column title above each lane and a
// full-height background band behind the "dedup" columns. They live in the flow
// coordinate space so they pan/zoom in step with the real nodes.
function HeaderNode({ data, style }) {
    // A title's first line is the heading; any line(s) after a newline (e.g. the
    // schema:Class under a lane name) render smaller and muted.
    const [main, ...rest] = String(data.title).split("\n")
    return (
        <div style={{ ...style, textAlign: "center", fontSize: 14, fontWeight: 400, color: "#555", lineHeight: 1.3, pointerEvents: "none", ...data.hstyle }}>
            {main}
            {rest.length > 0 && <div style={{ fontSize: 11, color: "#888" }}>{rest.join(" ")}</div>}
        </div>
    )
}
function BandNode({ style }) { return <div style={{ ...style, pointerEvents: "none" }} /> }

const REL_COLOR = "#9333ea"
const nodeTypes = { sideNode: SideNode, headerNode: HeaderNode, bandNode: BandNode }
const edgeTypes = { value: ValueEdge }

function toFlow({ nodes, edges }, columns, colors, centerColumns, direction, colSpacing, siblingGap, nodeWidth, columnTitles, columnBands, nodeY, columnHeaderStyle) {
    const isVertical = direction === "vertical"
    const centered = new Set(centerColumns ?? [])
    const buckets = Object.fromEntries(columns.map((c) => [c, []]))
    for (const n of nodes) (buckets[n.type] ??= []).push(n)

    const maxColSize = Math.max(...columns.map((c) => buckets[c]?.length ?? 0))
    // Logical layout in (col-axis, sibling-axis) coords; swapped at the end for vertical mode.
    const positions = new Map()

    if (nodeY) {
        // Caller supplies the sibling-axis coord per node (e.g. a tree layout);
        // the column still fixes the col-axis coord.
        columns.forEach((col, colIdx) => {
            for (const n of buckets[col] ?? []) positions.set(n.id, { x: colIdx * colSpacing, y: nodeY.get(n.id) ?? 0 })
        })
    } else columns.forEach((col, colIdx) => {
        const x = colIdx * colSpacing
        const colNodes = buckets[col] ?? []
        if (centered.has(col)) {
            // Position each node at the average sibling-axis coord of its incoming neighbours,
            // sorted so we can push later nodes down to avoid overlap.
            const incomingYs = new Map()
            for (const e of edges) {
                if (e.sideInput) continue   // side inputs feed a step without pulling its centering
                const fromPos = positions.get(e.from)
                if (!fromPos) continue
                if (!incomingYs.has(e.to)) incomingYs.set(e.to, [])
                incomingYs.get(e.to).push(fromPos.y)
            }
            const ranked = colNodes.map((n) => {
                const ys = incomingYs.get(n.id) ?? []
                const target = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 0
                return { node: n, target }
            }).sort((a, b) => a.target - b.target)
            let lastY = -Infinity
            for (const { node, target } of ranked) {
                const y = Math.max(target, lastY + siblingGap)
                positions.set(node.id, { x, y })
                lastY = y
            }
        } else {
            const yOffset = ((maxColSize - colNodes.length) / 2) * siblingGap
            colNodes.forEach((n, i) => {
                positions.set(n.id, { x, y: yOffset + i * siblingGap })
            })
        }
    })

    // A side-input source (e.g. the Match step's knowledge graph) is parked one
    // sibling-gap beside the step it feeds — where a sibling of that step would
    // sit — so its edge stays short instead of trailing in from the column edge.
    for (const e of edges) {
        if (!e.sideInput) continue
        const tgt = positions.get(e.to)
        const src = positions.get(e.from)
        if (tgt && src) positions.set(e.from, { x: src.x, y: tgt.y + siblingGap })
    }

    const targetPos = isVertical ? Position.Top : Position.Left
    const sourcePos = isVertical ? Position.Bottom : Position.Right

    const flowNodes = []
    for (const n of nodes) {
        const pos = positions.get(n.id)
        if (!pos) continue
        flowNodes.push({
            id: n.id,
            type: "sideNode",
            position: isVertical ? { x: pos.y, y: pos.x } : pos,
            data: { label: n.label, subtitle: n.subtitle, props: n.props, targetPos, sourcePos },
            style: {
                background: n.color ?? colors[n.type] ?? "#eee",
                border: `1px ${n.dashed ? "dashed" : "solid"} ${n.borderColor ?? "#888"}`,
                borderRadius: 4,
                fontSize: 12,
                padding: 6,
                width: nodeWidth,
            },
        })
    }

    // Column headers + background bands (horizontal layouts only) — decorative
    // nodes spanning the full node range, drawn behind (band) / above (header).
    if (!isVertical && (columnTitles || columnBands)) {
        const ys = [...positions.values()].map((p) => p.y)
        const minY = Math.min(...ys), maxY = Math.max(...ys)
        columns.forEach((col, colIdx) => {
            const x = colIdx * colSpacing
            if (columnBands?.[col]) flowNodes.unshift({
                id: `__band_${col}`, type: "bandNode", position: { x: x - 16, y: minY - 66 },
                draggable: false, selectable: false, zIndex: -1, data: {},
                style: { width: nodeWidth + 32, height: (maxY - minY) + 138, background: columnBands[col], borderRadius: 10 },
            })
            if (columnTitles?.[col]) flowNodes.push({
                id: `__hdr_${col}`, type: "headerNode", position: { x, y: minY - 56 },
                draggable: false, selectable: false, zIndex: 6, data: { title: columnTitles[col], hstyle: columnHeaderStyle?.[col] },
                style: { width: nodeWidth },
            })
        })
    }

    const flowEdges = edges.map((e, i) => {
        const base = { id: `e-${i}`, source: e.from, target: e.to, markerEnd: { type: MarkerType.ArrowClosed } }
        if (e.value !== undefined) { base.type = "value"; base.data = { value: e.value, idx: i, bg: e.valueBg, centered: e.centered } }
        if (e.rel) {
            base.style = { stroke: REL_COLOR, strokeWidth: 1.5 }
            base.markerEnd = { type: MarkerType.ArrowClosed, color: REL_COLOR }
            base.zIndex = 4
        }
        return base
    })

    return { flowNodes, flowEdges }
}

export default function ColumnGraph({ nodes, edges, columns, colors, centerColumns, direction = "horizontal", colSpacing = DEFAULT_COL_SPACING, siblingGap = DEFAULT_SIBLING_GAP, nodeWidth = DEFAULT_NODE_WIDTH, columnTitles, columnBands, nodeY, columnHeaderStyle, onNodeClick }) {
    const { flowNodes, flowEdges } = useMemo(() => toFlow({ nodes, edges }, columns, colors, centerColumns, direction, colSpacing, siblingGap, nodeWidth, columnTitles, columnBands, nodeY, columnHeaderStyle), [nodes, edges, columns, colors, centerColumns, direction, colSpacing, siblingGap, nodeWidth, columnTitles, columnBands, nodeY, columnHeaderStyle])
    const [rfNodes, , onNodesChange] = useNodesState(flowNodes)
    const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState(flowEdges)
    const [draggingId, setDraggingId] = useState(null)
    const [hoveredEdge, setHoveredEdge] = useState(null)
    const hoverCtx = useMemo(() => ({ id: hoveredEdge, set: setHoveredEdge }), [hoveredEdge])
    // Sync edges when value labels change (e.g. selecting a different entity) so
    // the user keeps any node positions they've dragged.
    useEffect(() => { setRfEdges(flowEdges) }, [flowEdges, setRfEdges])

    const styledEdges = useMemo(() => rfEdges.map((e) => {
        const attached = e.source === draggingId || e.target === draggingId
        return attached
            ? { ...e, style: { stroke: "#ff6a00", strokeWidth: 2 }, markerEnd: { type: MarkerType.ArrowClosed, color: "#ff6a00" }, zIndex: 1000, data: { ...e.data, attached: true } }
            : e
    }), [rfEdges, draggingId])

    const onInit = async (instance) => {
        await instance.fitView()
        const { x, zoom } = instance.getViewport()
        const minY = Math.min(...instance.getNodes().map((n) => n.position.y))
        instance.setViewport({ x, y: 20 - minY * zoom, zoom })
    }

    return (
        <HoveredEdgeContext.Provider value={hoverCtx}>
            {/* Differentiate cursors: pointer on draggable nodes, grab on
                edges (matching the canvas pan), so the open hand doesn't
                show indiscriminately on every hover. */}
            <style>{`.react-flow__node{cursor:pointer!important;}.react-flow__edge{cursor:grab!important;}`}</style>
            <ReactFlow
                nodes={rfNodes}
                edges={styledEdges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeDragStart={(_, n) => setDraggingId(n.id)}
                onNodeDragStop={() => setDraggingId(null)}
                onNodeClick={onNodeClick}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onInit={onInit}
            >
                <Background />
                <Controls showInteractive={false} />
            </ReactFlow>
        </HoveredEdgeContext.Provider>
    )
}
