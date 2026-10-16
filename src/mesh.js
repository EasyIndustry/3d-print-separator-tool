// La malla de un objeto, como valores planos: vértices soldados, vecinos por arista, normales,
// áreas, cáscaras (las partes que no se tocan) y regiones de un mismo color.
//
// Un objeto es { name, positions, indices, colors }: `colors` es un índice de la paleta por
// triángulo. Nada de esto lo cambia: lo que cambia un objeto devuelve otro (o, en la pintura,
// devuelve qué triángulos cambió).
//
// Puro: no importa three ni el DOM.

import { WELD_TOLERANCE } from './config.js';

/** @typedef {import('./threemf.js').ModelObject} ModelObject */

/**
 * Suelda los vértices que caen en el mismo lugar (a `tol`) y saca los triángulos que quedan
 * sin área (dos vértices iguales). Sin vecinos compartidos no hay aristas, ni relleno, ni sólido.
 * @param {ModelObject} obj @param {number} [tol]
 * @returns {ModelObject}
 */
export function weld(obj, tol = WELD_TOLERANCE) {
  const p = obj.positions, ix = obj.indices;
  const n = p.length / 3;
  /** @type {Map<string, number>} */
  const lugar = new Map();
  const nuevo = new Int32Array(n);
  /** @type {number[]} */
  const pos = [];
  const q = 1 / tol;
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(p[i * 3] * q)},${Math.round(p[i * 3 + 1] * q)},${Math.round(p[i * 3 + 2] * q)}`;
    let j = lugar.get(k);
    if (j === undefined) { j = pos.length / 3; pos.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]); lugar.set(k, j); }
    nuevo[i] = j;
  }
  /** @type {number[]} */
  const idx = [];
  /** @type {number[]} */
  const col = [];
  for (let t = 0; t < ix.length / 3; t++) {
    const a = nuevo[ix[t * 3]], b = nuevo[ix[t * 3 + 1]], c = nuevo[ix[t * 3 + 2]];
    if (a === b || b === c || c === a) continue;
    idx.push(a, b, c);
    col.push(obj.colors[t]);
  }
  return { name: obj.name, positions: Float64Array.from(pos), indices: Uint32Array.from(idx), colors: Int32Array.from(col) };
}

/**
 * Lo que se sabe de cada triángulo: sus tres vecinos por arista (-1 en un borde), su normal,
 * su área y su centro. La arista e de un triángulo va de su vértice e al (e+1) % 3, y
 * `neighbors[t*3+e]` es el triángulo del otro lado.
 * @typedef {{ neighbors: Int32Array, normals: Float64Array, areas: Float64Array, centers: Float64Array, triangleCount: number }} Topology
 * @param {ModelObject} obj
 * @returns {Topology}
 */
export function topology(obj) {
  const p = obj.positions, ix = obj.indices;
  const T = ix.length / 3, V = p.length / 3;
  const neighbors = new Int32Array(T * 3).fill(-1);
  const normals = new Float64Array(T * 3), areas = new Float64Array(T), centers = new Float64Array(T * 3);
  /** @type {Map<number, number>} */
  const aristas = new Map();
  for (let t = 0; t < T; t++) {
    for (let e = 0; e < 3; e++) aristas.set(ix[t * 3 + e] * V + ix[t * 3 + ((e + 1) % 3)], t * 3 + e);
  }
  for (let t = 0; t < T; t++) {
    for (let e = 0; e < 3; e++) {
      const otra = aristas.get(ix[t * 3 + ((e + 1) % 3)] * V + ix[t * 3 + e]);
      if (otra !== undefined) neighbors[t * 3 + e] = Math.floor(otra / 3);
    }
    const a = ix[t * 3] * 3, b = ix[t * 3 + 1] * 3, c = ix[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const m = Math.hypot(nx, ny, nz);
    areas[t] = m / 2;
    if (m > 0) { normals[t * 3] = nx / m; normals[t * 3 + 1] = ny / m; normals[t * 3 + 2] = nz / m; }
    centers[t * 3] = (p[a] + p[b] + p[c]) / 3;
    centers[t * 3 + 1] = (p[a + 1] + p[b + 1] + p[c + 1]) / 3;
    centers[t * 3 + 2] = (p[a + 2] + p[b + 2] + p[c + 2]) / 3;
  }
  return { neighbors, normals, areas, centers, triangleCount: T };
}

/**
 * El ángulo (grados) entre las caras de los dos lados de una arista: 0 si siguen planas.
 * @param {Topology} topo @param {number} t @param {number} u
 */
export function dihedral(topo, t, u) {
  const n = topo.normals;
  const d = n[t * 3] * n[u * 3] + n[t * 3 + 1] * n[u * 3 + 1] + n[t * 3 + 2] * n[u * 3 + 2];
  return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
}

/**
 * Las partes conexas: triángulos que se alcanzan cruzando aristas, con un filtro opcional
 * (`same(t, u)`: ¿se puede pasar de t a u?). Devuelve, por triángulo, el número de su parte, y
 * la lista de cada parte.
 * @param {Topology} topo @param {(t: number, u: number) => boolean} [same] @param {(t: number) => boolean} [include]
 * @returns {{ of: Int32Array, groups: number[][] }}
 */
export function components(topo, same = () => true, include = () => true) {
  const T = topo.triangleCount;
  const of = new Int32Array(T).fill(-1);
  /** @type {number[][]} */
  const groups = [];
  for (let s = 0; s < T; s++) {
    if (of[s] >= 0 || !include(s)) continue;
    const g = groups.length;
    /** @type {number[]} */
    const lista = [s];
    of[s] = g;
    for (let k = 0; k < lista.length; k++) {
      const t = lista[k];
      for (let e = 0; e < 3; e++) {
        const u = topo.neighbors[t * 3 + e];
        if (u < 0 || of[u] >= 0 || !include(u) || !same(t, u)) continue;
        of[u] = g;
        lista.push(u);
      }
    }
    groups.push(lista);
  }
  return { of, groups };
}

/** Las cáscaras: las partes de la malla que no comparten aristas. @param {Topology} topo */
export const shells = (topo) => components(topo);

/**
 * Los contornos de un conjunto de triángulos: las aristas que tienen un solo lado en el
 * conjunto, encadenadas en lazos cerrados (en el sentido de los triángulos: antihorario visto
 * desde afuera para el contorno de afuera, horario para un agujero).
 * @param {ModelObject} obj @param {Topology} topo @param {Iterable<number>} tris
 * @returns {number[][]} cada lazo, como ids de vértice
 */
export function boundaryLoops(obj, topo, tris) {
  const adentro = new Set(tris);
  const ix = obj.indices;
  /** @type {Map<number, number[]>} vértice → a dónde va cada arista de borde que sale de él */
  const sale = new Map();
  let total = 0;
  for (const t of adentro) {
    for (let e = 0; e < 3; e++) {
      const u = topo.neighbors[t * 3 + e];
      if (u >= 0 && adentro.has(u)) continue;
      const a = ix[t * 3 + e], b = ix[t * 3 + ((e + 1) % 3)];
      const l = sale.get(a);
      if (l) l.push(b); else sale.set(a, [b]);
      total++;
    }
  }
  /** @type {number[][]} */
  const lazos = [];
  while (total > 0) {
    let inicio = -1;
    for (const [v, l] of sale) if (l.length) { inicio = v; break; }
    if (inicio < 0) break;
    /** @type {number[]} */
    const lazo = [];
    let v = inicio;
    for (let guarda = total + 1; guarda > 0; guarda--) {
      const l = /** @type {number[]} */ (sale.get(v));
      if (!l || !l.length) break;
      const w = /** @type {number} */ (l.pop());
      total--;
      lazo.push(v);
      v = w;
      if (v === inicio) break;
    }
    if (lazo.length >= 3) lazos.push(lazo);
  }
  return lazos;
}

/**
 * Una submalla: los triángulos pedidos, con sus vértices renumerados.
 * @param {ModelObject} obj @param {Iterable<number>} tris
 * @returns {{ positions: Float64Array, indices: Uint32Array }}
 */
export function submesh(obj, tris) {
  /** @type {Map<number, number>} */
  const nuevo = new Map();
  /** @type {number[]} */
  const pos = [];
  /** @type {number[]} */
  const idx = [];
  for (const t of tris) {
    for (let e = 0; e < 3; e++) {
      const v = obj.indices[t * 3 + e];
      let j = nuevo.get(v);
      if (j === undefined) { j = pos.length / 3; pos.push(obj.positions[v * 3], obj.positions[v * 3 + 1], obj.positions[v * 3 + 2]); nuevo.set(v, j); }
      idx.push(j);
    }
  }
  return { positions: Float64Array.from(pos), indices: Uint32Array.from(idx) };
}

/** El volumen que encierra una malla cerrada (positivo si mira hacia afuera). @param {{ positions: ArrayLike<number>, indices: ArrayLike<number> }} m */
export function volumeOf(m) {
  const p = m.positions, ix = m.indices;
  let v = 0;
  for (let k = 0; k < ix.length; k += 3) {
    const a = ix[k] * 3, b = ix[k + 1] * 3, c = ix[k + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

/** La caja { min, max } de unas posiciones. @param {ArrayLike<number>} p */
export function boundsOf(p) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) { if (p[i + k] < min[k]) min[k] = p[i + k]; if (p[i + k] > max[k]) max[k] = p[i + k]; }
  }
  return { min, max };
}

/**
 * Varios objetos en uno (cada uno sigue siendo su cáscara): para separar juntas las partes que
 * vinieron como objetos sueltos.
 * @param {ModelObject[]} objects @param {string} [name]
 * @returns {ModelObject}
 */
export function mergeObjects(objects, name = 'Todo junto') {
  const V = objects.reduce((s, o) => s + o.positions.length, 0), I = objects.reduce((s, o) => s + o.indices.length, 0);
  const positions = new Float64Array(V), indices = new Uint32Array(I), colors = new Int32Array(I / 3);
  let v = 0, i = 0;
  for (const o of objects) {
    positions.set(o.positions, v);
    for (let k = 0; k < o.indices.length; k++) indices[i + k] = o.indices[k] + v / 3;
    colors.set(o.colors, i / 3);
    v += o.positions.length;
    i += o.indices.length;
  }
  return { name, positions, indices, colors };
}
