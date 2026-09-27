'use strict';
// Renders Twig's SVG to assets/icon.svg (then ImageMagick turns it into PNG sizes).
const fs = require('fs');
const path = require('path');
global.window = {};
require('../src/ui/twig.js');
const svg = window.Twig.svg({ stage: 'sprout', mood: 'happy', size: 512 })
  .replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ')
  .replace('viewBox="0 0 200 220"', 'viewBox="0 60 200 160"')
  .replace(/width="512" height="\d+"/, 'width="512" height="410"');
fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.svg'), svg);
