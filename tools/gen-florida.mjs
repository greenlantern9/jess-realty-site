import { writeFileSync } from 'node:fs';

// Florida outline, clockwise from the Alabama line on the Gulf.
// Simplified but curve-smoothed below, so it reads as a real coastline
// rather than a polygon.
// A third element marks a "sharp" vertex. Where two sharp vertices meet, the
// segment is drawn as a straight line: the northern borders are surveyed
// state lines, and smoothing them made the panhandle bulge like a blob.
const MAINLAND = [
  [30.28, -87.52, 1], [31.00, -87.60, 1], [31.00, -85.00, 1], [30.71, -85.00, 1],
  [30.64, -84.86, 1], [30.62, -83.50, 1], [30.62, -82.20, 1], [30.75, -82.05, 1],
  [30.79, -81.63, 1],
  // Atlantic coast
  [30.40, -81.42], [29.90, -81.29], [29.45, -81.12], [29.02, -80.92],
  [28.60, -80.65], [28.10, -80.58], [27.60, -80.34], [27.10, -80.14],
  [26.60, -80.04], [26.10, -80.10], [25.76, -80.13], [25.42, -80.32],
  [25.22, -80.50],
  // Everglades / Cape Sable
  [25.12, -80.90], [25.16, -81.13], [25.55, -81.25], [25.85, -81.40],
  // Gulf coast north
  [26.10, -81.75], [26.42, -81.98], [26.75, -82.20], [27.05, -82.42],
  [27.34, -82.58], [27.60, -82.68], [27.85, -82.83], [28.15, -82.78],
  [28.45, -82.70], [28.80, -82.70], [29.05, -82.80], [29.20, -83.08],
  [29.45, -83.35], [29.70, -83.75], [29.92, -84.32],
  // Panhandle
  [29.78, -84.70], [29.70, -85.00], [29.90, -85.35], [30.10, -85.65],
  [30.28, -86.10], [30.38, -86.60], [30.40, -87.10]
];

// The Keys read better as a stroked arc than as part of the polygon.
const KEYS = [
  [25.22, -80.50], [24.98, -80.62], [24.82, -80.85], [24.72, -81.10],
  [24.63, -81.40], [24.56, -81.65], [24.55, -81.80]
];

const CITIES = [
  { name: 'Tampa',        lat: 27.95, lon: -82.46, tier: 1, anchor: 'end',    dx: -24, dy: 1 },
  { name: 'Sarasota',     lat: 27.34, lon: -82.53, tier: 1, anchor: 'end',    dx: -24, dy: 5 },
  { name: 'Jacksonville', lat: 30.33, lon: -81.66, tier: 2, anchor: 'start',  dx: 9,   dy: 3 },
  { name: 'Orlando',      lat: 28.54, lon: -81.38, tier: 2, anchor: 'start',  dx: 9,   dy: 3 },
  { name: 'Tallahassee',  lat: 30.44, lon: -84.28, tier: 2, anchor: 'middle', dx: 0,   dy: -11 },
  { name: 'Naples',       lat: 26.14, lon: -81.79, tier: 2, anchor: 'end',    dx: -9,  dy: 3 },
  { name: 'Miami',        lat: 25.76, lon: -80.19, tier: 2, anchor: 'start',  dx: 9,   dy: 3 }
];

const PAD = 28;
const SCALE = 108;
const latMax = 31.18, latMin = 24.42;
const lonMin = -87.9;
const kx = Math.cos((27.75 * Math.PI) / 180);

const x = (lon) => PAD + (lon - lonMin) * kx * SCALE;
const y = (lat) => PAD + (latMax - lat) * SCALE;
const r1 = (n) => Math.round(n * 10) / 10;

const project = (pts) => pts.map(([la, lo, sharp]) => [x(lo), y(la), sharp ? 1 : 0]);

