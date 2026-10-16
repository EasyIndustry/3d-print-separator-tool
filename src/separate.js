// Separar por color: cada color de un objeto pasa a ser un sólido que se imprime aparte y se
// encastra en la pieza de al lado con una extrusión terminada en cono.
//
// Hay dos casos, y terminan en lo mismo:
//
// - **Una zona pintada** (un logo, una letra, una cara de otro color en una malla de una sola
//   pieza). La zona es una superficie, no un volumen: el color se vuelve sólido extruyendo su
//   contorno hacia adentro `depth` mm (el "incrustado"), y la pieza de base pierde ese volumen.
// - **Una parte** (un 3MF de Bambu, Orca o Prusa con un sólido por color, que se tocan o se
//   meten uno en otro). Lo que se mete se le quita a la más grande, y el contacto es la cara de
//   la chica que apoya en la grande.
//
// En los dos, desde la cara que toca la otra pieza sale la **extrusión**: el contorno del color,
// achicado `inset`, extruido `length` mm hacia adentro de la otra pieza y terminado en un cono de
// `cone` mm cuya punta es `tip` veces la base (0: una punta). La otra pieza recibe el
// alojamiento: la misma forma agrandada `clearance` por lado. Así cada color se imprime solo, sin
// cambio de filamento, y se encastra centrándose por el cono.
//
// Las booleanas no se escriben acá: las hace un **kernel** que pasa la app (ver
// adapters/manifold/kernel.js), con mallas y polígonos como valores planos:
//   union(a, b), subtract(a, b), intersect(a, b)   mallas { positions, indices } → malla
//   extrude(rings, height, scaleTop)               polígonos [[x, y], …] (relleno positivo) → malla, de z 0 a height
//   offset(rings, delta)                           polígonos agrandados (delta > 0) o achicados
//   area(rings)                                    el área encerrada
//
// Puro: no importa three ni el DOM.

import { topology, components, boundaryLoops, submesh, volumeOf, weld, boundsOf } from './mesh.js';
import { dist2PointTriangle } from './paint.js';
import { SEPARATION_DEFAULTS, SEPARATION_LIMITS, MIN_ZONE_AREA, MIN_SHELL_VOLUME } from './config.js';

/** @typedef {import('./threemf.js').ModelObject} ModelObject */
/** @typedef {import('./threemf.js').PaletteEntry} PaletteEntry */
/** @typedef {{ positions: ArrayLike<number>, indices: ArrayLike<number> }} MeshLike */
/** @typedef {Array<Array<[number, number]>>} Rings */
/**
 * @typedef {{
 *   union: (a: MeshLike, b: MeshLike) => MeshLike, subtract: (a: MeshLike, b: MeshLike) => MeshLike, intersect: (a: MeshLike, b: MeshLike) => MeshLike,
 *   extrude: (rings: Rings, height: number, scaleTop?: number) => MeshLike, offset: (rings: Rings, delta: number) => Rings, area: (rings: Rings) => number,
 * }} Kernel
 */
/** @typedef {typeof SEPARATION_DEFAULTS} SeparationParams */
/**
 * Una pieza separada. `role`: 'base' (no se encastra en nada), 'inlay' (una zona pintada vuelta
 * sólido) o 'part' (una parte encastrada en otra). `direction` es por dónde sale de su pieza
 * madre (`parent`, un índice de `pieces`, o -1): la vista la separa en esa dirección.
 * @typedef {{ name: string, color: number, role: 'base' | 'inlay' | 'part', parent: number, direction: [number, number, number],
 *   positions: Float64Array, indices: Uint32Array, volume: number }} Piece
 */

const EPS = 0.02; // lo que se solapan las booleanas para no dejar caras coincidentes (mm)
const MIN_AREA = 0.05; // un contorno de menos de esto (mm²) no encierra nada
const SILUETA = 0.5; // una cara vecina cuya normal se aparta más que esto (coseno) es el canto del objeto
const SOBRANTE = 0.8; // cuánto pasa el prisma de un color el canto del objeto (mm)

