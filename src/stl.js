// STL: leer (binario o ASCII) y escribir (binario). Un STL no tiene color: entra de un solo
// color y se pinta en la app.
//
// Puro: no importa three ni el DOM.

import { weld } from './mesh.js';

/**
 * @param {ArrayBuffer | Uint8Array} data @param {{ name?: string }} [opts]
 * @returns {import('./threemf.js').Model}
 */
export function readStl(data, { name = 'modelo.stl' } = {}) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  /** @type {number[]} */
  const pos = [];
  const n = bytes.length >= 84 ? dv.getUint32(80, true) : -1;
  if (n >= 0 && 84 + n * 50 === bytes.length) {
    for (let t = 0; t < n; t++) {
      const o = 84 + t * 50 + 12;
      for (let k = 0; k < 9; k++) pos.push(dv.getFloat32(o + k * 4, true));
    }
  } else {
    const txt = new TextDecoder().decode(bytes);
    if (!/^\s*solid/i.test(txt)) throw new TypeError('STL inválido: ni binario ni ASCII');
    const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
    /** @type {RegExpExecArray | null} */
    let m;
    while ((m = re.exec(txt))) pos.push(+m[1], +m[2], +m[3]);
    if (pos.length % 9) throw new TypeError('STL inválido: un triángulo no tiene tres vértices');
  }
  if (!pos.length) throw new TypeError('STL vacío');
  const T = pos.length / 9;
  const obj = weld({
    name: name.replace(/\.[^.]+$/, ''),
    positions: Float64Array.from(pos), indices: Uint32Array.from({ length: T * 3 }, (_, i) => i), colors: new Int32Array(T),
  });
  return { unit: 'mm', palette: [{ key: 'none', color: '#d9d9d9', name: 'Base', filament: 1 }], objects: [obj], source: name, warnings: [] };
}

/**
 * Un STL binario.
 * @param {{ positions: ArrayLike<number>, indices: ArrayLike<number> }} mesh @param {string} [title]
 * @returns {Uint8Array}
 */
export function writeStl(mesh, title = '3d-print-separator-tool') {
  const T = mesh.indices.length / 3, p = mesh.positions, ix = mesh.indices;
  const out = new Uint8Array(84 + T * 50);
  const dv = new DataView(out.buffer);
  out.set(new TextEncoder().encode(title.slice(0, 79)), 0);
  dv.setUint32(80, T, true);
  for (let t = 0; t < T; t++) {
    const o = 84 + t * 50;
    const a = ix[t * 3] * 3, b = ix[t * 3 + 1] * 3, c = ix[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const m = Math.hypot(nx, ny, nz) || 1;
    nx /= m; ny /= m; nz /= m;
    [nx, ny, nz, p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2], p[c], p[c + 1], p[c + 2]].forEach((v, k) => dv.setFloat32(o + k * 4, v, true));
  }
  return out;
}
