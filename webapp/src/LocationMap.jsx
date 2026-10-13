// Public map of resolved PostalAddress entities that carry coordinates.

import { locations, turtleForIri } from "./locationData.js"
import { selectMapLocations } from "./loadLocations.js"
import { highlightTurtle } from "./highlightTurtle.js"
import Modal from "./Modal.jsx"
import L from "leaflet"
import "leaflet/dist/leaflet.css"
import React, { useEffect, useMemo, useRef, useState } from "react"
import "prismjs/themes/prism-okaidia.css"

const markerOptions = {
    radius: 7,
    weight: 2,
    color: "#1d4ed8",
    fillColor: "#3b82f6",
    fillOpacity: 0.8,
}

function tooltipFor(entities) {
    const tooltip = document.createElement("div")
    const list = document.createElement("ul")
    for (const entity of entities) {
        const item = document.createElement("li")
        item.textContent = entity.label
        list.append(item)
    }
    tooltip.append(list)
    return tooltip
}

function AddressModal({ location, onClose, onSelectEntity }) {
    return (
        <Modal title="Address" maxWidth={600} onClose={onClose}>
            <address className="location-address">
                {location.lines.map((line) => <div key={line}>{line}</div>)}
            </address>
            <h4 className="location-heading">At this address</h4>
            {location.entities.length ? (
                <ul className="location-entities">
                    {location.entities.map((entity) => (
                        <li key={entity.iri}>
                            <button type="button" onClick={() => onSelectEntity(entity)}>
                                <span className="location-entity-label">{entity.label}</span>
                                <span className="location-entity-type">{entity.type}</span>
                            </button>
                        </li>
                    ))}
                </ul>
            ) : <p>No linked entities.</p>}
        </Modal>
    )
}

function TurtleModal({ entity, onClose }) {
    const highlighted = highlightTurtle(turtleForIri(entity.iri))
    return (
        <Modal title={entity.label} onClose={onClose}>
            <pre className="language-turtle location-turtle">
                <code className="language-turtle" dangerouslySetInnerHTML={{ __html: highlighted }} />
            </pre>
        </Modal>
    )
}

export default function LocationMap() {
    const container = useRef(null)
    const [selected, setSelected] = useState(null)
    const [selectedEntity, setSelectedEntity] = useState(null)
    const [postalPrefix, setPostalPrefix] = useState("")
    const shown = useMemo(() => selectMapLocations(locations, postalPrefix), [postalPrefix])

    useEffect(() => {
        if (!container.current || !shown.length) return
        const map = L.map(container.current)
        const renderer = L.canvas()
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        }).addTo(map)
        const bounds = []
        for (const location of shown) {
            const point = [location.latitude, location.longitude]
            const marker = L.circleMarker(point, { ...markerOptions, renderer })
            marker.addTo(map)
            marker.bindTooltip(() => tooltipFor(location.entities))
            marker.on("click", () => {
                setSelected(location)
                setSelectedEntity(null)
            })
            bounds.push(point)
        }
        map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 })
        return () => map.remove()
    }, [shown])

    return (
        <div className="location-map-page">
            {locations.length > 0 && <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.75rem", fontSize: 13 }}>
                <label>Postal code prefix:{" "}
                    <input value={postalPrefix} maxLength={5} inputMode="numeric" placeholder="All postal codes"
                        onChange={e => { setPostalPrefix(e.target.value.replace(/\D/g, "")); setSelected(null); setSelectedEntity(null) }} />
                </label>
                <span>{shown.length} shown of {locations.length} geocoded addresses.</span>
            </div>}
            {shown.length > 0
                ? <div ref={container} className="location-map" aria-label={`Map of ${shown.length} geocoded addresses`} />
                : <p>{locations.length === 0 ? "No geocoded addresses are available."
                    : "No addresses match this postal code prefix."}</p>}
            {selected && !selectedEntity && (
                <AddressModal location={selected} onClose={() => setSelected(null)} onSelectEntity={setSelectedEntity} />
            )}
            {selectedEntity && (
                <TurtleModal entity={selectedEntity} onClose={() => setSelectedEntity(null)} />
            )}
        </div>
    )
}
