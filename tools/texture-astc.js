// Compresses layout's cached textures to ASTC, the phone GPU's own format, so the page holds them
// at a quarter to a ninth of the memory and needn't decode them or build their mipmaps (Claude,
// 2026-11-06; Ken: Layout should compress textures).
//   node tools/texture-astc.js < list    the JSON the server pipes in: astcJob's, one a texture
//   node tools/texture-astc.js --all     every .astcm cache/materials.json names that is missing,
//                                        and those it no longer names deleted
// Each is made at the size the game draws it (its .meta's, tools/guid-index.js gameSize), at most
// 4096: from the capped PNG in cache/textures when that is enough, else from the texture's source.
// The name, in cache/textures beside that PNG, ends in that size and how the page reads it:
// -g1024-s.astcm a color, -l.astcm linear data, -n.astcm a normal map, and o
// after s or l where nothing reads its alpha, which is then dropped. tools/scene.js
// (prepareMaterials) names them and lists what is missing; the server runs this in the background
// after a load, at low priority, and the page draws the PNG until the next load finds the .astcm.
// Each mipmap level is made here, as WebGL's generateMipmap would (averaged, in linear light for a
// color), upside down for GL, and encoded by Arm's astcenc (setup.sh builds it): 6x6 blocks (3.56
// bits a pixel) for an opaque texture, 4x4 (8 bits) for a normal map or anything whose alpha is
// read, since a cutout's edge and a normal's direction show the loss most. The file: "LTA1", then uint32 little
// endian level count, block width, block height, each level's width, height and size, then each
// level's blocks.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);

const TEXTURES = path.join(__dirname, '..', 'cache', 'textures');
const ASTCENC = path.join(process.env.HOME, '.local', 'share', 'devenv-tools', 'bin', 'astcenc');
const WORKERS = Math.max(1, os.cpus().length - 2); // leaves room for the browser during a load

// Shaders that never read a texture's alpha on an opaque material (Ken, 2026-11-07: ditch it): the
// rock's Splinters_albedo has one, as smoothness for Unity's old shader, and 4x4 blocks to hold it.
const NO_ALPHA_SHADERS = new Set(['Canopy/General', 'Canopy/GlowLit']);
const MAX_SIZE = 4096;
// What to make for a texture in a material's slot: source its cached PNG, t the slot's texture, d
// the material, entry its guid-index entry.
function astcJob(source, slot, t, d, entry) {
  const normal = slot.startsWith('normal');
  const noAlpha = !d.cutout && !d.transparent && NO_ALPHA_SHADERS.has(d.shaderName);
  const size = Math.min(MAX_SIZE, (entry && entry.gameSize) || 1024);
  return { source, guid: t.guid, size, astc: source.replace(/\.\w+$/, `-g${size}-${normal ? 'n' : (t.srgb === false ? 'l' : 's') + (noAlpha ? 'o' : '')}.astcm`) };
}

const toLinear = Float32Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
});
const toSrgb = c => Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));

// A texture's RGBA pixels at no more than size on a side, bottom row first: GL's row 0 is v = 0.
async function read(file, size) {
  const fit = ['-resize', `${size}x${size}>`];
  const { stdout: dims } = await execFile('magick', [file + '[0]', ...fit, '-format', '%w %h', 'info:']);
  const [w, h] = dims.split(' ').map(Number);
  const { stdout: top } = await execFile('magick', [file + '[0]', ...fit, '-depth', '8', 'rgba:-'], { encoding: 'buffer', maxBuffer: 1 << 30 });
  const data = Buffer.alloc(top.length);
  for (let y = 0; y < h; y++) top.copy(data, (h - 1 - y) * w * 4, y * w * 4, (y + 1) * w * 4);
  return { w, h, data };
}

// The next mipmap level: each pixel the average of the 2 x 2 under it, in linear light for a color.
function shrink({ w, h, data }, color) {
  const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1), out = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const rows = [Math.min(2 * y, h - 1) * w, Math.min(2 * y + 1, h - 1) * w];
    for (let x = 0; x < nw; x++) {
      const at = [rows[0] + 2 * x, rows[0] + Math.min(2 * x + 1, w - 1), rows[1] + 2 * x, rows[1] + Math.min(2 * x + 1, w - 1)].map(i => i * 4);
      const to = (y * nw + x) * 4;
      for (let c = 0; c < 3; c++) {
        out[to + c] = color
          ? toSrgb((toLinear[data[at[0] + c]] + toLinear[data[at[1] + c]] + toLinear[data[at[2] + c]] + toLinear[data[at[3] + c]]) / 4)
          : (data[at[0] + c] + data[at[1] + c] + data[at[2] + c] + data[at[3] + c] + 2) >> 2;
      }
      out[to + 3] = (data[at[0] + 3] + data[at[1] + 3] + data[at[2] + 3] + data[at[3] + 3] + 2) >> 2;
    }
  }
  return { w: nw, h: nh, data: out };
}

// An uncompressed 32-bit TGA, rows in the order given, for astcenc to read.
function tga({ w, h, data }) {
  const out = Buffer.alloc(18 + data.length);
  out[2] = 2;
  out.writeUInt16LE(w, 12);
  out.writeUInt16LE(h, 14);
  out[16] = 32;
  out[17] = 0x28; // top row first, 8 bits of alpha
  for (let i = 0; i < data.length; i += 4) {
    out[18 + i] = data[i + 2];
    out[18 + i + 1] = data[i + 1];
    out[18 + i + 2] = data[i];
    out[18 + i + 3] = data[i + 3];
  }
  return out;
}

