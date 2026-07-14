// Multi-select dropdown: a summary label ("All sources", "2 of 3 types", …) over a
// popover of checkboxes with select-all / clear-all. Used for the Map source
// filter and the Merge/Directory schema + source filters.
// options: [{ key, label }] · selected: Set<key> · onChange(Set<key>) · noun: e.g. "source"
// Optional match mode (source filter only): matchMode "any"|"all" + onMatchMode(mode)
// adds an any/all toggle with a "?" explainer next to select/clear. any = entities
// at least one selected option fed into; all = only their overlap.

import React, { useState } from "react"
import Dropdown from "./Dropdown.jsx"
import { HELP_ICON } from "./HelpTip.jsx"

const linkBtn = { background: "none", border: "none", color: "#06c", cursor: "pointer", padding: 0, fontSize: 12 }
const item = { display: "flex", alignItems: "center", gap: 6, padding: "2px 0", whiteSpace: "nowrap" }
const segWrap = { display: "inline-flex", border: "1px solid #ccc", borderRadius: 4, overflow: "hidden" }
const seg = (active) => ({ padding: "1px 8px", fontSize: 11, lineHeight: 1.6, border: "none", cursor: "pointer", background: active ? "#06c" : "white", color: active ? "white" : "#555" })

export default function CheckboxDropdown({ options, selected, onChange, noun, matchMode, onMatchMode }) {
    const [helpOpen, setHelpOpen] = useState(false)
    const all = options.length
    const label = selected.size === all ? `All ${noun}s`
        : selected.size === 0 ? `No ${noun}s`
        : `${selected.size} of ${all} ${noun}s`
    const toggle = (k) => { const n = new Set(selected); n.has(k) ? n.delete(k) : n.add(k); onChange(n) }
    const setAll = (on) => onChange(on ? new Set(options.map((o) => o.key)) : new Set())
    const showMatch = matchMode != null && onMatchMode

    return (
        <Dropdown label={label}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, paddingBottom: 4, marginBottom: 4, borderBottom: "1px solid #eee" }}>
                <div style={{ display: "flex", gap: 12 }}>
                    <button onClick={() => setAll(true)} style={linkBtn}>Select all</button>
                    <button onClick={() => setAll(false)} style={linkBtn}>Clear all</button>
                </div>
                {showMatch && (
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={segWrap} role="group" aria-label={`Match ${noun}s`}>
                            <button style={seg(matchMode === "any")} onClick={() => onMatchMode("any")}>any</button>
                            <button style={seg(matchMode === "all")} onClick={() => onMatchMode("all")}>all</button>
                        </span>
                        <button style={HELP_ICON} onClick={() => setHelpOpen((o) => !o)}
                            aria-label="What do any and all mean?" title="What do any / all mean?">?</button>
                    </div>
                )}
            </div>
            {showMatch && helpOpen && (
                <div style={{ fontSize: 12, color: "#555", lineHeight: 1.5, background: "#f7f7f7", border: "1px solid #eee", borderRadius: 4, padding: "6px 8px", marginBottom: 6, whiteSpace: "normal" }}>
                    Match entities by the {noun}s that fed into them.
                    {" "}<b>any (or)</b>: at least one selected {noun}.
                    {" "}<b>all (and)</b>: every selected {noun} — their overlap.
                </div>
            )}
            {options.map((o) => (
                <label key={o.key} style={item}>
                    <input type="checkbox" checked={selected.has(o.key)} onChange={() => toggle(o.key)} /> {o.label}
                </label>
            ))}
        </Dropdown>
    )
}
