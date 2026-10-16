// El kernel de booleanas con manifold-3d (WASM): mallas cerradas y robustas, que es lo que
// necesita un slicer. Es lo único de la app que importa manifold, y se carga a pedido.
//
// Cumple el contrato de `separate` (src/separate.js), que es el del kernel del SDK
// (`intersect`, `subtract`) más `union`, `extrude`, `offset` y `area`: todo con valores planos,
// mallas { positions, indices } y polígonos [[x, y], …].
//
//   import { createManifoldKernel } from './adapters/manifold/kernel.js';
//   const kernel = await createManifoldKernel();                         // en Node: el paquete manifold-3d
//   const kernel = await createManifoldKernel({ module: 'https://…/manifold.js' });   // en el navegador

/** @typedef {import('../../src/separate.js').Kernel} Kernel */
/** @typedef {import('../../src/separate.js').MeshLike} MeshLike */
/** @typedef {import('../../src/separate.js').Rings} Rings */

/** @type {Map<string, Promise<any>>} */
const cargados = new Map();

/**
 * @param {{ module?: string, circularSegments?: number }} [opts]
 *   module: de dónde importar manifold.js (por defecto, el paquete 'manifold-3d')
 *   circularSegments: lados de un arco al agrandar o achicar un contorno
 * @returns {Promise<Kernel & { wasm: any }>}
 */
export async function createManifoldKernel({ module = 'manifold-3d/manifold.js', circularSegments = 24 } = {}) {
  if (!cargados.has(module)) {
    cargados.set(module, (async () => {
      const m = await import(/* @vite-ignore */ module);
      const wasm = await m.default();
      wasm.setup();
      return wasm;
    })());
  }
  const wasm = await cargados.get(module);
  const { Manifold, Mesh, CrossSection } = wasm;

  /** @param {MeshLike} m */
  const aManifold = (m) => {
    const mesh = new Mesh({ numProp: 3, vertProperties: Float32Array.from(m.positions), triVerts: Uint32Array.from(m.indices) });
    mesh.merge();
    const s = new Manifold(mesh);
    const st = s.status();
    if (st !== 'NoError') { s.delete(); throw new Error(`la malla no es un sólido cerrado (${st}): repárala antes de separar`); }
    return s;
  };
  /** @param {any} s @returns {MeshLike} */
  const aMalla = (s) => {
    const m = s.getMesh();
    const np = m.numProp;
    const n = m.vertProperties.length / np;
    const positions = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) { positions[i * 3] = m.vertProperties[i * np]; positions[i * 3 + 1] = m.vertProperties[i * np + 1]; positions[i * 3 + 2] = m.vertProperties[i * np + 2]; }
    return { positions, indices: Uint32Array.from(m.triVerts) };
  };
  /** @param {MeshLike} a @param {MeshLike} b @param {'add' | 'subtract' | 'intersect'} op */
  const booleana = (a, b, op) => {
    if (!a.indices.length) return op === 'add' ? b : a;
    if (!b.indices.length) return op === 'intersect' ? b : a;
    const A = aManifold(a), B = aManifold(b);
    const R = A[op](B);
    const out = aMalla(R);
    A.delete(); B.delete(); R.delete();
    return out;
  };
  /** @param {Rings} rings */
  const seccion = (rings) => new CrossSection(rings.map((r) => r.map(([x, y]) => [x, y])), 'Positive');

  return {
    wasm,
    union: (a, b) => booleana(a, b, 'add'),
    subtract: (a, b) => booleana(a, b, 'subtract'),
    intersect: (a, b) => booleana(a, b, 'intersect'),
    extrude(rings, height, scaleTop = 1) {
      if (!rings.length) return { positions: new Float64Array(0), indices: new Uint32Array(0) };
      const cs = seccion(rings);
      const s = Manifold.extrude(cs, height, 0, 0, [scaleTop, scaleTop]);
      const out = aMalla(s);
      cs.delete(); s.delete();
      return out;
    },
    offset(rings, delta) {
      if (!rings.length) return [];
      const cs = seccion(rings);
      const o = cs.offset(delta, 'Round', 2, circularSegments);
      const out = o.toPolygons().map((/** @type {any[]} */ r) => r.map((/** @type {any} */ p) => /** @type {[number, number]} */ (Array.isArray(p) ? [p[0], p[1]] : [p.x ?? p[0], p.y ?? p[1]])));
      cs.delete(); o.delete();
      return out;
    },
    area(rings) {
      if (!rings.length) return 0;
      const cs = seccion(rings);
      const a = cs.area();
      cs.delete();
      return a;
    },
  };
}
