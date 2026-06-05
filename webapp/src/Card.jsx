// Presentational building blocks: <Card> (titled box) and <KeyValueTable>.
// Reads:  props (title, children, rows)
// Does:   renders DOM; used by EntityCard and Sources

import React from "react"

export default function Card({ title, tag, children }) {
    return (
        <div className="entity-card">
            <div className="entity-card-header">
                <code>{title}</code>
                {tag && <span style={{ marginLeft: "0.6rem", fontSize: 11, color: "#888", fontFamily: "monospace" }}>{tag}</span>}
            </div>
            {children}
        </div>
    )
}

export function KeyValueTable({ rows }) {
    return (
        <table>
            <tbody>
                {rows.map((r, i) => (
                    <tr key={r.key ?? i}>
                        <td>{r.label}</td>
                        <td>{r.value}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    )
}
