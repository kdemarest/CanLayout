// The game's text ids, from Assets/Resources/Text/English.txt: "<Id>" lines, each followed by
// its text, grouped under divider lines such as "<----------LORE-------------->".
// Read from the Canopy working tree if present (uncommitted edits), else fetched by blob id.
const fs = require('fs');
const path = require('path');

const FILE = 'Assets/Resources/Text/English.txt';

// -> [{ id, section, preview }] in file order; preview is the text's first line.
function parseTexts(text) {
  const out = [];
  let section = '', current = null;
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const m = /^<([^<>]+)>\s*$/.exec(raw);
    if (m && /^[=-]/.test(m[1])) {
      section = m[1].replace(/^[=-]+|[=-]+$/g, '').replace(/-/g, ' ');
      current = null;
    } else if (m) {
      current = { id: m[1].trim(), section, preview: '' };
      out.push(current);
    } else if (current && !current.preview && raw.trim()) {
      current.preview = raw.trim().replace(/^#\s*/, '').slice(0, 80);
    }
  }
  return out;
}

function loadTexts(repo, index, blobs) {
  const local = path.join(repo, FILE);
  if (fs.existsSync(local)) return parseTexts(fs.readFileSync(local, 'utf8'));
  const entry = Object.values(index).find(e => e.path === FILE);
  if (!entry || !entry.blob) throw new Error(`${FILE} is not in the guid index`);
  const data = blobs([entry.blob]).get(entry.blob);
  if (!data) throw new Error(`could not fetch ${FILE}`);
  return parseTexts(data.toString());
}

module.exports = { FILE, parseTexts, loadTexts };
