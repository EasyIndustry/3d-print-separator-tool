// 3d-print-separator-tool: la API.
//
// Leer un modelo (3MF con colores o STL), pintar zonas (pincel, relleno por aristas), y separar
// cada color en un sólido que se imprime aparte y se encastra en el de al lado con una extrusión
// terminada en cono.
//
//   const modelo = await readModel(bytes, { name: 'llavero.3mf' });
//   const proyecto = createProject(modelo);
//   proyecto.fill(0, { triangle: 120, color: proyecto.addColor('#d6461f'), angle: 30 });
//   const { pieces } = proyecto.separate(0, { kernel: await createManifoldKernel(), params: { length: 3 } });
//   proyecto.help();
//
// Puro: no importa three ni el DOM. Las booleanas las pone un kernel (adapters/manifold/).

import { readZip, writeZip, compressZip } from './zip.js';
import { read3mf, write3mf, write3mfPainted, normalizeColor } from './threemf.js';
import { readStl, writeStl } from './stl.js';
import { decodePaint, encodePaintState } from './paintcode.js';
import { weld, topology, components, boundaryLoops, mergeObjects } from './mesh.js';
import { brush, fill, fillPreview, edges, refine, revert, reapply } from './paint.js';
import { separate, explodeOffsets, arrangeForPrint, checkParams } from './separate.js';
import { SEPARATION_DEFAULTS, SEPARATION_LIMITS, PAINT_DEFAULTS } from './config.js';
import { PROJECT_MEMBERS, MODULE_MEMBERS } from './members.js';
import { help as helpTable, memberNames } from './help.js';

export {
  readZip, writeZip, compressZip, read3mf, write3mf, write3mfPainted, readStl, writeStl, decodePaint, encodePaintState,
  weld, topology, components, boundaryLoops, mergeObjects, brush, fill, fillPreview, edges, refine,
  separate, explodeOffsets, arrangeForPrint, checkParams, SEPARATION_DEFAULTS, SEPARATION_LIMITS, PAINT_DEFAULTS,
  PROJECT_MEMBERS, MODULE_MEMBERS, memberNames,
};

/** @typedef {import('./threemf.js').Model} Model */
/** @typedef {import('./threemf.js').ModelObject} ModelObject */
/** @typedef {import('./paint.js').PaintChange} PaintChange */

/**
 * Un 3MF (empieza con "PK", es un ZIP) o un STL.
 * @param {ArrayBuffer | Uint8Array} bytes @param {{ name?: string }} [opts]
 * @returns {Promise<Model>}
 */
export async function readModel(bytes, { name = 'modelo' } = {}) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0x50 && b[1] === 0x4b) {
    const m = await read3mf(b, { name });
    m.objects = m.objects.map((o) => weld(o));
    // varios objetos: también todos juntos, para separar las partes que vinieron sueltas
    if (m.objects.length > 1) m.objects.push(mergeObjects(m.objects, 'Todos juntos'));
    return m;
  }
  return readStl(b, { name });
}

/** @param {{ print?: boolean }} [opts] */
export function help(opts) { return helpTable('3d-print-separator-tool', MODULE_MEMBERS, opts); }

/**
 * El proyecto: un modelo que se pinta, se deshace y se separa.
 * @param {Model} model
 */
