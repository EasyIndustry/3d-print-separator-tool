// Leer un 3MF: las mallas, en milímetros y en el mundo, con el color de cada triángulo.
//
// De dónde sale el color de un triángulo, del que manda al que menos:
//   1. la pintura del slicer (`paint_color` de Bambu y Orca, `mmu_segmentation` de Prusa);
//   2. el filamento de la parte (Bambu y Orca: Metadata/model_settings.config; Prusa: el
//      volumen de Metadata/Slic3r_PE_model.config);
//   3. el filamento del objeto (los mismos archivos);
//   4. las propiedades del 3MF: `pid`/`p1` del triángulo o `pid`/`pindex` del objeto, contra un
//      `basematerials` o un `colorgroup`.
// Lo que imprime es el filamento; por eso lo del slicer manda sobre las propiedades.
//
// Cada ítem de `<build>` es un objeto, con sus componentes juntos (también los de otros
// archivos del paquete: la extensión de producción, `p:path`). Las partes que no son geometría
// (modificadores, volúmenes negativos, bloqueadores de soporte) no entran.
//
// Puro: no importa three ni el DOM.

import { readZip, writeZip } from './zip.js';
import { parseXml, escapeXml } from './xml.js';
import { decodePaint, encodePaintState } from './paintcode.js';
import { convertLength } from '../vendor/threejs-cad-sdk/src/index.js';
import { DEFAULT_FILAMENTS, NO_COLOR } from './config.js';

/**
 * @typedef {{ key: string, color: string, name: string, filament: number | null }} PaletteEntry
 * @typedef {{ name: string, positions: Float64Array, indices: Uint32Array, colors: Int32Array }} ModelObject
 *   colors: un índice de `palette` por triángulo
 * @typedef {{ unit: 'mm', palette: PaletteEntry[], objects: ModelObject[], source: string, warnings: string[] }} Model
 */

/** Las unidades de un 3MF, con la del SDK que les corresponde. */
const UNIDADES_3MF = /** @type {const} */ ({ micron: 'um', millimeter: 'mm', centimeter: 'cm', inch: 'in', foot: 'ft', meter: 'm' });

/** @typedef {[number, number, number, number, number, number, number, number, number, number, number, number]} Affine */
/** @type {Affine} */
const IDENTIDAD = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

/** "m00 m01 … m32" del 3MF (vector fila: p' = p·M). @param {string | undefined} s @returns {Affine} */
function parseTransform(s) {
  if (!s) return IDENTIDAD;
  const n = s.trim().split(/\s+/).map(Number);
  if (n.length !== 12 || n.some((v) => !Number.isFinite(v))) return IDENTIDAD;
  return /** @type {Affine} */ (n);
}
/** Primero `a`, después `b`. @param {Affine} a @param {Affine} b @returns {Affine} */
function compose(a, b) {
  /** @type {number[]} */
  const r = [];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) {
      let v = i === 3 ? b[9 + j] : 0;
      for (let k = 0; k < 3; k++) v += a[i * 3 + k] * b[k * 3 + j];
      r.push(v);
    }
  }
  return /** @type {Affine} */ (r);
}
/** @param {Affine} m */
const det = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);

/** '#RGB', '#RRGGBB' o '#RRGGBBAA' → '#rrggbb'. @param {string | undefined} c */
export function normalizeColor(c) {
  if (!c) return null;
  let s = c.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3,4}$/i.test(s)) s = s.slice(0, 3).split('').map((x) => x + x).join('');
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(s)) return null;
  return '#' + s.slice(0, 6).toLowerCase();
}

/**
 * @typedef {{ v1: number, v2: number, v3: number, pid?: string, p1?: string, paint?: string }} Tri
 * @typedef {{ id: string, name: string, type: string, pid?: string, pindex?: string,
 *   vertices: number[], tris: Tri[], components: Array<{ objectid: string, transform: Affine, path: string | null }> }} Obj3mf
 * @typedef {{ scale: number, base: Map<string, Array<{ name: string, color: string | null }>>, colors: Map<string, Array<string | null>>,
 *   objects: Map<string, Obj3mf>, build: Array<{ objectid: string, transform: Affine, path: string | null }> }} ModelFile
 */

