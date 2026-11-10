// Builds index.html from src/: shell + engine + one <template> per phase.
// Usage: node revision/masterclass/build.js
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, 'src');
const read = (f) => fs.readFileSync(path.join(src, f), 'utf8');

const ids = [...Array(20)].map((_, i) => 'p' + String(i + 1).padStart(2, '0')).concat('final');
const missing = [];
const templates = ids.map((id) => {
  const f = id + '.html';
  if (!fs.existsSync(path.join(src, f))) { missing.push(f); return ''; }
  return `<template id="tpl-${id}">\n${read(f)}\n</template>`;
}).join('\n');

const app = read('app.js');
if (app.includes('</script')) throw new Error('app.js must not contain </script');
const out = read('shell.html').split('<!--CONTENT-->').join(templates).split('/*APP*/').join(app);
fs.writeFileSync(path.join(__dirname, 'index.html'), out);
console.log(`index.html: ${(out.length / 1024).toFixed(0)} KB${missing.length ? ' · missing: ' + missing.join(', ') : ''}`);
