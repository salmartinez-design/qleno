import { useEffect, useRef } from "react";
import { getAuthHeaders } from "@/lib/auth";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export type AddressParts = { street: string; city: string; state: string; zip: string; formatted: string };

// Shared Google Places loader. The codebase re-implements this per page
// (quote-builder, jobs, book, customer-profile); this dedupes the script
// injection so a single <script> serves every consumer. Key comes from the
// runtime config endpoint (Railway env) with the build-time var as fallback.
let mapsLoadPromise: Promise<boolean> | null = null;

const ready = () => !!(window as any).google?.maps?.places?.Autocomplete;

function loadGoogleMaps(): Promise<boolean> {
  if (ready()) return Promise.resolve(true);
  if (mapsLoadPromise) return mapsLoadPromise;
  mapsLoadPromise = (async () => {
    let key = "";
    try {
      const r = await fetch(`${API}/api/config/google-maps-key`, { headers: { ...getAuthHeaders() } });
      if (r.ok) { const b = await r.json().catch(() => ({})); key = String((b as any)?.key ?? ""); }
    } catch { /* fall through to build-time key */ }
    if (!key) key = (import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY ?? "";
    // No key configured — don't cache the failure so a later call (after the
    // env is fixed) can retry instead of being stuck on a poisoned promise.
    if (!key) { mapsLoadPromise = null; return false; }

    // Inject the script once. Another page may have already added it (same id),
    // in which case we just wait for the library to come online below — we do
    // NOT rely on catching its load event, which may have already fired.
    const id = "gmap-places-script";
    if (!document.getElementById(id)) {
      const s = document.createElement("script");
      s.id = id;
      s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places`;
      s.async = true; s.defer = true;
      document.head.appendChild(s);
    }

    // Poll for readiness regardless of who injected the script. ~10s ceiling.
    for (let i = 0; i < 100; i++) {
      if (ready()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    // Timed out — clear the cache so a future attempt can try again.
    mapsLoadPromise = null;
    return false;
  })();
  return mapsLoadPromise;
}

// Attaches Google Places autocomplete to an input while `enabled` is true.
// Calls `onPick` with parsed address parts when the user selects a suggestion.
export function useAddressAutocomplete(
  inputRef: React.RefObject<HTMLInputElement | null>,
  enabled: boolean,
  onPick: (parts: AddressParts) => void,
) {
  const cb = useRef(onPick);
  cb.current = onPick;

  useEffect(() => {
    if (!enabled) return;
    let ac: any = null;
    let listener: any = null;
    let cancelled = false;

    (async () => {
      const ok = await loadGoogleMaps();
      if (!ok || cancelled) return;
      const g = (window as any).google;
      if (!g?.maps?.places?.Autocomplete) return;
      // The input often mounts a render after `enabled` flips true (e.g. the
      // wizard's New Customer form opens, then the address field appears). Wait
      // briefly for the ref instead of bailing — this was the silent failure
      // where autocomplete never attached inside the modal.
      for (let i = 0; i < 40 && !inputRef.current && !cancelled; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (cancelled || !inputRef.current) return;
      ac = new g.maps.places.Autocomplete(inputRef.current, {
        componentRestrictions: { country: "us" },
        fields: ["address_components", "formatted_address"],
        types: ["address"],
      });
      listener = ac.addListener("place_changed", () => {
        const place = ac.getPlace();
        if (!place?.address_components) return;
        const get = (t: string) =>
          place.address_components.find((c: any) => c.types.includes(t))?.long_name ?? "";
        const getShort = (t: string) =>
          place.address_components.find((c: any) => c.types.includes(t))?.short_name ?? "";
        const street = `${get("street_number")} ${get("route")}`.trim();
        const city = get("locality") || get("sublocality") || get("postal_town");
        const state = getShort("administrative_area_level_1");
        const zip = get("postal_code");
        cb.current({ street, city, state, zip, formatted: place.formatted_address ?? "" });
      });
    })();

    return () => { cancelled = true; listener?.remove?.(); };
  }, [enabled, inputRef]);
}