/** Un archivo .model. @param {string} xml @returns {ModelFile} */
function parseModelFile(xml) {
  /** @type {ModelFile} */
  const f = { scale: 1, base: new Map(), colors: new Map(), objects: new Map(), build: [] };
  /** @type {Obj3mf | null} */
  let obj = null;
  /** @type {Array<{ name: string, color: string | null }> | null} */
  let base = null;
  /** @type {Array<string | null> | null} */
  let grupo = null;
  let enBuild = false;
  parseXml(xml, {
    open(name, a) {
      switch (name) {
        case 'model': {
          const u = /** @type {keyof typeof UNIDADES_3MF} */ (a.unit || 'millimeter');
          if (!Object.hasOwn(UNIDADES_3MF, u)) throw new TypeError(`3MF: unidad desconocida ${a.unit}`);
          f.scale = convertLength(1, UNIDADES_3MF[u], 'mm');
          break;
        }
        case 'basematerials': base = []; f.base.set(a.id, base); break;
        case 'base': base?.push({ name: a.name || '', color: normalizeColor(a.displaycolor) }); break;
        case 'colorgroup': grupo = []; f.colors.set(a.id, grupo); break;
        case 'color': grupo?.push(normalizeColor(a.color)); break;
        case 'object':
          obj = { id: a.id, name: a.name || '', type: a.type || 'model', pid: a.pid, pindex: a.pindex, vertices: [], tris: [], components: [] };
          f.objects.set(a.id, obj);
          break;
        case 'vertex': obj?.vertices.push(+a.x, +a.y, +a.z); break;
        case 'triangle':
          if (obj) obj.tris.push({ v1: +a.v1, v2: +a.v2, v3: +a.v3, pid: a.pid, p1: a.p1, paint: a.paint_color ?? a.mmu_segmentation });
          break;
        case 'component': obj?.components.push({ objectid: a.objectid, transform: parseTransform(a.transform), path: a.path || null }); break;
        case 'build': enBuild = true; break;
        case 'item': if (enBuild) f.build.push({ objectid: a.objectid, transform: parseTransform(a.transform), path: a.path || null }); break;
      }
    },
    close(name) {
      if (name === 'object') obj = null;
      else if (name === 'basematerials') base = null;
      else if (name === 'colorgroup') grupo = null;
      else if (name === 'build') enBuild = false;
    },
  });
  return f;
}

/**
 * Lo que dice el slicer de cada objeto y parte: su filamento y si es geometría.
 * @typedef {{ name?: string, extruder: number, parts: Map<string, { extruder: number, solid: boolean }>,
 *   volumes: Array<{ first: number, last: number, extruder: number, solid: boolean }> }} SlicerObject
 */

/** Metadata/model_settings.config (Bambu, Orca). @param {string} xml */
function parseBambuConfig(xml) {
  /** @type {Map<string, SlicerObject>} */
  const objetos = new Map();
  /** @type {SlicerObject | null} */
  let obj = null;
  /** @type {{ extruder: number, solid: boolean } | null} */
  let parte = null;
  let profundidad = 0;
  parseXml(xml, {
    open(name, a) {
      profundidad++; // close() llega también para las vacías
      if (name === 'object' && profundidad === 2) {
        obj = { extruder: 0, parts: new Map(), volumes: [] };
        objetos.set(a.id, obj);
      } else if (name === 'part' && obj) {
        parte = { extruder: 0, solid: !a.subtype || a.subtype === 'normal_part' };
        obj.parts.set(a.id, parte);
      } else if (name === 'metadata' && a.key === 'extruder') {
        const e = parseInt(a.value, 10) || 0;
        if (parte) parte.extruder = e;
        else if (obj) obj.extruder = e;
      } else if (name === 'metadata' && a.key === 'name' && obj && !parte) obj.name = a.value;
    },
    close(name) {
      profundidad--;
      if (name === 'part') parte = null;
      else if (name === 'object') obj = null;
    },
  });
  return objetos;
}

/** Metadata/Slic3r_PE_model.config (Prusa): volúmenes como rangos de triángulos. @param {string} xml */
function parsePrusaConfig(xml) {
  /** @type {Map<string, SlicerObject>} */
  const objetos = new Map();
  /** @type {SlicerObject | null} */
  let obj = null;
  /** @type {{ first: number, last: number, extruder: number, solid: boolean } | null} */
  let vol = null;
  parseXml(xml, {
    open(name, a) {
      if (name === 'object') {
        obj = { extruder: 0, parts: new Map(), volumes: [] };
        objetos.set(a.id, obj);
      } else if (name === 'volume' && obj) {
        vol = { first: +a.firstid, last: +a.lastid, extruder: 0, solid: true };
        obj.volumes.push(vol);
      } else if (name === 'metadata' && obj) {
        if (a.key === 'extruder') {
          const e = parseInt(a.value, 10) || 0;
          if (vol) vol.extruder = e; else obj.extruder = e;
        } else if (a.key === 'volume_type' && vol) vol.solid = a.value === 'ModelPart';
        else if (a.key === 'modifier' && vol && a.value === '1') vol.solid = false;
      }
    },
    close(name) {
      if (name === 'volume') vol = null;
      else if (name === 'object') obj = null;
    },
  });
  return objetos;
}

