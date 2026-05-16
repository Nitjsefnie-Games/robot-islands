// Inline SVG icon registry. Lucide-derived line icons, hand-trimmed to the
// dozen the game actually needs. Committed to the repo — no runtime fetch,
// no external dep.
//
// Use:
//
//     import { icon } from './ui-icons.js';
//     btn.appendChild(icon('building', 18));
//
// Sizing: defaults to 16; pass an explicit size for action-strip buttons.
// Stroke is `currentColor`, so wrap an icon in any text-colour container
// and it follows along.

export type IconId =
  | 'building'      // Buildings catalog
  | 'inventory'     // Inventory
  | 'drone'         // Drone Ops
  | 'route'         // Routes (freight grid)
  | 'settle'        // Settlement vehicles
  | 'construct'     // Artificial-island construction
  | 'skills'        // Skill tree
  | 'settings'      // Settings
  | 'grid'          // Toggle grid
  | 'crosshair'     // Center on active
  | 'island'        // generic island marker
  | 'power'         // power / lightning
  | 'level'         // chevron-up (level)
  | 'alert'         // alert triangle
  | 'demolish'      // trash
  | 'expand'        // arrows-out
  | 'close'         // x
  | 'graph'         // recipe graph (node-and-edge)
  | 'rocket'        // T6 orbital launch
  | 'check';

const PATHS: Record<IconId, string> = {
  building:
    '<rect x="3" y="9" width="6" height="12" /><rect x="9" y="3" width="6" height="18" /><rect x="15" y="13" width="6" height="8" /><line x1="2" y1="21" x2="22" y2="21" />',
  inventory:
    '<path d="M3 7l9-4 9 4-9 4-9-4z" /><path d="M3 12l9 4 9-4" /><path d="M3 17l9 4 9-4" />',
  drone:
    '<circle cx="12" cy="12" r="3" /><line x1="12" y1="2" x2="12" y2="6" /><line x1="12" y1="18" x2="12" y2="22" /><line x1="2" y1="12" x2="6" y2="12" /><line x1="18" y1="12" x2="22" y2="12" /><circle cx="5" cy="5" r="1.6" /><circle cx="19" cy="5" r="1.6" /><circle cx="5" cy="19" r="1.6" /><circle cx="19" cy="19" r="1.6" />',
  route:
    '<circle cx="5" cy="6" r="2" /><circle cx="19" cy="18" r="2" /><path d="M7 6c4 0 4 6 8 6s4 6 8 6" />',
  settle:
    '<path d="M3 14l9-9 9 9" /><path d="M5 12v9h4v-5h6v5h4v-9" />',
  construct:
    '<rect x="3" y="9" width="18" height="12" /><path d="M3 9l9-6 9 6" /><line x1="9" y1="13" x2="15" y2="13" /><line x1="9" y1="17" x2="15" y2="17" />',
  skills:
    '<circle cx="12" cy="6" r="2.2" /><circle cx="5" cy="14" r="2.2" /><circle cx="19" cy="14" r="2.2" /><circle cx="12" cy="20" r="2.2" /><line x1="12" y1="8.2" x2="6" y2="12.5" /><line x1="12" y1="8.2" x2="18" y2="12.5" /><line x1="6" y1="16" x2="11" y2="18.5" /><line x1="18" y1="16" x2="13" y2="18.5" />',
  settings:
    '<circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />',
  grid:
    '<rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />',
  crosshair:
    '<circle cx="12" cy="12" r="9" /><line x1="12" y1="2" x2="12" y2="6" /><line x1="12" y1="18" x2="12" y2="22" /><line x1="2" y1="12" x2="6" y2="12" /><line x1="18" y1="12" x2="22" y2="12" />',
  island:
    '<ellipse cx="12" cy="14" rx="9" ry="5" /><path d="M7 13c1-3 4-5 5-5s4 2 5 5" />',
  power:
    '<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />',
  level:
    '<polyline points="18 15 12 9 6 15" />',
  alert:
    '<path d="M12 3l10 18H2L12 3z" /><line x1="12" y1="10" x2="12" y2="14" /><circle cx="12" cy="17.5" r="0.6" fill="currentColor" />',
  demolish:
    '<path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" /><line x1="10" y1="10" x2="10" y2="17" /><line x1="14" y1="10" x2="14" y2="17" />',
  expand:
    '<polyline points="4 10 4 4 10 4" /><polyline points="14 4 20 4 20 10" /><polyline points="20 14 20 20 14 20" /><polyline points="10 20 4 20 4 14" />',
  close:
    '<line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" />',
  graph:
    '<circle cx="6" cy="6" r="2.2" /><circle cx="18" cy="6" r="2.2" /><circle cx="12" cy="18" r="2.2" /><line x1="7.8" y1="7.5" x2="10.5" y2="16.2" /><line x1="16.2" y1="7.5" x2="13.5" y2="16.2" /><line x1="8" y1="6" x2="16" y2="6" />',
  rocket:
    '<path d="M12 2c3 2 5 5 5 9v6l-2 3h-6l-2-3v-6c0-4 2-7 5-9z" /><circle cx="12" cy="10" r="1.6" /><path d="M9 19l-3 3M15 19l3 3" />',
  check:
    '<polyline points="4 12 10 18 20 6" />',
};

/** Build an inline SVG element. Stroke is currentColor; sizes default to 16. */
export function icon(id: IconId, size = 16): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = PATHS[id];
  return svg;
}