/** @param {Partial<SeparationParams>} p @returns {SeparationParams} */
export function checkParams(p = {}) {
  /** @type {Record<string, number>} */
  const r = { ...SEPARATION_DEFAULTS };
  for (const [k, v] of Object.entries(p)) {
    if (!Object.hasOwn(SEPARATION_LIMITS, k)) throw new TypeError(`parámetro desconocido: ${k} (van ${Object.keys(SEPARATION_LIMITS).join(', ')})`);
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${k} inválido: ${String(v)} (va un número)`);
    const l = SEPARATION_LIMITS[/** @type {keyof typeof SEPARATION_LIMITS} */ (k)];
    r[k] = Math.min(l.max, Math.max(l.min, v));
  }
  return /** @type {SeparationParams} */ (r);
}

// ---------- vectores ----------
/** @typedef {[number, number, number]} V3 */
const dot = (/** @type {V3} */ a, /** @type {V3} */ b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (/** @type {V3} */ a, /** @type {V3} */ b) => /** @type {V3} */ ([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]);
const unit = (/** @type {V3} */ a) => { const m = Math.hypot(...a) || 1; return /** @type {V3} */ ([a[0] / m, a[1] / m, a[2] / m]); };
/** Dos ejes perpendiculares a n, con (u, v, n) de mano derecha. @param {V3} n */
function basis(n) {
  const a = /** @type {V3} */ (Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
  const u = unit(cross(a, n));
  return { u, v: cross(n, u) };
}

/**
 * Lleva una malla de su marco (x, y, z) al mundo: origen + x·U + y·V + z·N.
 * @param {MeshLike} m @param {V3} o @param {V3} U @param {V3} V @param {V3} N
 * @returns {MeshLike}
 */
function place(m, o, U, V, N) {
  const p = m.positions;
  const out = new Float64Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    out[i] = o[0] + x * U[0] + y * V[0] + z * N[0];
    out[i + 1] = o[1] + x * U[1] + y * V[1] + z * N[1];
    out[i + 2] = o[2] + x * U[2] + y * V[2] + z * N[2];
  }
  return { positions: out, indices: m.indices };
}

/** El centro de área de unos polígonos. @param {Rings} rings */
function centroid(rings) {
  let A = 0, cx = 0, cy = 0;
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      const [x0, y0] = r[i], [x1, y1] = r[(i + 1) % r.length];
      const c = x0 * y1 - x1 * y0;
      A += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c;
    }
  }
  if (Math.abs(A) < 1e-12) return [0, 0];
  return [cx / (3 * A), cy / (3 * A)];
}

/**
 * Una extrusión con cono, en el mundo: los polígonos (en el plano u, v) extruidos desde la altura
 * `h0` (sobre n) en el sentido `s·n` (s = ±1): `length` recto y `cone` en punta hasta `tip`.
 * @param {Kernel} K @param {Rings} rings @param {{ u: V3, v: V3, n: V3, h0: number, s: 1 | -1 }} f
 * @param {{ length: number, cone: number, tip: number, back: number }} d back: cuánto arranca antes de h0 (para solapar)
 * @returns {MeshLike | null}
 */
function plugSolid(K, rings, f, { length, cone, tip, back }) {
  if (!rings.length || length + cone <= 0) return null;
  const [cx, cy] = centroid(rings);
  // centrado en su centro: el cono se achica hacia ahí. Con s = -1 se espeja v (y se dan vuelta los
  // lazos) para que el marco (u, -v, -n) siga siendo de mano derecha y la extrusión vaya hacia -n.
  const r2 = rings.map((r) => {
    const q = r.map(([x, y]) => /** @type {[number, number]} */ ([x - cx, f.s > 0 ? y - cy : -(y - cy)]));
    return f.s > 0 ? q : q.reverse();
  });
  const U = f.u, V = f.s > 0 ? f.v : /** @type {V3} */ ([-f.v[0], -f.v[1], -f.v[2]]), N = f.s > 0 ? f.n : /** @type {V3} */ ([-f.n[0], -f.n[1], -f.n[2]]);
  /** @param {number} h altura sobre n */
  const origen = (h) => /** @type {V3} */ ([0, 1, 2].map((k) => f.n[k] * h + f.u[k] * cx + f.v[k] * cy));
  /** @type {MeshLike | null} */
  let sol = null;
  const recto = length + back;
  if (recto > 0) sol = place(K.extrude(r2, recto, 1), origen(f.h0 - f.s * back), U, V, N);
  if (cone > 0) {
    // el cono arranca justo donde termina lo recto: manifold une bien dos sólidos que comparten una cara
    const punta = place(K.extrude(r2, cone, tip), origen(f.h0 + f.s * length), U, V, N);
    sol = sol ? K.union(sol, punta) : punta;
  }
  return sol;
}

/**
 * Los contornos de unos triángulos, en el plano (u, v) de su normal media.
 * @param {ModelObject} obj @param {import('./mesh.js').Topology} topo @param {number[]} tris
 */
function footprint(obj, topo, tris) {
  /** @type {V3} */
  let n = [0, 0, 0];
  let area = 0;
  for (const t of tris) {
    const a = topo.areas[t];
    area += a;
    n = [n[0] + topo.normals[t * 3] * a, n[1] + topo.normals[t * 3 + 1] * a, n[2] + topo.normals[t * 3 + 2] * a];
  }
  const largo = Math.hypot(...n);
  const planitud = area > 0 ? largo / area : 0; // 1: plana; cerca de 0: se da vuelta (un anillo, una esfera)
  n = unit(n);
  const { u, v } = basis(n);
  const P = obj.positions;
  let hMin = Infinity, hMax = -Infinity;
  for (const t of tris) {
    for (let e = 0; e < 3; e++) {
      const i = obj.indices[t * 3 + e] * 3;
      const h = P[i] * n[0] + P[i + 1] * n[1] + P[i + 2] * n[2];
      if (h < hMin) hMin = h;
      if (h > hMax) hMax = h;
    }
  }
  const V = P.length / 3;
  const en = new Set(tris);
  // las aristas del contorno que son silueta del objeto (del otro lado, la cara dobla mucho: el canto)
  /** @type {Set<number>} */
  const silueta = new Set();
  for (const t of tris) {
    for (let e = 0; e < 3; e++) {
      const w = topo.neighbors[t * 3 + e];
      if (w >= 0 && en.has(w)) continue;
      if (w < 0 || dot(/** @type {V3} */ ([topo.normals[w * 3], topo.normals[w * 3 + 1], topo.normals[w * 3 + 2]]), n) < SILUETA) {
        silueta.add(obj.indices[t * 3 + e] * V + obj.indices[t * 3 + ((e + 1) % 3)]);
      }
    }
  }
  const lazos = boundaryLoops(obj, topo, tris);
  /** @param {number} i @returns {[number, number]} */
  const plano = (i) => [P[i * 3] * u[0] + P[i * 3 + 1] * u[1] + P[i * 3 + 2] * u[2], P[i * 3] * v[0] + P[i * 3 + 1] * v[1] + P[i * 3 + 2] * v[2]];
  /** @type {Rings} */
  const rings = lazos.map((l) => l.map(plano));
  // el contorno con los tramos de silueta corridos hacia afuera `SOBRANTE` mm: así el prisma del color
  // pasa el canto y no deja una lámina de base (con relleno positivo, cada cuadrilátero se suma)
  /** @type {Rings} */
  const cubre = [...rings];
  for (const l of lazos) {
    const esSil = l.map((a, k) => silueta.has(a * V + l[(k + 1) % l.length]));
    for (let k = 0; k < l.length; k++) {
      if (!esSil[k]) continue;
      const p = plano(l[k]), q = plano(l[(k + 1) % l.length]);
      const dx = q[0] - p[0], dy = q[1] - p[1], m = Math.hypot(dx, dy);
      if (m < 1e-9) continue;
      const d = [dx / m, dy / m], afuera = [d[1] * SOBRANTE, -d[0] * SOBRANTE];
      const antes = esSil[(k - 1 + l.length) % l.length] ? SOBRANTE : 0, despues = esSil[(k + 1) % l.length] ? SOBRANTE : 0;
      const p2 = [p[0] - d[0] * antes, p[1] - d[1] * antes], q2 = [q[0] + d[0] * despues, q[1] + d[1] * despues];
      cubre.push([[p2[0], p2[1]], [p2[0] + afuera[0], p2[1] + afuera[1]], [q2[0] + afuera[0], q2[1] + afuera[1]], [q2[0], q2[1]]]);
    }
  }
  return { n, u, v, rings, cover: cubre, hMin, hMax, area, flatness: planitud };
}

/**
 * Los triángulos de `a` que apoyan en la superficie de `b` (caras enfrentadas, a menos de `tol`).
 * @param {ModelObject} a @param {import('./mesh.js').Topology} ta @param {MeshLike} b @param {number} tol
 * @returns {number[]}
 */
function contactTriangles(a, ta, b, tol) {
  const P = b.positions, ix = b.indices;
  const Tb = ix.length / 3;
  if (!Tb) return [];
  // una grilla de los triángulos de b por su caja
  const bb = boundsOf(P);
  const lado = Math.max(1e-3, ...[0, 1, 2].map((k) => (bb.max[k] - bb.min[k]) / Math.cbrt(Tb) / 1.5));
  /** @type {Map<string, number[]>} */
  const celdas = new Map();
  const nb = new Float64Array(Tb * 3);
  for (let t = 0; t < Tb; t++) {
    const i0 = ix[t * 3] * 3, i1 = ix[t * 3 + 1] * 3, i2 = ix[t * 3 + 2] * 3;
    const n = unit(cross([P[i1] - P[i0], P[i1 + 1] - P[i0 + 1], P[i1 + 2] - P[i0 + 2]], [P[i2] - P[i0], P[i2 + 1] - P[i0 + 1], P[i2 + 2] - P[i0 + 2]]));
    nb.set(n, t * 3);
    const lo = [0, 1, 2].map((k) => Math.floor((Math.min(P[i0 + k], P[i1 + k], P[i2 + k]) - tol - bb.min[k]) / lado));
    const hi = [0, 1, 2].map((k) => Math.floor((Math.max(P[i0 + k], P[i1 + k], P[i2 + k]) + tol - bb.min[k]) / lado));
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
      const k = `${x},${y},${z}`;
      const l = celdas.get(k);
      if (l) l.push(t); else celdas.set(k, [t]);
    }
  }
  /** @type {number[]} */
  const out = [];
  const tol2 = tol * tol;
  for (let t = 0; t < ta.triangleCount; t++) {
    const c = [ta.centers[t * 3], ta.centers[t * 3 + 1], ta.centers[t * 3 + 2]];
    const k = [0, 1, 2].map((q) => Math.floor((c[q] - bb.min[q]) / lado)).join(',');
    const l = celdas.get(k);
    if (!l) continue;
    for (const s of l) {
      const d = ta.normals[t * 3] * nb[s * 3] + ta.normals[t * 3 + 1] * nb[s * 3 + 1] + ta.normals[t * 3 + 2] * nb[s * 3 + 2];
      if (d > -0.985) continue;
      if (dist2PointTriangle(c, P, ix[s * 3] * 3, ix[s * 3 + 1] * 3, ix[s * 3 + 2] * 3) <= tol2) { out.push(t); break; }
    }
  }
  return out;
}

/**
 * Agrupa triángulos por plano (misma normal y altura) y conexos, el grupo más grande primero.
 * @param {import('./mesh.js').Topology} topo @param {number[]} tris @param {number} tol
 */
function planarGroups(topo, tris, tol) {
  const en = new Set(tris);
  const h = (/** @type {number} */ t) => topo.normals[t * 3] * topo.centers[t * 3] + topo.normals[t * 3 + 1] * topo.centers[t * 3 + 1] + topo.normals[t * 3 + 2] * topo.centers[t * 3 + 2];
  const { groups } = components(topo, (t, u) => {
    const d = topo.normals[t * 3] * topo.normals[u * 3] + topo.normals[t * 3 + 1] * topo.normals[u * 3 + 1] + topo.normals[t * 3 + 2] * topo.normals[u * 3 + 2];
    return d > 0.999 && Math.abs(h(t) - h(u)) < tol * 4;
  }, (t) => en.has(t));
  const area = (/** @type {number[]} */ g) => g.reduce((s, t) => s + topo.areas[t], 0);
  return groups.map((g) => ({ tris: g, area: area(g) })).sort((a, b) => b.area - a.area);
}

/**
 * Las zonas de un color más chicas que `minArea` (una punta suelta, un triángulo que quedó del
 * otro lado del borde al pintar) pasan al color con el que comparten más borde. Cambia `obj.colors`
 * en el lugar y devuelve cuántas cambió.
 * @param {ModelObject} obj @param {import('./mesh.js').Topology} topo @param {number} minArea
 */
export function absorbSmallZones(obj, topo, minArea) {
  let cambiadas = 0;
  const { groups } = components(topo, (t, u) => obj.colors[t] === obj.colors[u]);
  // de la más chica a la más grande: una isla adentro de otra isla chica termina en la de afuera
  const conArea = groups.map((g) => ({ g, area: g.reduce((s, t) => s + topo.areas[t], 0) })).filter((z) => z.area < minArea).sort((a, b) => a.area - b.area);
  for (const { g } of conArea) {
    const propio = obj.colors[g[0]];
    if (g.some((t) => obj.colors[t] !== propio)) continue; // ya la tocó otra
    /** @type {Map<number, number>} */
    const borde = new Map();
    for (const t of g) {
      for (let e = 0; e < 3; e++) {
        const w = topo.neighbors[t * 3 + e];
        if (w < 0 || obj.colors[w] === propio) continue;
        const a = obj.indices[t * 3 + e] * 3, b = obj.indices[t * 3 + ((e + 1) % 3)] * 3, P = obj.positions;
        borde.set(obj.colors[w], (borde.get(obj.colors[w]) ?? 0) + Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]));
      }
    }
    if (!borde.size) continue;
    const nuevo = [...borde.entries()].sort((x, y) => y[1] - x[1])[0][0];
    for (const t of g) obj.colors[t] = nuevo;
    cambiadas++;
  }
  return cambiadas;
}

/**
 * Saca las cáscaras de menos de MIN_SHELL_VOLUME: láminas sin espesor que dejan las booleanas
 * donde dos caras casi coinciden.
 * @param {MeshLike} m @returns {MeshLike}
 */
function dropSlivers(m) {
  if (!m.indices.length) return m;
  const ob = asObject(m, '');
  const { groups } = components(topology(ob));
  if (groups.length < 2) return m;
  // (menos de 4 triángulos no cierra un volumen: es un resto suelto)
  const buenas = groups.filter((g) => g.length >= 4 && Math.abs(volumeOf(submesh(ob, g))) >= MIN_SHELL_VOLUME);
  if (buenas.length === groups.length) return m;
  return submesh(ob, buenas.flat());
}

/** Un objeto a partir de una malla (para medir su topología). @param {MeshLike} m @param {string} name */
const asObject = (m, name) => weld({ name, positions: Float64Array.from(m.positions), indices: Uint32Array.from(m.indices), colors: new Int32Array(m.indices.length / 3) });

/**
 * Separa un objeto por color.
 * @param {ModelObject} obj
 * @param {{ kernel: Kernel, params?: Partial<SeparationParams>, palette?: PaletteEntry[], base?: number | null, onProgress?: (text: string) => void }} opts
 *   base: el color que hace de base en las zonas pintadas (por defecto, el de más área de cada cáscara)
 * @returns {{ pieces: Piece[], warnings: string[] }}
 */
export function separate(obj, { kernel, params = {}, palette = [], base = null, onProgress = () => {} }) {
  if (!kernel) throw new TypeError('separate: falta el kernel (las booleanas): ver adapters/manifold/kernel.js');
  const K = kernel;
  const prm = checkParams(params);
  /** @type {string[]} */
  const warnings = [];
  const nombre = (/** @type {number} */ c) => palette[c]?.name ?? `Color ${c + 1}`;
  const o = weld(obj);
  const topo = topology(o);
  const cascaras = components(topo).groups;
  const absorbidas = absorbSmallZones(o, topo, MIN_ZONE_AREA);
  if (absorbidas) warnings.push(`${absorbidas === 1 ? 'una zona' : `${absorbidas} zonas`} de menos de ${MIN_ZONE_AREA} mm² ${absorbidas === 1 ? 'pasó' : 'pasaron'} al color de al lado`);

  /** @typedef {{ mesh: MeshLike, color: number, role: 'base' | 'inlay' | 'part', parent: number, direction: V3, name: string }} Cuerpo */
  /** @type {Cuerpo[]} */
  const piezas = [];
  /** @type {number[]} los índices de piezas que pueden recibir partes */
  const cuerpos = [];

  cascaras.forEach((tris, ci) => {
    onProgress(`cáscara ${ci + 1} de ${cascaras.length}`);
    /** @type {Map<number, number>} */
    const areaPorColor = new Map();
    for (const t of tris) areaPorColor.set(o.colors[t], (areaPorColor.get(o.colors[t]) ?? 0) + topo.areas[t]);
    const S = submesh(o, tris);
    if (areaPorColor.size === 1) {
      const c = o.colors[tris[0]];
      cuerpos.push(piezas.length);
      piezas.push({ mesh: S, color: c, role: 'base', parent: -1, direction: [0, 0, 0], name: `${o.name} · ${nombre(c)}` });
      return;
    }
    // una cáscara de varios colores: la base, y cada zona de otro color vuelta sólido
    const colorBase = base !== null && areaPorColor.has(base) ? base : [...areaPorColor.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const enCascara = new Set(tris);
    const zonas = components(topo, (t, u) => o.colors[t] === o.colors[u], (t) => enCascara.has(t) && o.colors[t] !== colorBase).groups;
    /** @type {MeshLike | null} */
    let quitar = null; // lo que pierde la base: los prismas de las zonas y los alojamientos
    /** @type {MeshLike | null} */
    let ocupado = null; // lo que ya es de una zona (dos prismas vecinos no se pisan)
    let chicas = 0; // (las absorbidas ya no están; quedan las que no tienen vecino de otro color)
    const indiceBase = piezas.length;
    piezas.push({ mesh: S, color: colorBase, role: 'base', parent: -1, direction: [0, 0, 0], name: `${o.name} · ${nombre(colorBase)}` });
    cuerpos.push(indiceBase);
    zonas.forEach((zona, zi) => {
      const c = o.colors[zona[0]];
      const f = footprint(o, topo, zona);
      const etiqueta = `${nombre(c)} (zona ${zi + 1})`;
      if (f.area < MIN_ZONE_AREA) { chicas++; return; }
      if (f.flatness < 0.35) { warnings.push(`${etiqueta}: da la vuelta al objeto (no tiene una dirección para salir): queda en la base. Partila en zonas más planas.`); return; }
      if (f.flatness < 0.8) warnings.push(`${etiqueta}: es curva; se extruye en una sola dirección y el espesor no es parejo`);
      if (Math.abs(K.area(f.rings)) < MIN_AREA) { warnings.push(`${etiqueta}: su contorno no encierra área`); return; }
      onProgress(`${etiqueta}: incrustado`);
      const hFondo = f.hMin - prm.depth;
      const prisma = place(K.extrude(f.cover, f.hMax - hFondo + 1, 1), /** @type {V3} */ ([f.n[0] * hFondo, f.n[1] * hFondo, f.n[2] * hFondo]), f.u, f.v, f.n);
      let incrustado = K.intersect(S, prisma);
      if (ocupado) incrustado = K.subtract(incrustado, ocupado);
      if (!incrustado.indices.length) { warnings.push(`${etiqueta}: no queda volumen`); return; }
      ocupado = ocupado ? K.union(ocupado, incrustado) : incrustado;
      // a la base se le quita el prisma apenas más grande: dos colores vecinos comparten pared, y dos
      // prismas con una pared en común dejarían en la base una lámina sin espesor
      const hueco = place(K.extrude(K.offset(f.cover, EPS), f.hMax - hFondo + 1, 1), /** @type {V3} */ ([f.n[0] * hFondo, f.n[1] * hFondo, f.n[2] * hFondo]), f.u, f.v, f.n);
      quitar = quitar ? K.union(quitar, hueco) : hueco;
      // la extrusión, desde el fondo del incrustado hacia adentro de la base
      let anillos = f.rings;
      if (prm.inset > 0) {
        const chico = K.offset(f.rings, -prm.inset);
        if (Math.abs(K.area(chico)) >= MIN_AREA) anillos = chico;
        else warnings.push(`${etiqueta}: muy fina para achicarla ${prm.inset} mm: la extrusión va del ancho del color`);
      }
      const marco = { u: f.u, v: f.v, n: f.n, h0: hFondo, s: /** @type {-1} */ (-1) };
      const tapon = plugSolid(K, anillos, marco, { length: prm.length, cone: prm.cone, tip: prm.tip, back: EPS });
      if (tapon) {
        onProgress(`${etiqueta}: extrusión`);
        const adentro = K.intersect(tapon, S);
        const vT = volumeOf(tapon), vA = volumeOf(adentro);
        if (vT > 0 && vA < vT * 0.99) warnings.push(`${etiqueta}: la extrusión sale por el otro lado de la pieza: acortala (largo + cono)`);
        incrustado = K.union(incrustado, adentro);
        const holgados = prm.clearance > 0 ? K.offset(anillos, prm.clearance) : anillos;
        const tipH = prm.cone > 0 ? Math.min(1, prm.tip + prm.clearance / Math.max(prm.cone, 1e-6)) : prm.tip;
        const alojamiento = plugSolid(K, holgados, marco, { length: prm.length + (prm.cone > 0 ? 0 : prm.clearance), cone: prm.cone > 0 ? prm.cone + prm.clearance : 0, tip: tipH, back: EPS * 2 });
        if (alojamiento) quitar = K.union(/** @type {MeshLike} */ (quitar), alojamiento);
      }
      piezas.push({ mesh: incrustado, color: c, role: 'inlay', parent: indiceBase, direction: f.n, name: `${o.name} · ${etiqueta}` });
    });
    if (chicas) warnings.push(`${chicas === 1 ? 'una zona' : `${chicas} zonas`} de menos de ${MIN_ZONE_AREA} mm² ${chicas === 1 ? 'queda' : 'quedan'} en la base (${nombre(colorBase)})`);
    if (quitar) {
      onProgress('base');
      piezas[indiceBase].mesh = K.subtract(S, quitar);
    }
  });

  // las partes: de la más grande a la más chica, cada una se encastra en la más grande que toca
  const vol = new Map(cuerpos.map((i) => [i, Math.abs(volumeOf(piezas[i].mesh))]));
  const orden = [...cuerpos].sort((a, b) => /** @type {number} */ (vol.get(b)) - /** @type {number} */ (vol.get(a)));
  const tol = Math.max(1e-3, prm.clearance / 4, 0.01);
  for (let k = 1; k < orden.length; k++) {
    const xi = orden[k];
    const X = piezas[xi];
    /** @type {{ yi: number, grupo: { tris: number[], area: number }, ox: ModelObject, tx: import('./mesh.js').Topology } | null} */
    let mejor = null;
    const bx = boundsOf(X.mesh.positions);
    for (let j = 0; j < k; j++) {
      const yi = orden[j];
      const Y = piezas[yi];
      if (Y.color === X.color) continue;
      const by = boundsOf(Y.mesh.positions);
      if ([0, 1, 2].some((q) => bx.min[q] > by.max[q] + tol || by.min[q] > bx.max[q] + tol)) continue;
      onProgress(`${X.name}: contacto con ${Y.name}`);
      // lo que se mete, se le quita a la más grande
      const comun = K.intersect(X.mesh, Y.mesh);
      if (comun.indices.length && Math.abs(volumeOf(comun)) > 1e-6) Y.mesh = K.subtract(Y.mesh, X.mesh);
      const ox = asObject(X.mesh, X.name);
      const tx = topology(ox);
      const grupos = planarGroups(tx, contactTriangles(ox, tx, Y.mesh, tol), tol);
      if (grupos.length && grupos[0].area >= MIN_ZONE_AREA && (!mejor || grupos[0].area > mejor.grupo.area)) mejor = { yi, grupo: grupos[0], ox, tx };
    }
    if (!mejor) continue;
    const Y = piezas[mejor.yi];
    const f = footprint(mejor.ox, mejor.tx, mejor.grupo.tris);
    X.role = 'part';
    X.parent = mejor.yi;
    X.direction = [-f.n[0], -f.n[1], -f.n[2]];
    let anillos = f.rings;
    if (prm.inset > 0) {
      const chico = K.offset(f.rings, -prm.inset);
      if (Math.abs(K.area(chico)) >= MIN_AREA) anillos = chico;
    }
    const marco = { u: f.u, v: f.v, n: f.n, h0: (f.hMin + f.hMax) / 2, s: /** @type {1} */ (1) };
    const tapon = plugSolid(K, anillos, marco, { length: prm.length, cone: prm.cone, tip: prm.tip, back: EPS });
    if (!tapon) continue;
    onProgress(`${X.name}: extrusión`);
    const adentro = K.intersect(tapon, Y.mesh);
    if (volumeOf(adentro) < volumeOf(tapon) * 0.9) warnings.push(`${X.name}: la extrusión sale por el otro lado de ${Y.name}: acortala (largo + cono)`);
    X.mesh = K.union(X.mesh, adentro);
    const holgados = prm.clearance > 0 ? K.offset(anillos, prm.clearance) : anillos;
    const tipH = prm.cone > 0 ? Math.min(1, prm.tip + prm.clearance / Math.max(prm.cone, 1e-6)) : prm.tip;
    const alojamiento = plugSolid(K, holgados, marco, { length: prm.length + (prm.cone > 0 ? 0 : prm.clearance), cone: prm.cone > 0 ? prm.cone + prm.clearance : 0, tip: tipH, back: EPS * 2 });
    if (alojamiento) Y.mesh = K.subtract(Y.mesh, alojamiento);
  }

  for (const p of piezas) p.mesh = dropSlivers(p.mesh);
  /** @type {Piece[]} */
  const pieces = piezas.filter((p) => p.mesh.indices.length).map((p) => ({
    name: p.name, color: p.color, role: p.role, parent: p.parent, direction: p.direction,
    positions: Float64Array.from(p.mesh.positions), indices: Uint32Array.from(p.mesh.indices), volume: Math.abs(volumeOf(p.mesh)),
  }));
  // los índices de parent, después de sacar las vacías
  const vivos = piezas.map((p) => (p.mesh.indices.length ? 1 : 0));
  const nuevoIndice = vivos.map((_, i) => vivos.slice(0, i).reduce((/** @type {number} */ s, x) => s + x, 0));
  for (const p of pieces) p.parent = p.parent >= 0 && vivos[p.parent] ? nuevoIndice[p.parent] : -1;
  return { pieces, warnings };
}

/**
 * Dónde va cada pieza con las piezas separadas `distance` mm: cada una sale de su madre en su
 * dirección, y se lleva lo que tenga encastrado.
 * @param {Piece[]} pieces @param {number} distance
 * @returns {V3[]} el desplazamiento de cada pieza
 */
export function explodeOffsets(pieces, distance) {
  /** @type {(V3 | null)[]} */
  const memo = pieces.map(() => null);
  /** @param {number} i @param {number} prof @returns {V3} */
  const de = (i, prof) => {
    const m = memo[i];
    if (m) return m;
    const p = pieces[i];
    const madre = p.parent >= 0 && prof < 64 ? de(p.parent, prof + 1) : /** @type {V3} */ ([0, 0, 0]);
    const r = /** @type {V3} */ ([0, 1, 2].map((k) => madre[k] + p.direction[k] * distance));
    memo[i] = r;
    return r;
  };
  return pieces.map((_, i) => de(i, 0));
}

/**
 * Las piezas acomodadas para imprimir: cada una apoyada sobre la cara por la que sale de su madre
 * (un color incrustado, boca abajo: la extrusión queda para arriba, sin soportes) y en fila sobre
 * la cama, a `gap` mm una de otra. Devuelve piezas nuevas; las de entrada no cambian.
 * @param {Piece[]} pieces @param {{ gap?: number }} [opts]
 * @returns {Piece[]}
 */
export function arrangeForPrint(pieces, { gap = 5 } = {}) {
  let x = 0;
  return pieces.map((p) => {
    const d = /** @type {V3} */ (p.direction);
    const pos = Float64Array.from(p.positions);
    const largo = Math.hypot(...d);
    if (largo > 0.5) {
      // el giro que lleva d a -z (Rodrigues); d ya hacia -z: nada; d hacia +z: media vuelta sobre x
      const a = unit(d), b = /** @type {V3} */ ([0, 0, -1]);
      const c = dot(a, b);
      /** @type {number[]} */
      let R;
      if (c > 1 - 1e-9) R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      else if (c < -1 + 1e-9) R = [1, 0, 0, 0, -1, 0, 0, 0, -1];
      else {
        const v = cross(a, b), k = 1 / (1 + c);
        R = [
          v[0] * v[0] * k + c, v[0] * v[1] * k - v[2], v[0] * v[2] * k + v[1],
          v[1] * v[0] * k + v[2], v[1] * v[1] * k + c, v[1] * v[2] * k - v[0],
          v[2] * v[0] * k - v[1], v[2] * v[1] * k + v[0], v[2] * v[2] * k + c,
        ];
      }
      for (let i = 0; i < pos.length; i += 3) {
        const px = pos[i], py = pos[i + 1], pz = pos[i + 2];
        pos[i] = R[0] * px + R[1] * py + R[2] * pz;
        pos[i + 1] = R[3] * px + R[4] * py + R[5] * pz;
        pos[i + 2] = R[6] * px + R[7] * py + R[8] * pz;
      }
    }
    const b = boundsOf(pos);
    const dx = x - b.min[0], dy = -(b.min[1] + b.max[1]) / 2, dz = -b.min[2];
    for (let i = 0; i < pos.length; i += 3) { pos[i] += dx; pos[i + 1] += dy; pos[i + 2] += dz; }
    x += b.max[0] - b.min[0] + gap;
    return { ...p, positions: pos, indices: Uint32Array.from(p.indices), direction: /** @type {V3} */ ([0, 0, 0]), parent: -1 };
  });
}