/** Los colores de los filamentos, de la configuración del proyecto. @param {Map<string, { read: () => Promise<Uint8Array> }>} zip */
async function filamentColors(zip) {
  const dec = new TextDecoder();
  const bambu = zip.get('Metadata/project_settings.config');
  if (bambu) {
    try {
      const j = JSON.parse(dec.decode(await bambu.read()));
      const c = j.filament_colour ?? j.filament_color;
      if (Array.isArray(c) && c.length) return c.map((x) => normalizeColor(String(x)));
    } catch { /* no es JSON: sigue */ }
  }
  const prusa = zip.get('Metadata/Slic3r_PE.config');
  if (prusa) {
    const txt = dec.decode(await prusa.read());
    /** @param {string} k */
    const linea = (k) => txt.match(new RegExp(`^;\\s*${k}\\s*=\\s*(.*)$`, 'm'))?.[1]?.trim() ?? '';
    const ext = linea('extruder_colour').split(';').map(normalizeColor);
    const fil = linea('filament_colour').split(';').map(normalizeColor);
    const n = Math.max(ext.length, fil.length);
    if (n && (ext.some(Boolean) || fil.some(Boolean))) return Array.from({ length: n }, (_, i) => ext[i] || fil[i] || null);
  }
  return [];
}

/**
 * Lee un 3MF.
 * @param {ArrayBuffer | Uint8Array} data
 * @param {{ name?: string }} [opts]
 * @returns {Promise<Model>}
 */
