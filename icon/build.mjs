/*
 * Draws the app icon: a tall block of konnyaku, seen slightly from above, with
 * black specks suspended in it. Writes both variants as SVG and rasterises each
 * to a 1024 PNG — `tauri icon` gets the PNG, because handing it the SVG routes
 * through resvg, which renders the filters here differently (weaker specks, a
 * heavier edge).
 *
 *   npm i -D playwright && npx playwright install chromium
 *   node icon/build.mjs
 *   npm run tauri icon icon/app-icon.png
 *   rm -rf src-tauri/icons/android src-tauri/icons/ios   # desktop only
 *
 * Every dimension comes from the constants below; the specks are placed in
 * face-relative coordinates, so changing the block does not scatter them.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const DIR = path.dirname(fileURLToPath(import.meta.url));

/* ---- geometry: a tall block seen a little from above ---- */

const X0 = 219, X1 = 679;   // front face, left/right
const Y0 = 197, Y1 = 937;   // front face, top/bottom
const DX = 126, DY = 110;   // depth vector: up and to the right
const R = 78;               // corner rounding
const K = 3;                // how far the face overlays run past the silhouette

const W = X1 - X0, H = Y1 - Y0;
const n = (v) => Number(v.toFixed(1));
const f = ([x, y]) => `${n(x)} ${n(y)}`;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const unit = (a) => { const l = Math.hypot(a[0], a[1]); return [a[0] / l, a[1] / l]; };

/** Rounded convex polygon: trim each corner back to where an arc of radius r is tangent. */
function roundPoly(pts, r) {
  let d = "";
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const u1 = unit(sub(pts[(i - 1 + pts.length) % pts.length], p));
    const u2 = unit(sub(pts[(i + 1) % pts.length], p));
    const half = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]))) / 2;
    const t = r / Math.tan(half);
    d += `${i === 0 ? "M" : " L"} ${f(add(p, mul(u1, t)))} A ${r} ${r} 0 0 1 ${f(add(p, mul(u2, t)))}`;
  }
  return `${d} Z`;
}

const poly = (pts) => `M ${pts.map(f).join(" L ")} Z`;
const back = (p) => add(p, [K * DX, -K * DY]);

const SILHOUETTE = [
  [X0, Y0], [X0 + DX, Y0 - DY], [X1 + DX, Y0 - DY],
  [X1 + DX, Y1 - DY], [X1, Y1], [X0, Y1],
];

// Top and side face are both bounded by lines parallel to the depth vector, so
// extending them along it leaves every shared edge exactly where it belongs.
const TOP_FACE = poly([[X0 - 500, Y0], [X1, Y0], back([X1, Y0]), back([X0 - 500, Y0])]);
const SIDE_FACE = poly([[X1, Y0], [X1, Y1], back([X1, Y1]), back([X1, Y0])]);

/* ---- specks, placed in face-relative coordinates ---- */

// Suspended at different depths in a translucent block, so not equally dark.
const DEPTH = [0.86, 0.6, 0.42];

// front face: [u, v, rx, ry, rotation], u/v across the face
const FRONT = [
  [0.18, 0.14, 11, 8, -18], [0.51, 0.09, 8, 10, 22], [0.80, 0.17, 12, 8, -8],
  [0.29, 0.28, 9, 9, 0], [0.61, 0.33, 11, 8, 32], [0.88, 0.39, 9, 11, 18],
  [0.15, 0.42, 10, 12, 14], [0.42, 0.49, 12, 8, -12], [0.72, 0.55, 8, 10, 40],
  [0.90, 0.66, 10, 8, -34], [0.21, 0.63, 11, 8, 8], [0.55, 0.72, 9, 9, 0],
  [0.82, 0.78, 12, 8, -22], [0.31, 0.83, 9, 8, 16], [0.94, 0.50, 8, 8, 0],
  [0.10, 0.55, 7, 8, 0], [0.66, 0.44, 7, 7, 12], [0.86, 0.26, 8, 6, -30],
  [0.47, 0.90, 8, 6, 10], [0.69, 0.87, 7, 7, 0], [0.36, 0.66, 7, 7, -20],
];
// top face: [u, w, rx, ry, rotation], w along the depth direction
const TOP = [
  [0.34, 0.45, 10, 5, 8], [0.66, 0.78, 9, 4, -6], [0.88, 0.35, 10, 5, 14],
  [0.52, 0.18, 8, 4, 0], [0.20, 0.72, 9, 4, -12],
];

const speck = ([x, y], rx, ry, rot, o) => `
        <ellipse cx="${n(x + 3)}" cy="${n(y + 5)}" rx="${rx}" ry="${ry}" transform="rotate(${rot} ${n(x + 3)} ${n(y + 5)})" fill="#ffffff" opacity="${n(0.3 * o)}"/>
        <ellipse cx="${n(x)}" cy="${n(y)}" rx="${rx}" ry="${ry}" transform="rotate(${rot} ${n(x)} ${n(y)})" fill="#12150e" opacity="${o}"/>`;

const specks = [
  ...FRONT.map(([u, v, rx, ry, rot], i) =>
    speck([X0 + u * W, Y0 + v * H], rx, ry, rot, DEPTH[i % 3])),
  ...TOP.map(([u, w, rx, ry, rot], i) =>
    speck([X0 + u * W + w * DX, Y0 - w * DY], rx, ry, rot, DEPTH[i % 3])),
].join("");

/* ---- the block ---- */

