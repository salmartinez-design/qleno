import { useEffect, useRef } from "react";
import { getAuthHeaders } from "@/lib/auth";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export type AddressParts = { street: string; city: string; state: string; zip: string; formatted: string };

// Shared Google Places loader. The codebase re-implements this per page
// (quote-builder, jobs, book, customer-profile); this dedupes the script
// injection so a single <script> serves every consumer. Key comes from the
// runtime config endpoint (Railway env) with the build-time var as fallback.
let mapsLoadPromise: Promise<boolean> | null = null;

function loadGoogleMaps(): Promise<boolean> {
  if ((window as any).google?.maps?.places) return Promise.resolve(true);
  if (mapsLoadPromise) return mapsLoadPromise;
  mapsLoadPromise = (async () => {
    let key = "";
    try {
      const r = await fetch(`${API}/api/config/google-maps-key`, { headers: { ...getAuthHeaders() } });
      if (r.ok) { const b = await r.json().catch(() => ({})); key = String((b as any)?.key ?? ""); }
    } catch { /* fall through to build-time key */ }
    if (!key) key = (import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY ?? "";
    if (!key) return false;
    if ((window as any).google?.maps?.places) return true;
    return await new Promise<boolean>((resolve) => {
      const id = "gmap-places-script";
      const existing = document.getElementById(id) as HTMLScriptElement | null;
      if (existing) {
        existing.addEventListener("load", () => resolve(true));
        if ((window as any).google?.maps?.places) resolve(true);
        return;
      }
      const s = document.createElement("script");
      s.id = id;
      s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places`;
      s.async = true; s.defer = true;
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
  })();
  return mapsLoadPromise;
}

// Attaches Google Places autocomplete to an input while `enabled` is true.
// Calls `onPick` with parsed address parts when the user selects a suggestion.
export function useAddressAutocomplete(
  inputRef: React.RefObject<HTMLInputElement>,
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

    loadGoogleMaps().then(ok => {
      if (!ok || cancelled || !inputRef.current) return;
      const g = (window as any).google;
      if (!g?.maps?.places?.Autocomplete) return;
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
    });

    return () => { cancelled = true; listener?.remove?.(); };
  }, [enabled, inputRef]);
}
