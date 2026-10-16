// Pintar zonas de un modelo: pincel, relleno que se frena en las aristas vivas, el detector de
// esas aristas y el refinado de la malla para pintar más fino.
//
// La tolerancia es un ángulo: una arista cuyas dos caras se doblan más que eso es una arista
// "viva" (el canto de una caja, el borde de una letra en relieve) y corta el relleno; una que se
// dobla menos (las facetas de un cilindro) se cruza.
//
// Las funciones que pintan cambian `obj.colors` en el lugar y devuelven qué cambiaron
// ({ triangles, before }), para deshacer. Las demás no cambian nada.
//
// Puro: no importa three ni el DOM.

import { dihedral } from './mesh.js';
import { MAX_TRIANGLES } from './config.js';

/** @typedef {import('./threemf.js').ModelObject} ModelObject */
/** @typedef {import('./mesh.js').Topology} Topology */
/** @typedef {{ triangles: Int32Array, before: Int32Array, color: number }} PaintChange */

/** La distancia al cuadrado de un punto a un triángulo (Ericson, Real-Time Collision Detection 5.1.5). */
export function dist2PointTriangle(/** @type {number[]} */ p, /** @type {ArrayLike<number>} */ P, /** @type {number} */ ia, /** @type {number} */ ib, /** @type {number} */ ic) {
  const ax = P[ia], ay = P[ia + 1], az = P[ia + 2];
  const abx = P[ib] - ax, aby = P[ib + 1] - ay, abz = P[ib + 2] - az;
  const acx = P[ic] - ax, acy = P[ic + 1] - ay, acz = P[ic + 2] - az;
  const apx = p[0] - ax, apy = p[1] - ay, apz = p[2] - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  /** @param {number} x @param {number} y @param {number} z */
  const d = (x, y, z) => { const dx = p[0] - x, dy = p[1] - y, dz = p[2] - z; return dx * dx + dy * dy + dz * dz; };
  if (d1 <= 0 && d2 <= 0) return d(ax, ay, az);
  const bpx = p[0] - P[ib], bpy = p[1] - P[ib + 1], bpz = p[2] - P[ib + 2];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return d(P[ib], P[ib + 1], P[ib + 2]);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return d(ax + v * abx, ay + v * aby, az + v * abz); }
  const cpx = p[0] - P[ic], cpy = p[1] - P[ic + 1], cpz = p[2] - P[ic + 2];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return d(P[ic], P[ic + 1], P[ic + 2]);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return d(ax + w * acx, ay + w * acy, az + w * acz); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return d(P[ib] + w * (P[ic] - P[ib]), P[ib + 1] + w * (P[ic + 1] - P[ib + 1]), P[ib + 2] + w * (P[ic + 2] - P[ib + 2]));
  }
  const den = 1 / (va + vb + vc);
  const v = vb * den, w = vc * den;
  return d(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

/**
 * Recorre desde `seed` los triángulos que cumplen `accept`, cruzando solo las aristas que deja
 * `cross`, y los pinta de `color`.
 * @param {ModelObject} obj @param {Topology} topo @param {number} seed @param {number} color
 * @param {(t: number) => boolean} accept @param {(t: number, u: number) => boolean} cross
 * @returns {PaintChange}
 */
function inundar(obj, topo, seed, color, accept, cross) {
  if (!Number.isInteger(seed) || seed < 0 || seed >= topo.triangleCount) throw new RangeError(`triángulo inválido: ${seed}`);
  /** @type {number[]} */
  const vistos = [seed];
  const marca = new Uint8Array(topo.triangleCount);
  marca[seed] = 1;
  /** @type {number[]} */
  const cambiados = [];
  /** @type {number[]} */
  const antes = [];
  for (let k = 0; k < vistos.length; k++) {
    const t = vistos[k];
    if (!accept(t)) continue;
    if (obj.colors[t] !== color) { cambiados.push(t); antes.push(obj.colors[t]); obj.colors[t] = color; }
    for (let e = 0; e < 3; e++) {
      const u = topo.neighbors[t * 3 + e];
      if (u < 0 || marca[u] || !cross(t, u)) continue;
      marca[u] = 1;
      vistos.push(u);
    }
  }
  return { triangles: Int32Array.from(cambiados), before: Int32Array.from(antes), color };
}

/**
 * El pincel: pinta los triángulos a menos de `radius` del punto, alcanzables desde `seed` por la
 * superficie (no salta a una pared de atrás). Con `angle`, tampoco cruza aristas más vivas que
 * eso: pinta una cara sin pasarse al canto.
 * @param {ModelObject} obj @param {Topology} topo
 * @param {{ triangle: number, point: number[], radius: number, color: number, angle?: number | null, only?: number | null }} spec
 *   only: pintar solo encima de ese color
 * @returns {PaintChange}
 */
export function brush(obj, topo, { triangle, point, radius, color, angle = null, only = null }) {
  const r2 = radius * radius, P = obj.positions, ix = obj.indices;
  return inundar(obj, topo, triangle, color,
    (t) => (only === null || obj.colors[t] === only || obj.colors[t] === color) && dist2PointTriangle(point, P, ix[t * 3] * 3, ix[t * 3 + 1] * 3, ix[t * 3 + 2] * 3) <= r2,
    (t, u) => angle === null || dihedral(topo, t, u) <= angle);
}

/**
 * El relleno: pinta desde `seed` todo lo que se alcanza sin cruzar una arista más viva que
 * `angle` (grados). Con `sameColor` (por defecto) tampoco cruza a otro color: rellena la zona
 * donde se hizo clic, como el balde de un programa de dibujo.
 * @param {ModelObject} obj @param {Topology} topo
 * @param {{ triangle: number, color: number, angle: number, sameColor?: boolean }} spec
 * @returns {PaintChange}
 */
export function fill(obj, topo, { triangle, color, angle, sameColor = true }) {
  const desde = obj.colors[triangle];
  return inundar(obj, topo, triangle, color,
    () => true,
    (t, u) => dihedral(topo, t, u) <= angle && (!sameColor || obj.colors[u] === desde));
}

/**
 * La zona que pintaría `fill`, sin pintarla: para mostrarla bajo el cursor antes del clic.
 * @param {ModelObject} obj @param {Topology} topo @param {{ triangle: number, angle: number, sameColor?: boolean }} spec
 * @returns {Int32Array}
 */
export function fillPreview(obj, topo, { triangle, angle, sameColor = true }) {
  const copia = { ...obj, colors: Int32Array.from(obj.colors) };
  return fill(copia, topo, { triangle, color: -2, angle, sameColor }).triangles;
}

/** Deshace un cambio de pintura (en el lugar). @param {ModelObject} obj @param {PaintChange} change */
export function revert(obj, change) {
  for (let i = 0; i < change.triangles.length; i++) obj.colors[change.triangles[i]] = change.before[i];
}
/** Lo vuelve a hacer. @param {ModelObject} obj @param {PaintChange} change */
export function reapply(obj, change) {
  for (let i = 0; i < change.triangles.length; i++) obj.colors[change.triangles[i]] = change.color;
}

/**
 * El detector de aristas: las aristas cuyas caras se doblan más que `angle` grados (y, con
 * `colors`, también las que separan dos colores), como segmentos x, y, z, x, y, z… para dibujar.
 * @param {ModelObject} obj @param {Topology} topo @param {{ angle: number, colors?: boolean }} spec
 * @returns {{ sharp: Float32Array, color: Float32Array }}
 */
export function edges(obj, topo, { angle, colors = false }) {
  /** @type {number[]} */
  const vivas = [];
  /** @type {number[]} */
  const deColor = [];
  const P = obj.positions, ix = obj.indices;
  for (let t = 0; t < topo.triangleCount; t++) {
    for (let e = 0; e < 3; e++) {
      const u = topo.neighbors[t * 3 + e];
      if (u >= 0 && u < t) continue; // cada arista una vez
      const a = ix[t * 3 + e] * 3, b = ix[t * 3 + ((e + 1) % 3)] * 3;
      const seg = [P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2]];
      if (u < 0 || dihedral(topo, t, u) > angle) vivas.push(...seg);
      else if (colors && obj.colors[t] !== obj.colors[u]) deColor.push(...seg);
    }
  }
  return { sharp: Float32Array.from(vivas), color: Float32Array.from(deColor) };
}

