// Kobo, the RecoverKit mascot: a homing pigeon. Homing pigeons always find
// their way back and carry messages, which is what RecoverKit does for customers.
//
// The SVG has no inline styles, so it works under the dashboard's strict CSP.
// The animation lives in app.css (classes .kobo-*), between the KOBO markers.
//
// modes:
//   'hero'  full loop: crouch -> boomerang flight -> squash landing -> head bob -> ₦ coin pop
//   'mark'  small logo: idle blink and an occasional head bob
//   'still' no animation (favicons, exports)

const BIRD = `
  <g class="kobo-tail">
    <path class="k-wing" d="M34 80 L12 70 Q10 76 17 80 Q9 84 12 90 L34 88 Z"/>
    <path class="k-wing-2" d="M30 82 L15 78 Q14 82 19 83 L30 85 Z"/>
  </g>
  <path class="k-body" d="M31 76 C30 56 45 44 62 45 C80 46 92 58 90 76 C88 93 73 101 57 100 C41 99 32 91 31 76 Z"/>
  <path class="k-belly" d="M50 82 C50 70 60 63 72 66 C84 69 86 82 80 91 C73 99 58 99 52 92 C50 89 50 86 50 82 Z"/>
  <path class="k-strap" d="M66 50 C58 62 50 74 44 88"/>
  <g class="kobo-wing">
    <path class="k-wing" d="M36 68 C44 56 62 56 70 67 C66 80 50 88 35 84 C32 78 32 73 36 68 Z"/>
    <path class="k-wing-2" d="M40 76 C48 74 56 74 63 70 M38 81 C46 81 54 79 60 76"/>
  </g>
  <g class="kobo-bag">
    <rect class="k-bag" x="34" y="84" width="22" height="15" rx="4"/>
    <path class="k-bag-flap" d="M34 88 Q45 95 56 88 L56 87 Q56 84 52 84 L38 84 Q34 84 34 87 Z"/>
    <circle class="k-bag-dot" cx="45" cy="91" r="1.6"/>
  </g>
  <g class="kobo-head">
    <path class="k-sheen" d="M60 50 C62 42 70 37 79 39 C86 41 90 47 89 54 C82 50 70 49 60 50 Z"/>
    <circle class="k-body" cx="77" cy="36" r="17"/>
    <path class="k-tuft" d="M70 21 C67 14 74 11 76 17 C77 11 84 12 81 19"/>
    <circle class="k-cheek" cx="86" cy="45" r="3.2"/>
    <path class="k-beak" d="M92 35 C97 36 103 39 105 42 C101 44 96 45 92 45 C90 42 90 38 92 35 Z"/>
    <g class="kobo-eye">
      <circle class="k-eye" cx="81" cy="33" r="6.6"/>
      <circle class="k-pupil" cx="83" cy="33.6" r="3.7"/>
      <circle class="k-glint" cx="84.4" cy="32" r="1.3"/>
    </g>
    <path class="k-brow" d="M75 25 Q81 22 87 25"/>
  </g>
  <g class="k-feet">
    <path d="M52 99 L50 106 M46 107 L50 106 L53 108"/>
    <path d="M64 99 L66 106 M62 108 L66 106 L70 107"/>
  </g>`;

export function kobo({ mode = 'mark', size = 32, title = 'Kobo, the RecoverKit pigeon' } = {}) {
  const hero = mode === 'hero';
  const view = hero ? '-24 -56 170 172' : '4 6 110 110';
  return `<svg class="kobo kobo-${mode}" width="${size}" height="${size}" viewBox="${view}" role="img" aria-label="${title}" focusable="false">
  ${hero ? `<path class="kobo-trail" d="M60 74 C86 54 90 14 72 4 C54 -4 36 8 38 32 C40 52 50 66 60 74"/>
  <ellipse class="kobo-shadow" cx="58" cy="108" rx="24" ry="4"/>` : ''}
  <g class="kobo-flight"><g class="kobo-squash">${BIRD}</g></g>
  ${hero ? `<g class="kobo-coin"><circle cx="45" cy="78" r="8"/><text x="45" y="81.5" text-anchor="middle">₦</text></g>` : ''}
</svg>`;
}