const block = `
  <defs>
    <clipPath id="sil"><path d="${roundPoly(SILHOUETTE, R)}"/></clipPath>

    <linearGradient id="front" gradientUnits="userSpaceOnUse" x1="${n(X0 + 70)}" y1="${Y0}" x2="${n(X1 - 50)}" y2="${Y1}">
      <stop offset="0" stop-color="#dae0d0"/>
      <stop offset="0.5" stop-color="#b2baa6"/>
      <stop offset="0.85" stop-color="#949c88"/>
      <stop offset="1" stop-color="#adb59f"/>
    </linearGradient>
    <linearGradient id="top" gradientUnits="userSpaceOnUse" x1="${X0}" y1="${Y0}" x2="${n(X0 + DX)}" y2="${n(Y0 - DY)}">
      <stop offset="0" stop-color="#f5f8ed"/>
      <stop offset="1" stop-color="#ccd3c1"/>
    </linearGradient>
    <linearGradient id="side" gradientUnits="userSpaceOnUse" x1="${X1}" y1="${Y0}" x2="${n(X1 + DX)}" y2="${n(Y0 - DY)}">
      <stop offset="0" stop-color="#969e8b"/>
      <stop offset="1" stop-color="#6f776a"/>
    </linearGradient>

    <filter id="soft" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="30"/>
    </filter>
    <filter id="wet" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="7"/>
    </filter>
    <filter id="cast" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="20"/>
    </filter>
    <filter id="rim" x="-14%" y="-14%" width="128%" height="128%">
      <feMorphology in="SourceAlpha" operator="erode" radius="4" result="er"/>
      <feComposite in="SourceAlpha" in2="er" operator="out" result="band"/>
      <feFlood flood-color="#4b5147" flood-opacity="0.5"/>
      <feComposite in2="band" operator="in" result="edge"/>
      <feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="edge"/></feMerge>
    </filter>
  </defs>

  <ellipse cx="${n((X0 + X1) / 2 + 24)}" cy="${n(Y1 + 20)}" rx="215" ry="30" fill="#1e2119" opacity="0.26" filter="url(#cast)"/>

  <g filter="url(#rim)">
    <g clip-path="url(#sil)">
      <rect width="1024" height="1024" fill="url(#front)"/>
      <path d="${SIDE_FACE}" fill="url(#side)"/>
      <path d="${TOP_FACE}" fill="url(#top)"/>

      <!-- light gathering inside the block, and pooling low down where it leaves -->
      <ellipse cx="${n(X0 + W * 0.42)}" cy="${n(Y0 + H * 0.42)}" rx="240" ry="200" fill="#ffffff" opacity="0.1" filter="url(#soft)"/>
      <ellipse cx="${n(X0 + W * 0.5)}" cy="${n(Y1 - 70)}" rx="200" ry="90" fill="#f4f9ea" opacity="0.24" filter="url(#soft)"/>
      <ellipse cx="${n(X1 - 20)}" cy="${n(Y1 - 40)}" rx="120" ry="110" fill="#1d2118" opacity="0.1" filter="url(#soft)"/>

      <!-- wet: sheen across the top, and one streak down the near corner -->
      <ellipse cx="${n(X0 + W * 0.45)}" cy="${n(Y0 + 60)}" rx="240" ry="120" fill="#ffffff" opacity="0.17" filter="url(#soft)"/>
      <ellipse cx="${n(X0 + 96)}" cy="${n(Y0 + 250)}" rx="30" ry="190" transform="rotate(6 ${n(X0 + 96)} ${n(Y0 + 250)})" fill="#ffffff" opacity="0.3" filter="url(#wet)"/>

      <g>${specks}
      </g>

      <!-- the edges catch the light: near-top, the depth diagonal, then the sides -->
      <path d="M ${f([X0, Y0])} L ${f([X1, Y0])}" stroke="#ffffff" stroke-opacity="0.5" stroke-width="5" fill="none"/>
      <path d="M ${f([X1, Y0])} L ${f(back([X1, Y0]))}" stroke="#ffffff" stroke-opacity="0.24" stroke-width="4" fill="none"/>
      <path d="M ${f([X1, Y0])} L ${f([X1, Y1])}" stroke="#ffffff" stroke-opacity="0.16" stroke-width="4" fill="none"/>
      <path d="M ${f([X0, Y0])} L ${f([X0, Y1])}" stroke="#ffffff" stroke-opacity="0.22" stroke-width="4" fill="none"/>
      <path d="M ${f([X0, Y1])} L ${f([X1, Y1])}" stroke="#ffffff" stroke-opacity="0.18" stroke-width="4" fill="none"/>
    </g>
  </g>`;

const plain = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">${block}
</svg>`;

const tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="tilebg" x1="0" y1="0" x2="0.7" y2="1">
      <stop offset="0" stop-color="#eccd8d"/>
      <stop offset="1" stop-color="#c1913f"/>
    </linearGradient>
  </defs>
  <rect x="32" y="32" width="960" height="960" rx="216" fill="url(#tilebg)"/>
  <g transform="translate(512 512) scale(0.74) translate(-512 -512)">${block}
  </g>
</svg>`;

const VARIANTS = { "app-icon": plain, "app-icon-tile": tile };

for (const [name, svg] of Object.entries(VARIANTS)) {
  fs.writeFileSync(path.join(DIR, `${name}.svg`), svg);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
for (const name of Object.keys(VARIANTS)) {
  await page.goto(`file://${path.join(DIR, `${name}.svg`)}`);
  await page.screenshot({ path: path.join(DIR, `${name}.png`), omitBackground: true });
  console.log(`${name}.svg ${name}.png`);
}
await browser.close();