/**
 * Refina la malla para pintar fino: parte por la mitad cada arista más larga que `maxEdge`
 * (la misma decisión a los dos lados de la arista, así no quedan vértices colgados) hasta que
 * ninguna lo sea. Cada triángulo nuevo hereda el color del que salió. La forma no cambia.
 * @param {ModelObject} obj @param {number} maxEdge
 * @param {{ maxTriangles?: number }} [opts]
 * @returns {ModelObject}
 */
export function refine(obj, maxEdge, { maxTriangles = MAX_TRIANGLES } = {}) {
  if (!(maxEdge > 0)) throw new RangeError(`largo inválido: ${maxEdge}`);
  let pos = Array.from(obj.positions), idx = Array.from(obj.indices), col = Array.from(obj.colors);
  const max2 = maxEdge * maxEdge;
  for (let pasada = 0; pasada < 24; pasada++) {
    /** @type {Map<string, number>} */
    const medios = new Map();
    /** @param {number} a @param {number} b */
    const largo2 = (a, b) => (pos[a * 3] - pos[b * 3]) ** 2 + (pos[a * 3 + 1] - pos[b * 3 + 1]) ** 2 + (pos[a * 3 + 2] - pos[b * 3 + 2]) ** 2;
    /** @param {number} a @param {number} b */
    const medio = (a, b) => {
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      let m = medios.get(k);
      if (m === undefined) {
        m = pos.length / 3;
        pos.push((pos[a * 3] + pos[b * 3]) / 2, (pos[a * 3 + 1] + pos[b * 3 + 1]) / 2, (pos[a * 3 + 2] + pos[b * 3 + 2]) / 2);
        medios.set(k, m);
      }
      return m;
    };
    /** @type {number[]} */
    const nIdx = [];
    /** @type {number[]} */
    const nCol = [];
    let partidos = 0;
    const T = idx.length / 3;
    for (let t = 0; t < T; t++) {
      const v = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]];
      const largo = [0, 1, 2].map((e) => largo2(v[e], v[(e + 1) % 3]) > max2);
      const n = largo.filter(Boolean).length;
      const c = col[t];
      /** @param {number} a @param {number} b @param {number} d */
      const tri = (a, b, d) => { nIdx.push(a, b, d); nCol.push(c); };
      if (n === 0) { tri(v[0], v[1], v[2]); continue; }
      partidos++;
      if (n === 3) {
        const m0 = medio(v[0], v[1]), m1 = medio(v[1], v[2]), m2 = medio(v[2], v[0]);
        tri(v[0], m0, m2); tri(m0, v[1], m1); tri(m1, v[2], m2); tri(m0, m1, m2);
      } else if (n === 1) {
        const e = largo.indexOf(true);
        const a = v[e], b = v[(e + 1) % 3], d = v[(e + 2) % 3];
        const m = medio(a, b);
        tri(a, m, d); tri(m, b, d);
      } else {
        // dos lados largos: el que queda corto es el "especial"
        const e = largo.indexOf(false);
        const a = v[e], b = v[(e + 1) % 3], d = v[(e + 2) % 3];
        const mbd = medio(b, d), mda = medio(d, a);
        tri(a, b, mbd); tri(a, mbd, mda); tri(mbd, d, mda);
      }
    }
    idx = nIdx;
    col = nCol;
    if (!partidos) break;
    if (idx.length / 3 > maxTriangles) throw new RangeError(`refinar a ${maxEdge} mm deja más de ${maxTriangles} triángulos: probá con un largo mayor`);
  }
  return { name: obj.name, positions: Float64Array.from(pos), indices: Uint32Array.from(idx), colors: Int32Array.from(col) };
}
