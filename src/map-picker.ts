// Map picker — modal that shows an equirectangular world map and lets the
// player click to set their lat/lon.  Vanilla DOM (matches hud.ts / ui.ts
// patterns); no framework dependency.
//
// Wire-up to the bootstrap and Settings panels lands in a follow-up commit.
// This module ships in isolation for review.

// ---------------------------------------------------------------------------
// SVG asset
// ---------------------------------------------------------------------------

/** Natural Earth Public Domain Map Dataset at 1:110m resolution — inlined as a
 *  single `<path d="...">` element.  The string is inserted into the SVG at
 *  modal-creation time.
 *
 *  PLACEHOLDER: no pre-pruned Natural Earth path was available offline during
 *  implementation.  The current value draws a 10° graticule grid so the picker
 *  still functions for lat/lon selection.  Replace with a real land-outline
 *  path (≈30 KB after `svgo --precision 1`) in a follow-up commit. */
const WORLD_SVG_PATH =
  'M0,0'; // placeholder — graticule is drawn with <line> elements instead

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

export interface MapPickerOptions {
  /** Existing location to highlight on open. Null on first session. */
  current?: { lat: number; lon: number } | null;
  /** Player picked. Modal closes immediately on this fire. */
  onPick: (lat: number, lon: number) => void;
  /** Player closed without picking (only fired from "Change location"
   *  — first-session modal has no escape hatch). */
  onCancel?: () => void;
}

/** Convert a click in SVG-pixel space to lat/lon using the equirectangular
 *  projection the modal's 360×180 viewBox employs. */
export function clickToLatLon(
  xPx: number, yPx: number,
  rectWidth: number, rectHeight: number,
): { lat: number; lon: number } {
  const lon = (xPx / rectWidth) * 360 - 180;
  const lat = 90 - (yPx / rectHeight) * 180;
  const clampedLat = Math.max(-90, Math.min(90, lat));
  const clampedLon = Math.max(-180, Math.min(180, lon));
  return { lat: clampedLat, lon: clampedLon };
}

/** Bootstrap predicate: show the picker on first session when the player
 *  has not yet chosen a location. */
export function shouldShowPicker(world: { playerLat: number | null; playerLon: number | null }): boolean {
  return world.playerLat == null || world.playerLon == null;
}

export function showMapPicker(opts: MapPickerOptions): void {
  ensureStylesOnce();

  const modal = buildModal(opts);
  document.body.appendChild(modal);

  // If a current location is provided, seed the pin immediately.
  let pendingLat: number | null = null;
  let pendingLon: number | null = null;

  const svg = modal.querySelector('.map-picker-svg') as SVGSVGElement;
  const pin = modal.querySelector('.map-picker-pin') as SVGCircleElement;
  const readout = modal.querySelector('.map-picker-readout') as HTMLParagraphElement;
  const confirmBtn = modal.querySelector('.map-picker-confirm') as HTMLButtonElement;
  const cancelBtn = modal.querySelector('.map-picker-cancel') as HTMLButtonElement | null;

  function updatePin(lat: number, lon: number): void {
    pendingLat = lat;
    pendingLon = lon;

    const rect = svg.getBoundingClientRect();
    const cx = ((lon + 180) / 360) * rect.width;
    const cy = ((90 - lat) / 180) * rect.height;

    pin.setAttribute('cx', cx.toString());
    pin.setAttribute('cy', cy.toString());
    pin.removeAttribute('hidden');

    readout.textContent = formatLatLon(lat, lon);
    confirmBtn.disabled = false;
  }

  if (opts.current != null) {
    updatePin(opts.current.lat, opts.current.lon);
  }

  svg.addEventListener('click', (e) => {
    const rect = svg.getBoundingClientRect();
    const xPx = e.clientX - rect.left;
    const yPx = e.clientY - rect.top;

    const { lat, lon } = clickToLatLon(xPx, yPx, rect.width, rect.height);
    updatePin(lat, lon);
  });

  confirmBtn.addEventListener('click', () => {
    if (pendingLat != null && pendingLon != null) {
      modal.remove();
      opts.onPick(pendingLat, pendingLon);
    }
  });

  if (cancelBtn != null && opts.onCancel != null) {
    cancelBtn.addEventListener('click', () => {
      modal.remove();
      opts.onCancel!();
    });
  }

  // Esc closes only when an onCancel handler is provided (first-session has
  // no escape hatch).
  function onKeydown(e: KeyboardEvent): void {
    if (e.code === 'Escape' && opts.onCancel != null) {
      modal.remove();
      opts.onCancel();
      document.removeEventListener('keydown', onKeydown);
    }
  }
  document.addEventListener('keydown', onKeydown);
}

// ---------------------------------------------------------------------------
// DOM builder
// ---------------------------------------------------------------------------

