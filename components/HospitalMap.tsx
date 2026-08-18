"use client";

import { useEffect, useRef, useState } from "react";
import type { HospitalMatch } from "@/lib/hospitals/matchHospitals";
import { rupees } from "@/lib/format";

/**
 * Map of the matched hospitals, drawn with Leaflet over OpenStreetMap tiles.
 * No API key and no billing account — the tiles are free and the library is
 * open source.
 *
 * Markers carry what the patient pays, not what the hospital charges. Two
 * hospitals a kilometre apart can differ by fifty thousand rupees once the
 * room-rent cap is applied, and that is the number worth putting on a map.
 *
 * Leaflet is loaded from a CDN at runtime rather than bundled: it touches
 * `window` on import and would break server rendering.
 */

/* Only the slice of the Leaflet API this component uses. */
interface LatLng { lat: number; lng: number }

interface LeafletMap {
  setView(center: [number, number], zoom: number): LeafletMap;
  fitBounds(bounds: [number, number][], opts?: Record<string, unknown>): void;
  remove(): void;
  invalidateSize(): void;
}

interface LeafletLayer {
  addTo(map: LeafletMap): LeafletLayer;
  bindPopup(content: string): LeafletLayer;
  remove(): void;
}

interface Leaflet {
  map(el: HTMLElement, opts?: Record<string, unknown>): LeafletMap;
  tileLayer(url: string, opts?: Record<string, unknown>): LeafletLayer;
  circleMarker(latlng: [number, number], opts?: Record<string, unknown>): LeafletLayer;
  marker(latlng: [number, number], opts?: Record<string, unknown>): LeafletLayer;
  divIcon(opts: Record<string, unknown>): unknown;
}

declare global {
  interface Window {
    L?: Leaflet;
  }
}

/**
 * Marker labels have to survive being read at city zoom, next to a dozen
 * others. Full rupee figures are too wide, so amounts are abbreviated here —
 * the popup carries the exact number.
 *
 * Fully covered admissions get no label at all — see the marker below.
 */
function pinLabel(amount: number): string {
  if (amount < 1000) return `₹${amount}`;
  if (amount < 100000) return `₹${Math.round(amount / 1000)}k`;

  const lakhs = amount / 100000;
  return `₹${lakhs < 10 ? lakhs.toFixed(1) : Math.round(lakhs)}L`;
}

const DELHI: [number, number] = [28.6139, 77.209];

const LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
const LEAFLET_JS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";

/**
 * Carto's Positron and Dark Matter styles, free and key-free like the default
 * OSM tiles but drawn in greys rather than the standard green-and-orange.
 * Greyscale base tiles let the navy markers be the only saturated thing on
 * the map — the same rule the rest of the interface follows.
 */
const TILES = {
  light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
  dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
} as const;

const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

function currentTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** Loads Leaflet once, however many components ask for it. */
let loader: Promise<void> | null = null;

function loadLeaflet(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.L) return Promise.resolve();
  if (loader) return loader;

  loader = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = LEAFLET_CSS;
      document.head.appendChild(css);
    }

    const script = document.createElement("script");
    script.src = LEAFLET_JS;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Leaflet failed to load"));
    document.head.appendChild(script);
  });

  return loader;
}

export interface HospitalMapProps {
  matches: HospitalMatch[];
  origin: LatLng | null;
  onSelect?: (hospitalId: string) => void;
}

