// Slice 4 REMOTE boot gate. REMOTE is the default; LOCAL is the opt-out debug
// fallback. Opt-out via URL query `?server=0` or by setting
// `localStorage.setItem('ri_server', '0')`.

const LATLON_KEY = 'ri_player_latlon';

/** Returns true when the client should boot in server-authoritative REMOTE mode. */
export function isRemoteBootEnabled(): boolean {
  try {
    const explicitLocal =
      globalThis.localStorage?.getItem('ri_server') === '0' ||
      new URLSearchParams(globalThis.location.search).get('server') === '0';
    if (explicitLocal) return false;
    return true;
  } catch {
    // localStorage can throw in sandboxed / private contexts; fall back to URL.
    return new URLSearchParams(globalThis.location.search).get('server') !== '0';
  }
}

/** Load the client-local player lat/lon preference used in REMOTE mode.
 *  The server snapshot does not own the player's real-world location, so the
 *  client stashes it in localStorage and restores it after each snapshot.
 *  Returns null in LOCAL mode or when no value is stored. */
export function loadStoredPlayerLatLon(): { lat: number; lon: number } | null {
  if (!isRemoteBootEnabled()) return null;
  try {
    const raw = globalThis.localStorage?.getItem(LATLON_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed != null &&
      typeof parsed === 'object' &&
      'lat' in parsed &&
      'lon' in parsed &&
      typeof parsed.lat === 'number' &&
      typeof parsed.lon === 'number'
    ) {
      return { lat: parsed.lat, lon: parsed.lon };
    }
  } catch {
    // localStorage can throw in sandboxed / private contexts; treat as missing.
  }
  return null;
}

/** Store the client-local player lat/lon preference used in REMOTE mode.
 *  No-op in LOCAL mode — LOCAL persists lat/lon in the IDB save instead. */
export function storePlayerLatLon(lat: number, lon: number): void {
  if (!isRemoteBootEnabled()) return;
  try {
    globalThis.localStorage?.setItem(LATLON_KEY, JSON.stringify({ lat, lon }));
  } catch {
    // localStorage can throw in sandboxed / private contexts; ignore silently.
  }
}