function buildModal(opts: MapPickerOptions): HTMLElement {
  const modal = document.createElement('div');
  modal.className = 'map-picker-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Choose your location');

  const inner = document.createElement('div');
  inner.className = 'map-picker-inner';

  // Build the SVG markup.  When WORLD_SVG_PATH is a real land outline the
  // <path> renders the continents; with the placeholder we render a graticule.
  const landPath = WORLD_SVG_PATH.length > 1
    ? `<path d="${WORLD_SVG_PATH}" fill="var(--land-tan, #3A3833)" />`
    : '';

  const graticule = WORLD_SVG_PATH.length <= 1
    ? buildGraticuleLines()
    : '';

  const placeholderLabel = WORLD_SVG_PATH.length <= 1
    ? '<text x="180" y="90" text-anchor="middle" fill="var(--ri-fg-3, #8F8D82)" font-size="8" font-family="var(--ri-font-mono, monospace)">world map placeholder — replace with Natural Earth dataset in follow-up</text>'
    : '';

  inner.innerHTML = `
    <h2>Where do you live?</h2>
    <p>Click your location on the map. Real sunrise / sunset will
       follow real time at that location. High latitudes have strong
       seasonal solar — alternative power recommended.</p>
    <svg class="map-picker-svg" viewBox="0 0 360 180"
         xmlns="http://www.w3.org/2000/svg">
      <rect width="360" height="180" fill="var(--ocean-blue, #1a2e44)" />
      ${landPath}
      ${graticule}
      ${placeholderLabel}
      <circle class="map-picker-pin" r="2" fill="var(--ri-accent, #7dd3e8)" hidden />
    </svg>
    <p class="map-picker-readout"></p>
    <div class="map-picker-actions">
      <button class="map-picker-confirm ri-btn ri-btn--primary" disabled>Confirm</button>
      ${opts.onCancel ? '<button class="map-picker-cancel ri-btn">Cancel</button>' : ''}
    </div>
  `;
  modal.appendChild(inner);
  return modal;
}

/** 10° lat/lon graticule lines for the placeholder grid. */
function buildGraticuleLines(): string {
  let lines = '';
  for (let lon = -180; lon <= 180; lon += 10) {
    const x = lon + 180;
    lines += `<line x1="${x}" y1="0" x2="${x}" y2="180" stroke="var(--ri-fg-4, #4a5365)" stroke-width="0.3" opacity="0.5" />`;
  }
  for (let lat = -90; lat <= 90; lat += 10) {
    const y = 90 - lat;
    lines += `<line x1="0" y1="${y}" x2="360" y2="${y}" stroke="var(--ri-fg-4, #4a5365)" stroke-width="0.3" opacity="0.5" />`;
  }
  // Equator and prime meridian slightly heavier
  lines += `<line x1="180" y1="0" x2="180" y2="180" stroke="var(--ri-fg-4, #4a5365)" stroke-width="0.5" opacity="0.7" />`;
  lines += `<line x1="0" y1="90" x2="360" y2="90" stroke="var(--ri-fg-4, #4a5365)" stroke-width="0.5" opacity="0.7" />`;
  return lines;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatLatLon(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `Lat: ${Math.abs(lat).toFixed(1)}°${ns}, Lon: ${Math.abs(lon).toFixed(1)}°${ew}`;
}

// ---------------------------------------------------------------------------
// Styles — injected once on first call
// ---------------------------------------------------------------------------

let _stylesInstalled = false;

function ensureStylesOnce(): void {
  if (_stylesInstalled) return;
  _stylesInstalled = true;

  const style = document.createElement('style');
  style.textContent = `
    .map-picker-modal {
      position: fixed;
      inset: 0;
      z-index: 100;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--ri-scrim, rgba(7, 9, 13, 0.85));
      backdrop-filter: blur(3px);
      animation: ri-fade-in 140ms ease-out;
    }
    .map-picker-inner {
      width: min(960px, 92vw);
      max-height: 90vh;
      background: var(--ri-panel-solid, #11151c);
      border: 1px solid var(--ri-border-strong, #3a4452);
      border-radius: 10px;
      box-shadow: var(--ri-shadow-pop, 0 16px 48px rgba(0,0,0,0.6));
      display: flex;
      flex-direction: column;
      padding: 18px 22px 22px;
      overflow: hidden;
      animation: ri-pop-in 180ms cubic-bezier(.2,.7,.2,1);
    }
    .map-picker-inner h2 {
      margin: 0 0 6px;
      color: var(--ri-accent, #7dd3e8);
      font: 600 16px/1.2 var(--ri-font-sans, system-ui, sans-serif);
      letter-spacing: 0.06em;
    }
    .map-picker-inner > p {
      margin: 0 0 14px;
      color: var(--ri-fg-2, #98a2b3);
      font: 12px/1.5 var(--ri-font-sans, system-ui, sans-serif);
      max-width: 720px;
    }
    .map-picker-svg {
      width: 100%;
      height: auto;
      max-height: 52vh;
      aspect-ratio: 360 / 180;
      border: 1px solid var(--ri-border, #2a3240);
      border-radius: 6px;
      cursor: crosshair;
      background: var(--ocean-blue, #1a2e44);
    }
    .map-picker-readout {
      margin: 10px 0 0;
      min-height: 1.4em;
      color: var(--ri-fg-1, #e6ecf5);
      font: 13px/1.4 var(--ri-font-mono, ui-monospace, monospace);
      text-align: center;
    }
    .map-picker-actions {
      display: flex;
      justify-content: center;
      gap: 10px;
      margin-top: 14px;
    }
    .map-picker-actions .ri-btn {
      min-width: 100px;
    }
  `;
  document.head.appendChild(style);
}