export function createProject(model) {
  if (!model || !Array.isArray(model.objects) || !Array.isArray(model.palette)) throw new TypeError('createProject: va un modelo de readModel');
  /** @type {ModelObject[]} */
  const objetos = model.objects.map((o) => ({ ...o, colors: Int32Array.from(o.colors) }));
  const paleta = model.palette.map((p) => ({ ...p }));
  /** @type {Array<import('./mesh.js').Topology | null>} */
  const topos = objetos.map(() => null);
  /**
   * Un paso de deshacer: cambios de pintura y de geometría, en orden.
   * @typedef {{ kind: 'paint', object: number, change: PaintChange } | { kind: 'geometry', object: number, before: ModelObject, after: ModelObject }} Cambio
   */
  /** @type {Cambio[][]} */
  const pasado = [];
  /** @type {Cambio[][]} */
  const futuro = [];
  /** @type {Cambio[] | null} */
  let abierto = null;
  let anidado = 0;
  /** @type {Map<string, Set<(e: any) => void>>} */
  const oyentes = new Map();
  /** @param {string} ev @param {any} [data] */
  const avisar = (ev, data) => { for (const f of oyentes.get(ev) ?? []) f(data); };

  /** @param {number} i */
  const obj = (i) => {
    if (!Number.isInteger(i) || i < 0 || i >= objetos.length) throw new RangeError(`objeto inválido: ${i} (hay ${objetos.length})`);
    return objetos[i];
  };
  /** @param {number} i */
  const topo = (i) => { obj(i); return (topos[i] ??= topology(objetos[i])); };
  /** @param {number} c */
  const color = (c) => {
    if (!Number.isInteger(c) || c < 0 || c >= paleta.length) throw new RangeError(`color inválido: ${c} (hay ${paleta.length})`);
    return c;
  };
  /** @param {Cambio} c */
  const registrar = (c) => {
    futuro.length = 0;
    if (abierto) abierto.push(c); else pasado.push([c]);
    avisar('history');
  };
  /** @param {number} i @param {PaintChange} change */
  const pintado = (i, change) => {
    if (change.triangles.length) {
      registrar({ kind: 'paint', object: i, change });
      avisar('paint', { object: i, triangles: change.triangles });
    }
    return change;
  };
  /** @param {Cambio[]} paso @param {boolean} atras */
  const aplicar = (paso, atras) => {
    const lista = atras ? [...paso].reverse() : paso;
    for (const c of lista) {
      if (c.kind === 'paint') {
        (atras ? revert : reapply)(objetos[c.object], c.change);
        avisar('paint', { object: c.object, triangles: c.change.triangles });
      } else {
        objetos[c.object] = atras ? c.before : c.after;
        topos[c.object] = null;
        avisar('geometry', { object: c.object });
      }
    }
  };

  const proyecto = {
    get source() { return model.source; },
    get warnings() { return [...model.warnings]; },
    get palette() { return paleta.map((p) => ({ ...p })); },
    get objects() { return objetos.map((o) => ({ name: o.name, triangleCount: o.indices.length / 3 })); },
    /** @param {number} i */
    object: (i) => obj(i),
    /** @param {number} i */
    topology: (i) => topo(i),
    /** @param {string} c @param {string} [name] */
    addColor(c, name) {
      const hex = normalizeColor(c);
      if (!hex) throw new TypeError(`color inválido: ${c} (va '#rrggbb')`);
      const f = paleta.reduce((m, p) => Math.max(m, p.filament ?? 0), 0) + 1;
      paleta.push({ key: `u:${paleta.length}`, color: hex, name: name ?? `Filamento ${f}`, filament: f });
      avisar('palette');
      return paleta.length - 1;
    },
    /** @param {number} index @param {{ color?: string, name?: string }} spec */
    setColor(index, { color: c, name } = {}) {
      const p = paleta[color(index)];
      if (c !== undefined) {
        const hex = normalizeColor(c);
        if (!hex) throw new TypeError(`color inválido: ${c} (va '#rrggbb')`);
        p.color = hex;
      }
      if (name !== undefined) p.name = String(name);
      avisar('palette');
    },
    /** @param {number} i @param {{ triangle: number, point: number[], radius: number, color: number, angle?: number | null, only?: number | null }} spec */
    brush: (i, spec) => pintado(i, brush(obj(i), topo(i), { ...spec, color: color(spec.color) })),
    /** @param {number} i @param {{ triangle: number, color: number, angle: number, sameColor?: boolean }} spec */
    fill: (i, spec) => pintado(i, fill(obj(i), topo(i), { ...spec, color: color(spec.color) })),
    /** @param {number} i @param {{ triangle: number, angle: number, sameColor?: boolean }} spec */
    preview: (i, spec) => fillPreview(obj(i), topo(i), spec),
    /** @param {number} i @param {{ angle: number, colors?: boolean }} spec */
    edges: (i, spec) => edges(obj(i), topo(i), spec),
    /** @param {number} i @param {number} maxEdge */
    refine(i, maxEdge) {
      const antes = obj(i);
      const despues = refine(antes, maxEdge);
      if (despues.indices.length === antes.indices.length) return false;
      objetos[i] = despues;
      topos[i] = null;
      registrar({ kind: 'geometry', object: i, before: antes, after: despues });
      avisar('geometry', { object: i });
      return true;
    },
    begin() { if (anidado++ === 0) abierto = []; },
    commit() {
      if (anidado === 0) return;
      if (--anidado > 0) return;
      const paso = abierto;
      abierto = null;
      if (paso && paso.length) { pasado.push(paso); avisar('history'); }
    },
    undo() {
      if (abierto) proyecto.commit();
      const paso = pasado.pop();
      if (!paso) return false;
      aplicar(paso, true);
      futuro.push(paso);
      avisar('history');
      return true;
    },
    redo() {
      const paso = futuro.pop();
      if (!paso) return false;
      aplicar(paso, false);
      pasado.push(paso);
      avisar('history');
      return true;
    },
    get canUndo() { return pasado.length > 0; },
    get canRedo() { return futuro.length > 0; },
    /**
     * @param {number} i
     * @param {{ kernel: import('./separate.js').Kernel, params?: Partial<import('./separate.js').SeparationParams>, base?: number | null, onProgress?: (t: string) => void }} opts
     */
    separate: (i, opts) => separate(obj(i), { ...opts, palette: paleta }),
    /** @param {number} i */
    paintedModel: (i) => write3mfPainted(obj(i), paleta),
    /** @param {string} ev @param {(e: any) => void} fn */
    on(ev, fn) {
      if (!['paint', 'geometry', 'palette', 'history'].includes(ev)) throw new TypeError(`aviso desconocido: ${ev}`);
      let s = oyentes.get(ev);
      if (!s) oyentes.set(ev, (s = new Set()));
      s.add(fn);
      return () => s.delete(fn);
    },
    /** @param {{ print?: boolean }} [opts] */
    help: (opts) => helpTable('Proyecto — pintar, deshacer y separar', PROJECT_MEMBERS, opts),
  };
  return proyecto;
}