export default function HospitalMap({ matches, origin, onSelect }: HospitalMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const layersRef = useRef<LeafletLayer[]>([]);

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const tileRef = useRef<LeafletLayer | null>(null);

  // The theme toggle writes to the document, so watch that rather than
  // threading a prop through every component between here and the top bar.
  useEffect(() => {
    setTheme(currentTheme());

    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => observer.disconnect();
  }, []);

  const plotted = matches.filter(
    (m) =>
      m.hospital.location.lat !== undefined && m.hospital.location.lng !== undefined
  );

  /* --- create the map once ---------------------------------------------- */

  useEffect(() => {
    let cancelled = false;

    loadLeaflet()
      .then(() => {
        if (cancelled || !container.current || !window.L) return;
        if (mapRef.current) return;

        const map = window.L.map(container.current, {
          scrollWheelZoom: false,
        }).setView(DELHI, 11);

        tileRef.current = window.L.tileLayer(TILES[currentTheme()], {
          attribution: TILE_ATTRIBUTION,
          maxZoom: 20,
        }).addTo(map);

        mapRef.current = map;
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  /* --- follow the app's theme -------------------------------------------- */

  useEffect(() => {
    const L = window.L;
    const map = mapRef.current;
    if (status !== "ready" || !L || !map) return;

    tileRef.current?.remove();
    tileRef.current = L.tileLayer(TILES[theme], {
      attribution: TILE_ATTRIBUTION,
      maxZoom: 20,
    }).addTo(map);
  }, [theme, status]);

  /* --- redraw markers whenever the results change ------------------------ */

  useEffect(() => {
    const L = window.L;
    const map = mapRef.current;
    if (status !== "ready" || !L || !map) return;

    layersRef.current.forEach((layer) => layer.remove());
    layersRef.current = [];

    const points: [number, number][] = [];

    if (origin) {
      const here: [number, number] = [origin.lat, origin.lng];
      const marker = L.circleMarker(here, {
        radius: 8,
        color: "#FFFFFF",
        weight: 2,
        fillColor: "#0B2350",
        fillOpacity: 1,
      })
        .addTo(map)
        .bindPopup("You are here");

      layersRef.current.push(marker);
      points.push(here);
    }

    plotted.forEach((match) => {
      const point: [number, number] = [
        match.hospital.location.lat as number,
        match.hospital.location.lng as number,
      ];

      // In-network markers are solid, out-of-network hollow. Same hue,
      // different weight — the palette rule holds on the map too.
      // Nothing to pay means nothing to read: a filled dot rather than a
      // number. It shrinks the marker, stops "₹0" repeating across the map,
      // and lets the eye find the admissions that actually cost something.
      const free = match.bestCase === 0;

      const icon = free
        ? L.divIcon({
            className: "",
            html: `<div class="pin-dot ${match.inNetwork ? "pin-in" : "pin-out"}"></div>`,
            iconSize: [16, 16],
            iconAnchor: [8, 8],
          })
        : L.divIcon({
            className: "",
            html: `<div class="pin ${match.inNetwork ? "pin-in" : "pin-out"}">${pinLabel(match.bestCase)}</div>`,
            iconSize: [58, 22],
            iconAnchor: [29, 11],
          });

      const marker = L.marker(point, { icon })
        .addTo(map)
        .bindPopup(
          `<div class="pin-popup">
             <strong>${match.hospital.name}</strong>
             <span>${match.inNetwork ? "Cashless available" : "Outside your network"}</span>
             <span>Bill about ${rupees(match.estimatedBill)}</span>
             <strong>You pay from ${rupees(match.bestCase)}</strong>
             ${match.distanceKm !== null ? `<span>${match.distanceKm.toFixed(1)} km away</span>` : ""}
           </div>`
        );

      layersRef.current.push(marker);
      points.push(point);

      if (onSelect) {
        (marker as unknown as { on(e: string, h: () => void): void }).on("click", () =>
          onSelect(match.hospital.id)
        );
      }
    });

    if (points.length === 1) {
      map.setView(points[0], 14);
    } else if (points.length > 1) {
      map.fitBounds(points, { padding: [40, 40], maxZoom: 15 });
    }

    // The container is sized by CSS after mount; without this the tiles can
    // render into a stale box and leave grey gaps.
    map.invalidateSize();
  }, [status, plotted, origin, onSelect]);

  if (status === "error") {
    return (
      <div className="map-fallback">
        <p className="meta">
          The map could not load. The hospital list below works without it.
        </p>
      </div>
    );
  }

  const coarse = plotted.filter(
    (m) =>
      m.hospital.location.geocode_precision === "area_only" ||
      m.hospital.location.geocode_precision === "locality"
  ).length;

  return (
    <div className="map-wrap">
      <div ref={container} className="map" />

      {status === "ready" && (
        <div className="map-legend">
          <span className="legend-key">Dot</span> nothing to pay
          <span className="legend-sep" />
          <span className="legend-key">Amount</span> your share
          <span className="legend-sep" />
          <span className="legend-key">Outlined</span> outside your network

          {plotted.length < matches.length && (
            <span className="legend-note">
              {matches.length - plotted.length} not mapped
            </span>
          )}

          {coarse > 0 && plotted.length === matches.length && (
            <span
              className="legend-note"
              title={`${coarse} of ${plotted.length} markers are placed at the centre of the locality because the exact address could not be resolved.`}
            >
              {coarse} approximate
            </span>
          )}
        </div>
      )}

    </div>
  );
}