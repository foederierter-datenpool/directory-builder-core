// Multi-select dropdown: a summary label ("All sources", "2 of 3 types", …) over a
// popover of checkboxes with select-all / unselect-all. Used for the Map source
// filter and the Merge/Directory schema filter.
// options: [{ key, label }] · selected: Set<key> · onChange(Set<key>) · noun: e.g. "source"

import React from "react"
import Dropdown from "./Dropdown.jsx"

const linkBtn = { background: "none", border: "none", color: "#06c", cursor: "pointer", padding: 0, fontSize: 12 }
const item = { display: "flex", alignItems: "center", gap: 6, padding: "2px 0", whiteSpace: "nowrap" }

export default function CheckboxDropdown({ options, selected, onChange, noun }) {
    const all = options.length
    const label = selected.size === all ? `All ${noun}s`
        : selected.size === 0 ? `No ${noun}s`
        : `${selected.size} of ${all} ${noun}s`
    const toggle = (k) => { const n = new Set(selected); n.has(k) ? n.delete(k) : n.add(k); onChange(n) }
    const setAll = (on) => onChange(on ? new Set(options.map((o) => o.key)) : new Set())
    return (
        <Dropdown label={label}>
            <div style={{ display: "flex", gap: 12, paddingBottom: 4, marginBottom: 4, borderBottom: "1px solid #eee" }}>
                <button onClick={() => setAll(true)} style={linkBtn}>Select all</button>
                <button onClick={() => setAll(false)} style={linkBtn}>Unselect all</button>
            </div>
            {options.map((o) => (
                <label key={o.key} style={item}>
                    <input type="checkbox" checked={selected.has(o.key)} onChange={() => toggle(o.key)} /> {o.label}
                </label>
            ))}
        </Dropdown>
    )
}
