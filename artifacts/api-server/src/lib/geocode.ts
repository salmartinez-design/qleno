export async function geocodeAddress(address: string): Promise<{ lat: number; lng: number } | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.warn("[Geocode] GOOGLE_MAPS_API_KEY not set — geocoding disabled");
    return null;
  }
  try {
    const encoded = encodeURIComponent(address);
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encoded}&key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn("[Geocode] HTTP error", res.status);
      return null;
    }
    const data = await res.json();
    if (data.status !== "OK" || !data.results?.length) {
      console.warn("[Geocode] No results for address:", address, "status:", data.status);
      return null;
    }
    const { lat, lng } = data.results[0].geometry.location;
    return { lat, lng };
  } catch (err) {
    console.error("[Geocode] Error:", err);
    return null;
  }
}