async function encode({ source, guid, size, astc }, temp) {
  const dest = path.join(TEXTURES, astc);
  if (fs.existsSync(dest)) return 0;
  const [, kind, noAlpha] = /-([sln])(o?)\.astcm$/.exec(astc), color = kind === 's';
  // The PNG holds all of it unless it was capped below the game's size. In a process of its own:
  // decoding a 4096 px source takes seconds, and the other workers go on meanwhile.
  let file = path.join(TEXTURES, source);
  const { stdout: largest } = await execFile('magick', ['identify', '-format', '%[fx:max(w,h)]', file + '[0]']);
  const stored = path.join(temp, `${astc}.png`);
  if (size > +largest && +largest === +/^[^-]+-(\d+)/.exec(source)[1]) {
    await execFile(process.execPath, [__filename, '--store', guid, String(size), stored], { maxBuffer: 1 << 24 });
    file = stored;
  }
  let level = await read(file, size);
  fs.rmSync(stored, { force: true });
  if (noAlpha || kind === 'n') for (let i = 3; i < level.data.length; i += 4) level.data[i] = 255;
  let opaque = true;
  for (let i = 3; i < level.data.length && opaque; i += 4) opaque = level.data[i] === 255;
  const block = kind === 'n' || !opaque ? 4 : 6;
  const levels = [];
  for (let n = 0; ; n++) {
    const input = path.join(temp, `${astc}-${n}.tga`), output = path.join(temp, `${astc}-${n}.astc`);
    fs.writeFileSync(input, tga(level));
    await execFile(ASTCENC, [color ? '-cs' : '-cl', input, output, `${block}x${block}`, '-medium', '-j', '1', '-silent']);
    const blocks = fs.readFileSync(output).subarray(16); // past the .astc header
    if (blocks.length !== Math.ceil(level.w / block) * Math.ceil(level.h / block) * 16) throw new Error(`${astc}: level ${n} is the wrong size`);
    levels.push({ w: level.w, h: level.h, blocks });
    fs.unlinkSync(input);
    fs.unlinkSync(output);
    if (level.w === 1 && level.h === 1) break;
    level = shrink(level, color);
  }
  const head = Buffer.alloc(16 + levels.length * 12);
  head.write('LTA1', 0, 'latin1');
  head.writeUInt32LE(levels.length, 4);
  head.writeUInt32LE(block, 8);
  head.writeUInt32LE(block, 12);
  levels.forEach((l, i) => {
    head.writeUInt32LE(l.w, 16 + i * 12);
    head.writeUInt32LE(l.h, 20 + i * 12);
    head.writeUInt32LE(l.blocks.length, 24 + i * 12);
  });
  const packed = Buffer.concat([head, ...levels.map(l => l.blocks)]), part = `${dest}.${process.pid}.part`;
  fs.writeFileSync(part, packed);
  fs.renameSync(part, dest); // whole or not there, if this is stopped
  return packed.length;
}

// What cache/materials.json names, for --all.
function missing() {
  const materials = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'materials.json'), 'utf8'));
  const index = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'guid-index.json'), 'utf8')).entries;
  const list = new Map();
  for (const m of Object.values(materials)) for (const slot of Object.keys(m)) {
    const t = m[slot];
    if (!t || !t.url || !t.url.startsWith('textures/')) continue;
    const source = t.url.slice('textures/'.length), job = astcJob(source, slot, t, m, index[t.guid]);
    if (t.guid && fs.existsSync(path.join(TEXTURES, source))) list.set(job.astc, job);
  }
  for (const f of fs.readdirSync(TEXTURES)) if (f.endsWith('.astcm') && !list.has(f)) fs.unlinkSync(path.join(TEXTURES, f));
  return [...list.values()];
}

async function main() {
  if (!fs.existsSync(ASTCENC)) return console.error('texture-astc: no astcenc; run setup.sh. The page draws PNGs meanwhile.');
  const list = process.argv.includes('--all') ? missing() : JSON.parse(fs.readFileSync(0, 'utf8'));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'astc-'));
  const started = Date.now();
  let next = 0, made = 0, bytes = 0;
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    while (next < list.length) {
      const job = list[next++];
      try {
        const size = await encode(job, temp);
        if (size) {
          made++;
          bytes += size;
        }
      } catch (error) {
        console.error(`texture-astc: ${job.astc}: ${error.message.split('\n')[0]}`);
      }
    }
  }));
  fs.rmSync(temp, { recursive: true, force: true });
  if (made) console.log(`texture-astc: ${made} textures in ${((Date.now() - started) / 1000).toFixed(1)} s, ${(bytes / 1048576).toFixed(0)} MB`);
}

module.exports = { astcJob };
if (require.main === module) {
  const [, , mode, guid, size, dest] = process.argv;
  if (mode === '--store') {
    const S = require('./scene.js'), t = S.textureSource(guid); // scene.js requires this file
    S.storeTexture(t.data, t.ext, dest, +size, t.alpha, t.fromGray);
  } else main();
}