export async function read3mf(data, { name = 'modelo.3mf' } = {}) {
  const zip = readZip(data);
  const dec = new TextDecoder();
  /** @param {string} p */
  const texto = async (p) => { const e = zip.get(p.replace(/^\/+/, '')); return e ? dec.decode(await e.read()) : null; };
  /** @type {string[]} */
  const warnings = [];

  // la parte de inicio, según _rels/.rels
  let inicio = '3D/3dmodel.model';
  const rels = await texto('_rels/.rels');
  if (rels) {
    parseXml(rels, { open(n, a) { if (n === 'Relationship' && /3dmodel$/.test(a.Type || '') && a.Target) inicio = a.Target.replace(/^\/+/, ''); } });
  }
  /** @type {Map<string, ModelFile>} */
  const archivos = new Map();
  /** @param {string | null} p */
  const archivo = async (p) => {
    const k = (p || inicio).replace(/^\/+/, '');
    if (!archivos.has(k)) {
      const xml = await texto(k);
      if (xml === null) throw new TypeError(`3MF: falta ${k}`);
      archivos.set(k, parseModelFile(xml));
    }
    return /** @type {ModelFile} */ (archivos.get(k));
  };
  const principal = await archivo(null);

  const bambuTxt = await texto('Metadata/model_settings.config');
  const prusaTxt = await texto('Metadata/Slic3r_PE_model.config');
  const slicer = bambuTxt ? parseBambuConfig(bambuTxt) : prusaTxt ? parsePrusaConfig(prusaTxt) : new Map();
  const filamentos = await filamentColors(zip);

  // la paleta: una entrada por color o filamento, en el orden en que aparecen
  /** @type {PaletteEntry[]} */
  const palette = [];
  /** @type {Map<string, number>} */
  const porClave = new Map();
  /** @param {string} key @param {() => Omit<PaletteEntry, 'key'>} crear */
  const entrada = (key, crear) => {
    let i = porClave.get(key);
    if (i === undefined) { i = palette.length; palette.push({ key, ...crear() }); porClave.set(key, i); }
    return i;
  };
  /** @param {number} k filamento, desde 1 */
  const deFilamento = (k) => entrada(`f:${k}`, () => {
    // sin colores del proyecto, el k-ésimo material del archivo (así lo escribe write3mfPainted)
    const m = filamentos.length ? null : [...principal.base.values()][0]?.[k - 1];
    return {
      color: filamentos[k - 1] || m?.color || DEFAULT_FILAMENTS[(k - 1) % DEFAULT_FILAMENTS.length],
      name: m?.name || `Filamento ${k}`, filament: k,
    };
  });
  /** @param {ModelFile} f @param {string | undefined} pid @param {string | undefined} idx */
  const dePropiedad = (f, pid, idx) => {
    if (pid === undefined) return -1;
    const i = +(idx ?? 0);
    const b = f.base.get(pid);
    if (b && b[i]) {
      const { name: n, color } = b[i];
      return entrada(`c:${color ?? NO_COLOR}:${n}`, () => ({ color: color ?? NO_COLOR, name: n || color || 'Material', filament: null }));
    }
    const g = f.colors.get(pid);
    if (g && g[i]) { const c = g[i]; return entrada(`c:${c}:`, () => ({ color: /** @type {string} */ (c), name: /** @type {string} */ (c), filament: null })); }
    return -1;
  };
  // un archivo de slicer: lo que no dice otra cosa va con el filamento 1 (el de por defecto del slicer)
  const deSlicer = slicer.size > 0 || filamentos.length > 0;
  const sinColor = () => entrada('none', () => ({ color: NO_COLOR, name: 'Sin color', filament: null }));

  /** @type {ModelObject[]} */
  const objects = [];
  for (const item of principal.build) {
    const fItem = await archivo(item.path);
    const raiz = fItem.objects.get(item.objectid);
    if (!raiz) { warnings.push(`el ítem ${item.objectid} no tiene objeto`); continue; }
    if (raiz.type !== 'model' && raiz.type !== 'solidsupport' && raiz.type !== '') {
      if (raiz.type !== 'other') warnings.push(`"${raiz.name || raiz.id}" es ${raiz.type}: no entra`);
      continue;
    }
    const conf = slicer.get(item.objectid) ?? null;
    /** @type {number[]} */ const pos = [];
    /** @type {number[]} */ const idx = [];
    /** @type {number[]} */ const col = [];
    /**
     * @param {ModelFile} f @param {Obj3mf} o @param {Affine} m @param {number} filamento
     * @param {number} heredado el color heredado del componente de arriba (-1: ninguno)
     * @param {number} prof
     */
    const juntar = async (f, o, m, filamento, heredado, prof) => {
      if (prof > 32) throw new TypeError('3MF: componentes que se contienen a sí mismos');
      const colObj = dePropiedad(f, o.pid, o.pindex);
      const propio = colObj >= 0 ? colObj : heredado;
      for (const c of o.components) {
        const fc = c.path ? await archivo(c.path) : f;
        const hijo = fc.objects.get(c.objectid);
        if (!hijo) { warnings.push(`falta el objeto ${c.objectid}`); continue; }
        // en Bambu y Orca, la parte se identifica por el objectid del componente
        const parte = prof === 0 ? conf?.parts.get(c.objectid) : undefined;
        if (parte && !parte.solid) continue;
        await juntar(fc, hijo, compose(c.transform, m), parte?.extruder || filamento, propio, prof + 1);
      }
      if (!o.tris.length) return;
      agregarMalla(f, o, m, filamento, propio, prof === 0 ? conf : null);
    };
    /**
     * @param {ModelFile} f @param {Obj3mf} o @param {Affine} m @param {number} filamento @param {number} propio
     * @param {SlicerObject | null} volConf
     */
    const agregarMalla = (f, o, m, filamento, propio, volConf) => {
      const escala = f.scale;
      const v = o.vertices;
      const base = pos.length / 3;
      // los vértices, en el mundo y en mm
      /** @type {number[]} */
      const local = [];
      for (let i = 0; i < v.length; i += 3) {
        const x = v[i], y = v[i + 1], z = v[i + 2];
        local.push(
          (x * m[0] + y * m[3] + z * m[6] + m[9]) * escala,
          (x * m[1] + y * m[4] + z * m[7] + m[10]) * escala,
          (x * m[2] + y * m[5] + z * m[8] + m[11]) * escala,
        );
      }
      for (let i = 0; i < local.length; i++) pos.push(local[i]);
      const espejo = det(m) < 0;
      /** @param {number} a @param {number} b @param {number} c @param {number} color */
      const tri = (a, b, c, color) => { idx.push(base + a, base + (espejo ? c : b), base + (espejo ? b : c)); col.push(color); };
      /** @param {number} t */
      const volDe = (t) => volConf?.volumes.find((q) => t >= q.first && t <= q.last);
      // los puntos medios de la pintura, compartidos entre vecinos
      /** @type {Map<string, number>} */
      const medios = new Map();
      /** @param {number} a @param {number} b */
      const medio = (a, b) => {
        const k = a < b ? `${a},${b}` : `${b},${a}`;
        let r = medios.get(k);
        if (r === undefined) {
          r = pos.length / 3 - base;
          pos.push((pos[(base + a) * 3] + pos[(base + b) * 3]) / 2, (pos[(base + a) * 3 + 1] + pos[(base + b) * 3 + 1]) / 2, (pos[(base + a) * 3 + 2] + pos[(base + b) * 3 + 2]) / 2);
          medios.set(k, r);
        }
        return r;
      };
      /** @type {Array<[number, number, number, number]>} */
      const hojas = [];
      const pintada = o.tris.some((q) => q.paint);
      for (let t = 0; t < o.tris.length; t++) {
        const tr = o.tris[t];
        const vol = volDe(t);
        if (vol && !vol.solid) continue;
        const fil = vol?.extruder || filamento;
        const deProp = tr.pid !== undefined ? dePropiedad(f, tr.pid, tr.p1) : -1;
        // en un archivo de slicer manda el filamento (el slicer no lee basematerials): sin decir otro, el 1
        const colorBase = fil > 0 ? deFilamento(fil) : deSlicer || pintada ? deFilamento(1) : deProp >= 0 ? deProp : propio >= 0 ? propio : sinColor();
        if (tr.paint) {
          const hs = decodePaint(tr.paint, [tr.v1, tr.v2, tr.v3], medio);
          if (hs) {
            for (const h of hs) hojas.push([h.v[0], h.v[1], h.v[2], h.state > 0 ? deFilamento(h.state) : colorBase]);
            continue;
          }
          warnings.push(`pintura ilegible en un triángulo de "${o.name || o.id}": queda sin pintar`);
        }
        hojas.push([tr.v1, tr.v2, tr.v3, colorBase]);
      }
      // con triángulos partidos quedan vértices en medio de un lado vecino: se cosen
      if (medios.size) {
        /** @param {number} a @param {number} b @returns {number[]} */
        const sobre = (a, b) => {
          const k = a < b ? `${a},${b}` : `${b},${a}`;
          const mm = medios.get(k);
          return mm === undefined ? [] : [...sobre(a, mm), mm, ...sobre(mm, b)];
        };
        for (const [a, b, c, color] of hojas) {
          const poli = [a, ...sobre(a, b), b, ...sobre(b, c), c, ...sobre(c, a)];
          if (poli.length === 3) { tri(a, b, c, color); continue; }
          // abanico desde el centro: el polígono es convexo (un triángulo con puntos en sus lados)
          const g = pos.length / 3 - base;
          let cx = 0, cy = 0, cz = 0;
          for (const q of [a, b, c]) { cx += pos[(base + q) * 3]; cy += pos[(base + q) * 3 + 1]; cz += pos[(base + q) * 3 + 2]; }
          pos.push(cx / 3, cy / 3, cz / 3);
          for (let i = 0; i < poli.length; i++) tri(poli[i], poli[(i + 1) % poli.length], g, color);
        }
      } else {
        for (const [a, b, c, color] of hojas) tri(a, b, c, color);
      }
    };
    await juntar(fItem, raiz, item.transform, conf?.extruder || 0, -1, 0);
    if (!idx.length) continue;
    objects.push({
      name: raiz.name || conf?.name || '',
      positions: Float64Array.from(pos), indices: Uint32Array.from(idx), colors: Int32Array.from(col),
    });
  }
  if (!objects.length) throw new TypeError('3MF sin objetos para imprimir');
  for (const o of objects) if (!o.name) o.name = `Objeto ${objects.indexOf(o) + 1}`;
  // la paleta, solo con los colores que se usan
  const orden = (/** @type {number} */ c) => palette[c].filament ?? Infinity;
  const usados = [...new Set(objects.flatMap((o) => [...new Set(o.colors)]))].sort((x, y) => orden(x) - orden(y) || x - y);
  const nuevo = new Map(usados.map((c, i) => [c, i]));
  for (const o of objects) o.colors = o.colors.map((c) => /** @type {number} */ (nuevo.get(c)));
  return { unit: 'mm', palette: usados.map((c) => palette[c]), objects, source: name, warnings };
}