// Catmull-Rom through the points, emitted as cubic beziers - gives the
// coastline a natural curve instead of visible straight segments.
function smooth(points, closed, tension = 1) {
  const n = points.length;
  const at = (i) =>
    closed ? points[(i + n) % n] : points[Math.min(Math.max(i, 0), n - 1)];

  let d = `M${r1(points[0][0])} ${r1(points[0][1])}`;
  const last = closed ? n : n - 1;

  for (let i = 0; i < last; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);

    // Straight run between two surveyed corners - no curve.
    if (p1[2] && p2[2]) {
      d += ` L${r1(p2[0])} ${r1(p2[1])}`;
      continue;
    }

    const c1x = p1[0] + ((p2[0] - p0[0]) / 6) * tension;
    const c1y = p1[1] + ((p2[1] - p0[1]) / 6) * tension;
    const c2x = p2[0] - ((p3[0] - p1[0]) / 6) * tension;
    const c2y = p2[1] - ((p3[1] - p1[1]) / 6) * tension;
    d += ` C${r1(c1x)} ${r1(c1y)}, ${r1(c2x)} ${r1(c2y)}, ${r1(p2[0])} ${r1(p2[1])}`;
  }
  return closed ? d + ' Z' : d;
}

const W = Math.round(x(-79.85) + PAD);
const H = Math.round(y(latMin) + PAD);

// Lower tension on the mainland keeps the straight state lines (31N, the
// Georgia border) from bulging outward.
const mainland = smooth(project(MAINLAND), true, 0.9);
const keys = smooth(project(KEYS), false, 1);

const heat = [
  { name: 'tampa',    lat: 27.95, lon: -82.46, r: 3.05 },
  { name: 'sarasota', lat: 27.34, lon: -82.53, r: 2.55 }
];

const gradients = heat
  .map(
    (h) => `      <radialGradient id="heat-${h.name}">
        <stop offset="0%"   stop-color="#dbe9ff" stop-opacity=".92"/>
        <stop offset="18%"  stop-color="#a9c6e8" stop-opacity=".62"/>
        <stop offset="42%"  stop-color="#7fa6d0" stop-opacity=".34"/>
        <stop offset="70%"  stop-color="#7fa6d0" stop-opacity=".14"/>
        <stop offset="100%" stop-color="#7fa6d0" stop-opacity="0"/>
      </radialGradient>`
  )
  .join('\n');

const heatCircles = heat
  .map(
    (h) =>
      `      <circle cx="${r1(x(h.lon))}" cy="${r1(y(h.lat))}" r="${r1(h.r * SCALE)}" fill="url(#heat-${h.name})"/>`
  )
  .join('\n');

const cityMarkers = CITIES.map((c) => {
  const cx = r1(x(c.lon)), cy = r1(y(c.lat));
  const primary = c.tier === 1;
  const dot = primary
    ? `<circle cx="${cx}" cy="${cy}" r="6" class="cov-dot cov-dot-1"/><circle cx="${cx}" cy="${cy}" r="12" class="cov-ring"/>`
    : `<circle cx="${cx}" cy="${cy}" r="3.4" class="cov-dot cov-dot-2"/>`;
  const label = `<text x="${r1(cx + c.dx)}" y="${r1(cy + c.dy)}" text-anchor="${c.anchor}" class="cov-label${primary ? ' cov-label-1' : ''}">${c.name}</text>`;
  return '      ' + dot + label;
}).join('\n');

const svg = `<svg class="coverage-map" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"
     role="img" aria-labelledby="cov-title cov-desc">
  <title id="cov-title">Service coverage across Florida</title>
  <desc id="cov-desc">A map of Florida shaded to show coverage of the whole state, concentrated most heavily around Tampa and Sarasota and fading outward from there.</desc>
  <defs>
${gradients}
    <clipPath id="fl-clip"><path d="${mainland}"/></clipPath>
  </defs>

  <!-- base wash: the whole state is covered, just less densely -->
  <path d="${mainland}" class="cov-base"/>

  <g clip-path="url(#fl-clip)">
${heatCircles}
  </g>

  <path d="${mainland}" class="cov-outline"/>
  <path d="${keys}" class="cov-keys"/>

  <g class="cov-cities">
${cityMarkers}
  </g>
</svg>`;

writeFileSync(new URL('./coverage.svg', import.meta.url), svg);
console.log(`viewBox 0 0 ${W} ${H}   bytes ${svg.length}`);
