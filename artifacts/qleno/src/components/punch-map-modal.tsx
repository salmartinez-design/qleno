import { useEffect, useRef, useState } from "react";
import { getAuthHeaders } from "@/lib/auth";

// [punch-map-modal 2026-06-11] Office GPS audit modal for a time-clock punch.
// Interactive Google map with the tech's clock-in/out pin(s) AND the job's
// expected location, so the office sees the punch-vs-job gap at a glance —
// richer than MaidCentral's single-pin popover. Loads the Maps JS SDK lazily.

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const FF = "'Plus Jakarta Sans', sans-serif";

let mapsPromise: Promise<any> | null = null;
async function loadMaps(): Promise<any> {
  const w = window as any;
  if (w.google?.maps) return w.google.maps;
  if (mapsPromise) return mapsPromise;
  mapsPromise = (async () => {
    let key = "";
    try {
      const r = await fetch(`${API}/api/config/google-maps-key`, { headers: getAuthHeaders() });
      if (r.ok) key = (await r.json())?.key ?? "";
    } catch { /* fall through to build-time key */ }
    if (!key) key = (import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY ?? "";
    if (!key) throw new Error("no maps key");
    await new Promise<void>((resolve, reject) => {
      const existing = document.getElementById("qleno-gmaps-js");
      if (existing) { existing.addEventListener("load", () => resolve()); existing.addEventListener("error", () => reject()); return; }
      const s = document.createElement("script");
      s.id = "qleno-gmaps-js";
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly`;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("maps script failed"));
      document.head.appendChild(s);
    });
    return (window as any).google.maps;
  })();
  return mapsPromise;
}

export type PunchMapData = {
  techName: string;
  clientName: string;
  inAt: string | null;       // display time, e.g. "9:11 AM"
  outAt: string | null;
  inLat: number | null; inLng: number | null; inFt: number | null; inOutside: boolean | null;
  outLat: number | null; outLng: number | null; outFt: number | null; outOutside: boolean | null;
  jobLat: number | null; jobLng: number | null;
};

export function PunchMapModal({ data, onClose }: { data: PunchMapData; onClose: () => void }) {
  const mapRef = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const hasIn = data.inLat != null && data.inLng != null;
  const hasOut = data.outLat != null && data.outLng != null;
  const hasJob = data.jobLat != null && data.jobLng != null;

  useEffect(() => {
    let cancelled = false;
    loadMaps().then((maps) => {
      if (cancelled || !mapRef.current) return;
      const map = new maps.Map(mapRef.current, {
        zoom: 15, mapTypeControl: false, streetViewControl: false, fullscreenControl: true,
        // Cap zoom so near-identical punches (often a few feet apart) don't slam
        // to max zoom and render as a gray no-detail tile. Drop the rotate/tilt
        // controls that clutter the view at high zoom.
        maxZoom: 18, rotateControl: false, clickableIcons: false, tilt: 0,
        center: { lat: data.inLat ?? data.jobLat ?? 0, lng: data.inLng ?? data.jobLng ?? 0 },
      });
      const bounds = new maps.LatLngBounds();
      const pin = (lat: number, lng: number, color: string, label: string, title: string) => {
        const p = new maps.LatLng(lat, lng);
        new maps.Marker({
          position: p, map, title,
          label: { text: label, color: "#fff", fontSize: "11px", fontWeight: "700" },
          icon: {
            path: maps.SymbolPath.CIRCLE, scale: 12, fillColor: color, fillOpacity: 1,
            strokeColor: "#fff", strokeWeight: 2,
          },
        });
        bounds.extend(p);
      };
      if (hasJob) pin(data.jobLat!, data.jobLng!, "#2F3646", "J", `${data.clientName} (job)`);
      if (hasIn) pin(data.inLat!, data.inLng!, "#0A7C66", "In", `Clock-in${data.inAt ? ` · ${data.inAt}` : ""}`);
      if (hasOut) pin(data.outLat!, data.outLng!, "#EA580C", "Out", `Clock-out${data.outAt ? ` · ${data.outAt}` : ""}`);
      if (hasJob && hasIn) {
        new maps.Polyline({
          map, geodesic: true,
          path: [{ lat: data.jobLat!, lng: data.jobLng! }, { lat: data.inLat!, lng: data.inLng! }],
          strokeColor: data.inOutside ? "#B3261E" : "#0A7C66", strokeOpacity: 0.7, strokeWeight: 2,
        });
      }
      if (!bounds.isEmpty()) {
        map.fitBounds(bounds, 64);
        if ((hasIn ? 1 : 0) + (hasOut ? 1 : 0) + (hasJob ? 1 : 0) === 1) map.setZoom(16);
      }
    }).catch(() => { if (!cancelled) setErr("Map unavailable — open the coordinates in Google Maps below."); });
    return () => { cancelled = true; };
  }, []);

  const row = (label: string, value: string, color?: string) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12.5, padding: "3px 0" }}>
      <span style={{ color: "#6B6860", fontWeight: 600 }}>{label}</span>
      <span style={{ color: color || "#1A1917", fontWeight: 700, textAlign: "right" }}>{value}</span>
    </div>
  );
  const coordStr = (lat: number | null, lng: number | null) => (lat != null && lng != null ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : "—");

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(10,14,26,0.55)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, fontFamily: FF }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 14, width: "min(560px, 100%)", maxHeight: "90vh", overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 12px 48px rgba(0,0,0,0.25)" }}>
        <div style={{ padding: "13px 16px", borderBottom: "1px solid #E5E2DC", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ minWidth: 0 }}>
            <p style={{ fontSize: 14, fontWeight: 800, color: "#1A1917", margin: 0 }}>{data.techName}</p>
            <p style={{ fontSize: 11.5, color: "#9E9B94", margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{data.clientName} · GPS punch location</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ width: 30, height: 30, borderRadius: 8, border: "1px solid #E5E2DC", background: "#fff", color: "#1A1917", fontSize: 18, lineHeight: 1, cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}>×</button>
        </div>

        <div style={{ position: "relative", height: 300, background: "#EEF0F2" }}>
          <div ref={mapRef} style={{ width: "100%", height: "100%" }} />
          {err && <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center", fontSize: 13, color: "#6B6860" }}>{err}</div>}
        </div>

        <div style={{ padding: "12px 16px", overflowY: "auto" }}>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 8 }}>
            <Legend color="#0A7C66" label="Clock-in" show={hasIn} />
            <Legend color="#EA580C" label="Clock-out" show={hasOut} />
            <Legend color="#2F3646" label="Job location" show={hasJob} />
          </div>
          {hasIn && (
            <div style={{ borderTop: "1px solid #F0EEE9", paddingTop: 6 }}>
              {row("Clock-in", data.inAt || "—")}
              {row("Coordinates", coordStr(data.inLat, data.inLng))}
              {row("Distance from job", data.inFt != null ? `${data.inFt} ft${data.inOutside ? " · outside zone" : " · within zone"}` : "job not geocoded", data.inFt == null ? "#9E9B94" : data.inOutside ? "#B3261E" : "#0A7C66")}
            </div>
          )}
          {hasOut && (
            <div style={{ borderTop: "1px solid #F0EEE9", paddingTop: 6, marginTop: 6 }}>
              {row("Clock-out", data.outAt || "—")}
              {row("Coordinates", coordStr(data.outLat, data.outLng))}
              {row("Distance from job", data.outFt != null ? `${data.outFt} ft${data.outOutside ? " · outside zone" : " · within zone"}` : "job not geocoded", data.outFt == null ? "#9E9B94" : data.outOutside ? "#B3261E" : "#0A7C66")}
            </div>
          )}
          {!hasJob && (
            <p style={{ fontSize: 11.5, color: "#9E9B94", margin: "8px 0 0" }}>This job has no saved coordinates, so distance can't be measured — geocode the client's address to enable it.</p>
          )}
          {hasIn && (
            <a href={`https://www.google.com/maps?q=${data.inLat},${data.inLng}`} target="_blank" rel="noopener noreferrer"
               style={{ display: "inline-block", marginTop: 12, fontSize: 12.5, fontWeight: 700, color: "#0A7C66", textDecoration: "underline" }}>
              Open clock-in pin in Google Maps ▸
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function Legend({ color, label, show }: { color: string; label: string; show: boolean }) {
  if (!show) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 700, color: "#6B6860" }}>
      <span style={{ width: 11, height: 11, borderRadius: "50%", background: color, border: "2px solid #fff", boxShadow: "0 0 0 1px #E5E2DC" }} />
      {label}
    </span>
  );
}