/**
 * Escribe un 3MF con un objeto por pieza, cada uno con su color (un `basematerials` con un
 * material por color) y, para los slicers que lo leen, su filamento (Metadata/model_settings.config
 * de Bambu y Orca). Lo lee cualquier slicer: cada pieza llega separada, en su lugar.
 * @param {Array<{ name: string, color: string, filament?: number | null, positions: ArrayLike<number>, indices: ArrayLike<number> }>} pieces
 * @param {{ title?: string }} [opts]
 * @returns {Uint8Array}
 */
export function write3mf(pieces, { title = 'Separado' } = {}) {
  const colores = [...new Set(pieces.map((p) => p.color))];
  const f6 = (/** @type {number} */ x) => +x.toFixed(6);
  let objetos = '';
  let items = '';
  let config = '';
  pieces.forEach((p, i) => {
    const id = i + 2;
    const pindex = colores.indexOf(p.color);
    let v = '', t = '';
    for (let k = 0; k < p.positions.length; k += 3) v += `<vertex x="${f6(p.positions[k])}" y="${f6(p.positions[k + 1])}" z="${f6(p.positions[k + 2])}"/>`;
    for (let k = 0; k < p.indices.length; k += 3) t += `<triangle v1="${p.indices[k]}" v2="${p.indices[k + 1]}" v3="${p.indices[k + 2]}"/>`;
    objetos += `<object id="${id}" type="model" name="${escapeXml(p.name)}" pid="1" pindex="${pindex}"><mesh><vertices>${v}</vertices><triangles>${t}</triangles></mesh></object>`;
    items += `<item objectid="${id}"/>`;
    const fil = p.filament ?? pindex + 1;
    config += `<object id="${id}"><metadata key="name" value="${escapeXml(p.name)}"/><metadata key="extruder" value="${fil}"/></object>`;
  });
  const bases = colores.map((c, i) => `<base name="${escapeXml(`Color ${i + 1}`)}" displaycolor="${c.toUpperCase()}FF"/>`).join('');
  const modelo = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="es-AR" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Title">${escapeXml(title)}</metadata><metadata name="Application">3d-print-separator-tool</metadata><resources><basematerials id="1">${bases}</basematerials>${objetos}</resources><build>${items}</build></model>`;
  return writeZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="text/xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>' },
    { name: '3D/3dmodel.model', data: modelo },
    { name: 'Metadata/model_settings.config', data: `<?xml version="1.0" encoding="UTF-8"?><config>${config}</config>` },
    { name: 'Metadata/project_settings.config', data: JSON.stringify({ filament_colour: colores.map((c) => c.toUpperCase()) }) },
  ]);
}

