'use strict';
// Twig, drawn in SVG. Grows through 5 stages (seed → oak) and shows 5 moods.
// Exposed as window.Twig.svg({ stage, mood, size }).
(() => {
  const C = {
    leaf: '#6fbf4a', leafDark: '#4f9a35', leafLight: '#9edb73',
    seed: '#d9a066', seedDark: '#b97d45', belly: '#f6dcb0',
    sprout: '#8fd16a', sproutDark: '#6db34a', sproutBelly: '#d8f2c2',
    bark: '#b98352', barkDark: '#94643a', barkBelly: '#ecd2ae',
    crown: '#5fae45', crownDark: '#3f8a31', crownLight: '#86cc5e',
    ink: '#3b2a1e', blush: '#ff9fa8', white: '#ffffff', acorn: '#a86b32', acornCap: '#6b4423',
  };

  const leaf = (x, y, rot, s = 1, fill = C.leaf) =>
    `<path d="M0 0 C ${8 * s} ${-10 * s} ${22 * s} ${-10 * s} ${28 * s} 0 C ${22 * s} ${10 * s} ${8 * s} ${10 * s} 0 0 Z" fill="${fill}" transform="translate(${x} ${y}) rotate(${rot})"/>` +
    `<path d="M${x} ${y} l ${Math.cos((rot * Math.PI) / 180) * 22 * s} ${Math.sin((rot * Math.PI) / 180) * 22 * s}" stroke="${C.leafDark}" stroke-width="1.4" stroke-linecap="round" opacity=".55"/>`;

  function stem(topY, fromY = 108) {
    return `<path d="M100 ${fromY} C 98 ${fromY - 10} 102 ${topY + 8} 100 ${topY}" stroke="${C.leafDark}" stroke-width="4" fill="none" stroke-linecap="round"/>`;
  }

  function body(stage) {
    switch (stage) {
      case 'seed':
        return `${stem(84)}${leaf(100, 88, -35, 0.8)}
          <ellipse cx="100" cy="150" rx="50" ry="46" fill="${C.seed}"/>
          <ellipse cx="100" cy="164" rx="32" ry="24" fill="${C.belly}" opacity=".7"/>
          <path d="M60 128 Q70 112 88 108" stroke="${C.seedDark}" stroke-width="3" fill="none" stroke-linecap="round" opacity=".35"/>`;
      case 'sprout':
        return `${stem(80, 104)}${leaf(100, 84, -30, 1)}${leaf(100, 84, -150, 1)}
          <ellipse cx="100" cy="148" rx="48" ry="50" fill="${C.sprout}"/>
          <ellipse cx="100" cy="164" rx="31" ry="26" fill="${C.sproutBelly}" opacity=".8"/>`;
      case 'sapling':
        return `${stem(66, 100)}${leaf(100, 70, -25, 1.1)}${leaf(100, 70, -155, 1.1)}${leaf(100, 68, -90, 0.9, C.leafLight)}
          <path d="M56 150 Q40 142 30 128" stroke="${C.sproutDark}" stroke-width="5" fill="none" stroke-linecap="round"/>${leaf(30, 128, -120, 0.8)}
          <path d="M144 150 Q160 142 170 128" stroke="${C.sproutDark}" stroke-width="5" fill="none" stroke-linecap="round"/>${leaf(170, 128, -60, 0.8)}
          <ellipse cx="100" cy="146" rx="48" ry="54" fill="${C.sprout}"/>
          <ellipse cx="100" cy="164" rx="31" ry="28" fill="${C.sproutBelly}" opacity=".8"/>`;
      case 'young':
        return `<g class="crown">
            <circle cx="62" cy="86" r="30" fill="${C.crownDark}"/><circle cx="138" cy="86" r="30" fill="${C.crownDark}"/>
            <circle cx="100" cy="66" r="38" fill="${C.crown}"/><circle cx="74" cy="72" r="24" fill="${C.crown}"/><circle cx="126" cy="72" r="24" fill="${C.crown}"/>
            <circle cx="88" cy="56" r="10" fill="${C.crownLight}" opacity=".8"/></g>
          <path d="M56 150 Q40 140 32 124" stroke="${C.barkDark}" stroke-width="6" fill="none" stroke-linecap="round"/>${leaf(32, 124, -115, 0.8)}
          <path d="M144 150 Q160 140 168 124" stroke="${C.barkDark}" stroke-width="6" fill="none" stroke-linecap="round"/>${leaf(168, 124, -65, 0.8)}
          <ellipse cx="100" cy="148" rx="46" ry="54" fill="${C.bark}"/>
          <ellipse cx="100" cy="166" rx="30" ry="28" fill="${C.barkBelly}" opacity=".75"/>`;
      case 'oak':
      default:
        return `<g class="crown">
            <circle cx="48" cy="92" r="32" fill="${C.crownDark}"/><circle cx="152" cy="92" r="32" fill="${C.crownDark}"/>
            <circle cx="100" cy="58" r="46" fill="${C.crown}"/><circle cx="64" cy="66" r="30" fill="${C.crown}"/><circle cx="136" cy="66" r="30" fill="${C.crown}"/>
            <circle cx="84" cy="44" r="12" fill="${C.crownLight}" opacity=".8"/><circle cx="128" cy="52" r="8" fill="${C.crownLight}" opacity=".7"/>
            <g transform="translate(150 104)"><ellipse cx="0" cy="6" rx="8" ry="10" fill="${C.acorn}"/><path d="M-9 2 Q0 -8 9 2 Z" fill="${C.acornCap}"/></g>
            <g transform="translate(52 110)"><ellipse cx="0" cy="6" rx="7" ry="9" fill="${C.acorn}"/><path d="M-8 2 Q0 -7 8 2 Z" fill="${C.acornCap}"/></g></g>
          <path d="M56 152 Q36 144 26 124" stroke="${C.barkDark}" stroke-width="7" fill="none" stroke-linecap="round"/>${leaf(26, 124, -115, 0.9)}
          <path d="M144 152 Q164 144 174 124" stroke="${C.barkDark}" stroke-width="7" fill="none" stroke-linecap="round"/>${leaf(174, 124, -65, 0.9)}
          <ellipse cx="100" cy="150" rx="50" ry="54" fill="${C.bark}"/>
          <ellipse cx="100" cy="168" rx="32" ry="28" fill="${C.barkBelly}" opacity=".75"/>
          <path d="M70 186 q-10 12 -22 14 M130 186 q10 12 22 14" stroke="${C.barkDark}" stroke-width="5" fill="none" stroke-linecap="round"/>`;
    }
  }

  function eyes(mood) {
    if (mood === 'sleepy') {
      return `<path d="M76 142 Q84 148 92 142" stroke="${C.ink}" stroke-width="3" fill="none" stroke-linecap="round"/>
        <path d="M108 142 Q116 148 124 142" stroke="${C.ink}" stroke-width="3" fill="none" stroke-linecap="round"/>`;
    }
    const ry = mood === 'curious' ? 10 : 9;
    const brows = mood === 'worried'
      ? `<path d="M74 124 L90 128" stroke="${C.ink}" stroke-width="3" stroke-linecap="round"/><path d="M126 124 L110 128" stroke="${C.ink}" stroke-width="3" stroke-linecap="round"/>`
      : '';
    const shine = mood === 'proud' ? `<path d="M80 134 l2 -4 l2 4 l4 1 l-4 2 l-2 4 l-2 -4 l-4 -2 z" fill="${C.white}"/><path d="M114 134 l2 -4 l2 4 l4 1 l-4 2 l-2 4 l-2 -4 l-4 -2 z" fill="${C.white}"/>` : '';
    return `${brows}<g class="blink">
      <ellipse cx="84" cy="142" rx="7.5" ry="${ry}" fill="${C.ink}"/><ellipse cx="116" cy="142" rx="7.5" ry="${ry}" fill="${C.ink}"/>
      <circle cx="86.5" cy="138" r="2.8" fill="${C.white}"/><circle cx="118.5" cy="138" r="2.8" fill="${C.white}"/>
      <circle cx="82" cy="146" r="1.3" fill="${C.white}" opacity=".8"/><circle cx="114" cy="146" r="1.3" fill="${C.white}" opacity=".8"/>
      ${shine}</g>`;
  }

  function mouth(mood) {
    switch (mood) {
      case 'curious': return `<ellipse cx="100" cy="162" rx="4.5" ry="5.5" fill="${C.ink}"/>`;
      case 'worried': return `<path d="M89 165 Q94 159 100 164 Q106 169 111 163" stroke="${C.ink}" stroke-width="3" fill="none" stroke-linecap="round"/>`;
      case 'proud': return `<path d="M86 156 Q100 178 114 156 Z" fill="${C.ink}"/><path d="M93 166 Q100 173 107 166 Q100 168 93 166Z" fill="#ff7b8a"/>`;
      case 'sleepy': return `<ellipse cx="100" cy="161" rx="3.5" ry="2.5" fill="${C.ink}"/>`;
      default: return `<path d="M89 157 Q100 169 111 157" stroke="${C.ink}" stroke-width="3.2" fill="none" stroke-linecap="round"/>`;
    }
  }

  function extras(mood) {
    if (mood === 'sleepy') return `<text class="zzz" x="140" y="110" font-size="22" font-weight="700" fill="#8b7bb8">z</text><text class="zzz z2" x="156" y="92" font-size="16" font-weight="700" fill="#8b7bb8">z</text>`;
    if (mood === 'worried') return `<path class="sweat" d="M150 118 q6 10 0 14 q-6 -4 0 -14z" fill="#8cc8ff"/>`;
    if (mood === 'curious') return `<text class="qmark" x="146" y="104" font-size="26" font-weight="800" fill="#e8a33d">?</text>`;
    if (mood === 'proud') return `<g class="sparkles"><path d="M34 90 l3 -7 l3 7 l7 3 l-7 3 l-3 7 l-3 -7 l-7 -3z" fill="#ffd166"/><path d="M162 70 l2 -5 l2 5 l5 2 l-5 2 l-2 5 l-2 -5 l-5 -2z" fill="#ffd166"/></g>`;
    return '';
  }

  function svg({ stage = 'seed', mood = 'happy', size = 160, label = 'Twig' } = {}) {
    return `<svg class="twig stage-${stage} mood-${mood}" viewBox="0 0 200 220" width="${size}" height="${Math.round(size * 1.1)}" role="img" aria-label="${label}, ${mood}">
      <ellipse cx="100" cy="206" rx="52" ry="8" fill="#000" opacity=".08"/>
      <g class="sway">${body(stage)}
        <ellipse cx="70" cy="158" rx="9" ry="5.5" fill="${C.blush}" opacity=".7"/><ellipse cx="130" cy="158" rx="9" ry="5.5" fill="${C.blush}" opacity=".7"/>
        ${eyes(mood)}${mouth(mood)}${extras(mood)}
      </g></svg>`;
  }

  window.Twig = { svg, stages: ['seed', 'sprout', 'sapling', 'young', 'oak'], moods: ['happy', 'curious', 'worried', 'proud', 'sleepy'] };
})();
