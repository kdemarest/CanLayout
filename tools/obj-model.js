// Wavefront .obj model files in the Unity project (e.g. the drill), to OBJ for the viewer.
// Unity imports an .obj by negating X; the cache stores Unity meshes with X negated back, so
// the two cancel and vertices stay as in the file, times the import scale (the .meta's Scale
// Factor; an .obj's unit is taken as the meter). All objects and groups merge into one mesh,
// polygons fanned into triangles.
function objModelToObj(text, importScale, label) {
  const v = [], vt = [], vn = [];
  const out = { v: [], vt: [], vn: [], f: [] };
  const f6 = x => +x.toFixed(6);
  // An index into one of the lists: 1-based, or negative from the end.
  const at = (list, s) => {
    if (!s) return null;
    const k = parseInt(s, 10);
    return list[k < 0 ? list.length + k : k - 1] || null;
  };
  let n = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const [kind, ...rest] = line.split(/\s+/);
    if (kind === 'v') v.push(rest.slice(0, 3).map(Number));
    else if (kind === 'vt') vt.push(rest.slice(0, 2).map(Number));
    else if (kind === 'vn') vn.push(rest.slice(0, 3).map(Number));
    else if (kind === 'f') {
      const corners = rest.map(c => {
        const [a, b, c2] = c.split('/');
        return { p: at(v, a), t: at(vt, b), n: at(vn, c2) };
      });
      if (corners.some(c => !c.p)) throw new Error(`bad face: ${line}`);
      for (let i = 1; i < corners.length - 1; i++) {
        const tri = [corners[0], corners[i], corners[i + 1]];
        const ids = [];
        for (const c of tri) {
          out.v.push('v ' + c.p.map(x => f6(x * importScale)).join(' '));
          // Every corner gets a UV and a normal if the file has any, so indices stay aligned.
          if (vt.length) out.vt.push('vt ' + (c.t || [0, 0]).map(f6).join(' '));
          if (vn.length) out.vn.push('vn ' + (c.n || [0, 1, 0]).map(f6).join(' '));
          ids.push(++n);
        }
        out.f.push('f ' + ids.map(k => `${k}/${vt.length ? k : ''}/${vn.length ? k : ''}`).join(' '));
      }
    }
  }
  if (!n) throw new Error('no faces');
  return ['# from ' + label, ...out.v, ...out.vt, ...out.vn, ...out.f].join('\n') + '\n';
}

module.exports = { objModelToObj };