/**
 * Escribe un 3MF con un solo objeto pintado triángulo por triángulo (`paint_color`, el formato
 * de Bambu y Orca, más `pid`/`p1` del 3MF): para seguir pintando en el slicer.
 * @param {ModelObject} obj @param {PaletteEntry[]} palette
 */
export function write3mfPainted(obj, palette) {
  const f6 = (/** @type {number} */ x) => +x.toFixed(6);
  let v = '', t = '';
  for (let k = 0; k < obj.positions.length; k += 3) v += `<vertex x="${f6(obj.positions[k])}" y="${f6(obj.positions[k + 1])}" z="${f6(obj.positions[k + 2])}"/>`;
  for (let k = 0, i = 0; k < obj.indices.length; k += 3, i++) {
    const c = obj.colors[i];
    t += `<triangle v1="${obj.indices[k]}" v2="${obj.indices[k + 1]}" v3="${obj.indices[k + 2]}" p1="${Math.max(0, c)}"${c > 0 ? ` paint_color="${encodePaintState(c + 1)}"` : ''}/>`;
  }
  const bases = palette.map((p) => `<base name="${escapeXml(p.name)}" displaycolor="${p.color.toUpperCase()}FF"/>`).join('');
  const modelo = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="es-AR" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><basematerials id="1">${bases}</basematerials><object id="2" type="model" name="${escapeXml(obj.name)}" pid="1" pindex="0"><mesh><vertices>${v}</vertices><triangles>${t.replaceAll('<triangle ', '<triangle pid="1" ')}</triangles></mesh></object></resources><build><item objectid="2"/></build></model>`;
  return writeZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>' },
    { name: '3D/3dmodel.model', data: modelo },
  ]);
}
