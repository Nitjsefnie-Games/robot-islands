// Slice 4 REMOTE boot gate. LOCAL remains the default; REMOTE is opt-in via
// `localStorage.setItem('ri_server', '1')` or the URL query `?server=1`.

/** Returns true when the client should boot in server-authoritative REMOTE mode. */
export function isRemoteBootEnabled(): boolean {
  try {
    return (
      globalThis.localStorage?.getItem('ri_server') === '1' ||
      new URLSearchParams(globalThis.location.search).get('server') === '1'
    );
  } catch {
    // localStorage can throw in sandboxed / private contexts; fall back to URL.
    return new URLSearchParams(globalThis.location.search).get('server') === '1';
  }
}
