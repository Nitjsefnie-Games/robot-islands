// Design tokens for Robot Islands UI.
//
// Single source of truth for color / type / spacing / radius / shadow.
// EVERY DOM-ui file (`hud.ts`, `ui.ts`, `*-ui.ts`, `inspector-ui.ts`, …)
// MUST import from here instead of repeating inline hex codes.
//
// The cyan accent `COLOR.accent` (#7dd3e8) is also the in-canvas
// `VISION_BLUE` exported from `world.ts`. Do NOT redefine it — import
// it back into `world.ts` from here to keep canvas + DOM in lockstep.

export const COLOR = {
  // Surfaces — deeper than the previous palette so the canvas (also at
  // void) reads as part of the page, and floating panels lift cleanly.
  void: '#07090d',
  panel: 'rgba(14, 18, 26, 0.88)',
  panelSolid: '#11151c',
  elev: '#181d27',
  hover: 'rgba(125, 211, 232, 0.06)',
  pressed: 'rgba(125, 211, 232, 0.12)',
  scrim: 'rgba(7, 9, 13, 0.72)',

  // Strokes
  border: '#2a3240',
  borderStrong: '#3a4452',
  borderAccent: 'rgba(125, 211, 232, 0.40)',
  rule: 'rgba(58, 68, 82, 0.55)',

  // Foreground
  fg1: '#e6ecf5',   // primary — brighter than the previous #cdd6f4
  fg2: '#98a2b3',
  fg3: '#6c7791',
  fg4: '#4a5365',

  // Semantic accents
  accent: '#7dd3e8',
  accentStrong: '#a5e6f5',
  accentDim: '#3d6f7c',
  success: '#7dd3a0',
  warn: '#f5a742',
  danger: '#e85d4a',
  exotic: '#b48cd8',

  // Tier band colors. Distinct from semantic so `T4` never reads as a warning.
  tier: {
    t1: '#9bb1c7',
    t2: '#7dd3e8',
    t3: '#7dd3a0',
    t4: '#f5a742',
    t5: '#b48cd8',
    t6: '#e85d4a',
  } as const,
} as const;

export const FONT = {
  sans: '"Inter Tight", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  size: {
    xs: '10px',
    sm: '11px',
    md: '12px',
    lg: '14px',
    xl: '17px',
    xxl: '22px',
  } as const,
  weight: { regular: '450', medium: '550', bold: '650' } as const,
  trackCaps: '0.08em',
  trackData: '0.02em',
} as const;

export const SPACE = {
  px1: '4px', px2: '8px', px3: '12px', px4: '16px',
  px5: '20px', px6: '24px', px8: '32px', px10: '40px', px12: '48px',
} as const;

export const RADIUS = { sm: '3px', md: '6px', lg: '10px', pill: '999px' } as const;

export const SHADOW = {
  panel: '0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 24px rgba(0,0,0,0.45), 0 1px 2px rgba(0,0,0,0.6)',
  pop:   '0 1px 0 rgba(255,255,255,0.04) inset, 0 16px 48px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.7)',
  glow:  '0 0 0 1px rgba(125,211,232,0.45), 0 0 12px rgba(125,211,232,0.25)',
} as const;

// Z-index layering. No file may write a raw z-index in inline style; pick
// one of these.
export const Z = {
  map: 0,
  panel: 20,
  dock: 30,
  toast: 40,
  modal: 60,
  tooltip: 80,
} as const;

/** Convert a snake_case resource / building id to a human-readable title. */
export const toDisplayName = (id: string): string =>
  id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Apply one or more declarations to an element. Filters empty entries. */
export function applyStyle(el: HTMLElement, ...decls: string[]): void {
  el.style.cssText = decls.filter(Boolean).join(';');
}
