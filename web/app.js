// La app: abrir un modelo, pintarlo, separarlo y exportar las piezas.
//
// Lo que se ve lo pone threejs-render-engine (estudio, cámara, contorno de selección); los
// materiales de plástico, threejs-material-engine; las medidas, threejs-cad-sdk (vía el núcleo);
// las booleanas, manifold. Acá solo está la interfaz: cada cosa la decide el núcleo (../src/).
import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { createEngine } from '../vendor/threejs-render-engine/src/index.js';
import { createMaterialEngine } from '../vendor/threejs-material-engine/adapters/three/engine.js';
import {
  readModel, createProject, explodeOffsets, arrangeForPrint, write3mf, writeStl, writeZip, compressZip,
  SEPARATION_DEFAULTS, SEPARATION_LIMITS, PAINT_DEFAULTS,
} from '../src/index.js';
import { createSeparatorView } from '../adapters/three/view.js';
import { createManifoldKernel } from '../adapters/manifold/kernel.js';

// el cursor sobre mallas grandes, con BVH
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const $ = (/** @type {string} */ s) => /** @type {HTMLElement} */ (document.querySelector(s));
const $$ = (/** @type {string} */ s) => /** @type {HTMLElement[]} */ ([...document.querySelectorAll(s)]);

// ---------- motor, materiales, vista ----------
const motor = createEngine($('#visor'), { preset: 'studio', area: 160 });
motor.quality(motor.suggestQuality());
const materiales = createMaterialEngine(motor.renderer);
motor.renderer.localClippingEnabled = true; // la vista en corte de las piezas
const vista = createSeparatorView(motor.content);
const canvas = motor.renderer.domElement;

/** Plástico de impresora: color, algo de rugosidad y un relieve muy fino, proyectado sin UV. @param {string} color */
const plastico = (color) => ({
  name: `plástico ${color}`, resolution: 256,
  channels: { baseColor: color, roughness: 0.52, bump: [{ generator: 'noise', params: { scale: 30 }, opacity: 0.18 }] },
  mapping: { type: 'triplanar', scale: 15 },
});
/** @type {Map<string, Promise<THREE.Material>>} */
const cacheMat = new Map();
/** @param {string} color @returns {Promise<THREE.Material>} */
function materialDe(color) {
  let p = cacheMat.get(color);
  if (!p) {
    p = materiales.material(plastico(color)).catch((e) => {
      console.warn('material: uso uno simple', e);
      return new THREE.MeshStandardMaterial({ color, roughness: 0.55 });
    });
    cacheMat.set(color, p);
  }
  return p;
}
/** El material del modelo pintado: blanco, con los colores por vértice. */
const materialPintura = materiales.material(plastico('#ffffff'), { clone: true })
  .catch(() => new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.55 }))
  .then((m) => { /** @type {THREE.MeshStandardMaterial} */ (m).vertexColors = true; m.needsUpdate = true; return m; });

/** @type {Promise<import('../src/separate.js').Kernel> | null} */
let kernelP = null;
const kernel = () => (kernelP ??= createManifoldKernel());

// ---------- estado ----------
/** @type {ReturnType<typeof createProject> | null} */
let proyecto = null;
let actual = 0;
/** @type {'ver' | 'pincel' | 'relleno'} */
let herramienta = 'ver';
let colorActivo = 1;
/** @type {'paint' | 'pieces'} */
let modo = 'paint';
/** @type {import('../src/separate.js').Piece[]} */
let piezas = [];
let piezasViejas = false;
const params = { ...SEPARATION_DEFAULTS };
const pintura = { radius: PAINT_DEFAULTS.radius, angle: PAINT_DEFAULTS.angle, refine: PAINT_DEFAULTS.refine };
let nombreArchivo = 'modelo';

const estado = (/** @type {string} */ t) => { $('#estado').textContent = t; };
const cuadro = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// ---------- abrir ----------
/** @param {ArrayBuffer} bytes @param {string} nombre */
async function abrir(bytes, nombre) {
  estado(`leyendo ${nombre}…`);
  await cuadro();
  try {
    const modelo = await readModel(bytes, { name: nombre });
    nombreArchivo = nombre.replace(/\.[^.]+$/, '');
    proyecto = createProject(modelo);
    proyecto.on('paint', (e) => { if (e.object === actual) { vista.updateColors(e.triangles); marcarViejas(); programarAristas(); programarAreas(); } });
    proyecto.on('geometry', (e) => { if (e.object === actual) mostrarObjeto(); });
    proyecto.on('palette', () => { if (proyecto) vista.setPalette(proyecto.palette); armarPaleta(); armarBase(); marcarViejas(); });
    proyecto.on('history', actualizarHistoria);
    // con más de un color, el pincel arranca con el segundo; con uno solo, se agrega uno para pintar
    if (proyecto.palette.length < 2) proyecto.addColor('#d6461f', 'Rojo');
    colorActivo = 1;
    const sel = /** @type {HTMLSelectElement} */ ($('#objeto'));
    sel.innerHTML = proyecto.objects.map((o, i) => `<option value="${i}">${esc(o.name)} (${o.triangleCount.toLocaleString('es')} triángulos)</option>`).join('');
    // un 3MF con partes sueltas: arrancar con todas juntas
    actual = proyecto.objects.length > 1 ? proyecto.objects.length - 1 : 0;
    sel.value = String(actual);
    piezas = [];
    await mostrarObjeto();
    armarPaleta();
    armarBase();
    actualizarHistoria();
    ponerModo('paint');
    motor.frame();
    const avisos = proyecto.warnings;
    estado(avisos.length ? `abierto, con avisos: ${avisos.join('; ')}` : `${nombre}: ${proyecto.palette.length} colores`);
    // si ya viene de varios colores, separar enseguida
    const colores = new Set(proyecto.object(actual).colors);
    if (colores.size > 1) separarAhora();
  } catch (e) {
    console.error(e);
    estado(`no se pudo abrir: ${/** @type {Error} */ (e).message}`);
  }
}
const esc = (/** @type {string} */ s) => s.replace(/[&<>"]/g, (c) => /** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

async function mostrarObjeto() {
  if (!proyecto) return;
  vista.setModel(proyecto.object(actual), proyecto.palette, await materialPintura);
  const o = proyecto.object(actual);
  const t = proyecto.topology(actual);
  let maxLado = 0;
  for (let k = 0; k < o.indices.length; k += 3) for (let e = 0; e < 3; e++) {
    const a = o.indices[k + e] * 3, b = o.indices[k + (e + 1) % 3] * 3;
    maxLado = Math.max(maxLado, Math.hypot(o.positions[a] - o.positions[b], o.positions[a + 1] - o.positions[b + 1], o.positions[a + 2] - o.positions[b + 2]));
  }
  $('#infoMalla').textContent = `${t.triangleCount.toLocaleString('es')} triángulos; el lado más largo mide ${maxLado.toFixed(1)} mm. Para pintar más fino que eso, refiná.`;
  aristas();
  armarPaleta();
}

/** @param {File} f */
async function abrirArchivo(f) { abrir(await f.arrayBuffer(), f.name); }
/** @type {HTMLInputElement} */ ($('#archivo')).onchange = (e) => { const f = /** @type {HTMLInputElement} */ (e.target).files?.[0]; if (f) abrirArchivo(f); };
/** @type {HTMLSelectElement} */ ($('#ejemplos')).onchange = async (e) => {
  const s = /** @type {HTMLSelectElement} */ (e.target);
  if (!s.value) return;
  const url = s.value;
  s.value = '';
  estado('bajando el ejemplo…');
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status}`);
    abrir(await r.arrayBuffer(), url.split('/').pop() ?? 'ejemplo.3mf');
  } catch (err) { estado(`no se pudo bajar el ejemplo (${/** @type {Error} */ (err).message})`); }
};
// soltar un archivo sobre la página
addEventListener('dragover', (e) => { e.preventDefault(); $('#soltar').hidden = false; });
addEventListener('dragleave', (e) => { if (!e.relatedTarget) $('#soltar').hidden = true; });
addEventListener('drop', (e) => { e.preventDefault(); $('#soltar').hidden = true; const f = e.dataTransfer?.files?.[0]; if (f) abrirArchivo(f); });
/** @type {HTMLSelectElement} */ ($('#objeto')).onchange = (e) => { actual = +(/** @type {HTMLSelectElement} */ (e.target)).value; piezas = []; mostrarObjeto().then(() => { motor.frame(); ponerModo('paint'); }); };

// ---------- paleta ----------
function armarPaleta() {
  if (!proyecto) return;
  const o = proyecto.object(actual), t = proyecto.topology(actual);
  /** @type {number[]} */
  const area = proyecto.palette.map(() => 0);
  for (let i = 0; i < t.triangleCount; i++) area[o.colors[i]] += t.areas[i];
  $('#paleta').innerHTML = proyecto.palette.map((p, i) => `
    <div class="color${i === colorActivo ? ' activo' : ''}" data-i="${i}" title="Pintar con ${esc(p.name)}">
      <input type="color" value="${p.color}" data-i="${i}" aria-label="Color de ${esc(p.name)}" />
      <span class="nombre">${esc(p.name)}</span>
      <span class="area">${area[i] > 0 ? `${area[i] < 10 ? area[i].toFixed(1) : Math.round(area[i])} mm²` : ''}</span>
    </div>`).join('');
  for (const el of $$('.color')) el.onclick = (e) => { if (/** @type {HTMLElement} */ (e.target).tagName !== 'INPUT') { colorActivo = +(el.dataset.i ?? 0); ultimoPrevio = -1; vista.preview(null); armarPaleta(); esquema(); } };
  for (const el of /** @type {HTMLInputElement[]} */ ($$('.color input'))) el.oninput = () => proyecto?.setColor(+(el.dataset.i ?? 0), { color: el.value });
}
let areasPend = 0;
const programarAreas = () => { clearTimeout(areasPend); areasPend = setTimeout(armarPaleta, 250); };
$('#agregarColor').onclick = () => {
  if (!proyecto) return;
  const sugeridos = ['#d6461f', '#2b6cb0', '#2e9a5c', '#f2c12e', '#1f1f1f', '#9b4dca', '#e07a1f', '#f2f2f2'];
  const usados = new Set(proyecto.palette.map((p) => p.color));
  colorActivo = proyecto.addColor(sugeridos.find((c) => !usados.has(c)) ?? '#888888');
  armarPaleta();
};
function armarBase() {
  if (!proyecto) return;
  const s = /** @type {HTMLSelectElement} */ ($('#base'));
  const v = s.value;
  s.innerHTML = '<option value="">automático (el de más área)</option>' + proyecto.palette.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('');
  s.value = v;
}
$('#base').onchange = () => { marcarViejas(); programarSeparar(); };

// ---------- herramientas ----------
/** @param {'ver' | 'pincel' | 'relleno'} h */
function ponerHerramienta(h) {
  herramienta = h;
  for (const b of $$('[data-herr]')) b.classList.toggle('activo', b.dataset.herr === h);
  for (const g of $$('#pintar [data-para]')) g.hidden = !(g.dataset.para ?? '').split(' ').includes(h);
  canvas.style.cursor = h === 'ver' ? '' : 'crosshair';
  vista.cursor(null);
  vista.preview(null);
  if (h !== 'ver' && modo !== 'paint') ponerModo('paint');
}
for (const b of $$('[data-herr]')) b.onclick = () => ponerHerramienta(/** @type {any} */ (b.dataset.herr));

/** Un deslizador con su número al lado. @param {string} id @param {number} valor @param {(v: number) => void} cambio @param {(v: number) => string} [fmt] */
function deslizador(id, valor, cambio, fmt = (v) => `${v}`) {
  const el = /** @type {HTMLInputElement} */ ($(`#${id}`));
  const out = /** @type {HTMLOutputElement} */ (document.querySelector(`output[for=${id}]`));
  el.value = String(valor);
  const mostrar = () => { if (out) out.textContent = fmt(+el.value); };
  mostrar();
  el.oninput = () => { mostrar(); cambio(+el.value); };
  return el;
}
deslizador('radio', pintura.radius, (v) => { pintura.radius = v; }, (v) => `${v.toFixed(1)} mm`);
deslizador('angulo', pintura.angle, (v) => { pintura.angle = v; vista.preview(null); ultimoPrevio = -1; programarAristas(); }, (v) => `${v}°`);
/** @type {HTMLInputElement} */ ($('#lado')).value = String(pintura.refine);
$('#verAristas').onchange = aristas;
$('#refinar').onclick = async () => {
  if (!proyecto) return;
  const lado = +(/** @type {HTMLInputElement} */ ($('#lado')).value);
  estado(`refinando a ${lado} mm…`);
  await cuadro();
  try {
    estado(proyecto.refine(actual, lado) ? `refinado: ${proyecto.objects[actual].triangleCount.toLocaleString('es')} triángulos` : 'ya estaba refinado a ese lado');
  } catch (e) { estado(/** @type {Error} */ (e).message); }
};

// ---------- aristas ----------
function aristas() {
  if (!proyecto || !(/** @type {HTMLInputElement} */ ($('#verAristas')).checked)) { vista.showEdges(null); return; }
  vista.showEdges(proyecto.edges(actual, { angle: pintura.angle, colors: true }));
}
let aristasPend = 0;
const programarAristas = () => { clearTimeout(aristasPend); aristasPend = setTimeout(aristas, 200); };

// ---------- pintar con el puntero ----------
const rayo = new THREE.Raycaster();
/** @param {{ clientX: number, clientY: number }} e */
function bajo(e) {
  if (!proyecto || modo !== 'paint') return null;
  const r = canvas.getBoundingClientRect();
  const { origin, dir } = motor.view.ray([e.clientX - r.left, e.clientY - r.top]);
  rayo.set(new THREE.Vector3(...origin), new THREE.Vector3(...dir));
  return vista.pick(rayo);
}
// el botón izquierdo sobre el modelo, con pincel o relleno, es de la app; afuera, de la cámara
motor.view.claim((e) => {
  if (e.type !== 'pointerdown' || herramienta === 'ver' || modo !== 'paint') return 'camera';
  const p = /** @type {PointerEvent} */ (e);
  if (p.button !== 0 || p.altKey) return 'camera';
  return bajo(p) ? 'app' : 'camera';
});
let trazando = false;
/** @type {number[] | null} */
let ultimoPunto = null;
/** @type {number | null} */
let soloSobre = null;
let ultimoPrevio = -1;
/** @param {{ triangle: number, point: number[] }} h */
function pincelada(h) {
  if (!proyecto) return;
  proyecto.brush(actual, {
    triangle: h.triangle, point: h.point, radius: pintura.radius, color: colorActivo,
    angle: /** @type {HTMLInputElement} */ ($('#respetarAristas')).checked ? pintura.angle : null,
    only: soloSobre,
  });
  ultimoPunto = h.point;
}
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.altKey || herramienta === 'ver' || !proyecto) return;
  const h = bajo(e);
  if (!h) return;
  if (herramienta === 'relleno') {
    proyecto.fill(actual, { triangle: h.triangle, color: colorActivo, angle: pintura.angle, sameColor: /** @type {HTMLInputElement} */ ($('#mismoColor')).checked });
    vista.preview(null);
    ultimoPrevio = -1;
    return;
  }
  trazando = true;
  canvas.setPointerCapture(e.pointerId);
  soloSobre = /** @type {HTMLInputElement} */ ($('#soloBase')).checked ? proyecto.object(actual).colors[h.triangle] : null;
  proyecto.begin();
  pincelada(h);
});
canvas.addEventListener('pointermove', (e) => {
  if (herramienta === 'ver' || !proyecto || modo !== 'paint') return;
  const h = bajo(e);
  if (herramienta === 'pincel') {
    vista.cursor(h ? { point: h.point, normal: h.normal, radius: pintura.radius } : null);
    if (trazando && h && (!ultimoPunto || Math.hypot(h.point[0] - ultimoPunto[0], h.point[1] - ultimoPunto[1], h.point[2] - ultimoPunto[2]) > pintura.radius / 3)) pincelada(h);
  } else if (herramienta === 'relleno' && !(e.buttons & 1)) {
    // lo que pintaría el relleno, bajo el cursor
    if (!h) { if (ultimoPrevio >= 0) { vista.preview(null); ultimoPrevio = -1; } return; }
    // la zona es la misma desde cualquiera de sus triángulos: se recalcula solo al salir de ella
    if (ultimoPrevio < 0 || !marcaPrevia.has(h.triangle)) {
      ultimoPrevio = h.triangle;
      previa = proyecto.preview(actual, { triangle: h.triangle, angle: pintura.angle, sameColor: /** @type {HTMLInputElement} */ ($('#mismoColor')).checked });
      marcaPrevia = new Set(previa);
      vista.preview(previa, proyecto.palette[colorActivo]?.color);
    }
  }
});
/** @type {Int32Array | null} */
let previa = null;
let marcaPrevia = new Set();
const terminarTrazo = () => { if (trazando) { trazando = false; ultimoPunto = null; proyecto?.commit(); } };
canvas.addEventListener('pointerup', terminarTrazo);
canvas.addEventListener('pointercancel', terminarTrazo);
canvas.addEventListener('pointerleave', () => { vista.cursor(null); if (!trazando) { vista.preview(null); ultimoPrevio = -1; } });

// ---------- deshacer ----------
function actualizarHistoria() {
  /** @type {HTMLButtonElement} */ ($('#deshacer')).disabled = !proyecto?.canUndo;
  /** @type {HTMLButtonElement} */ ($('#rehacer')).disabled = !proyecto?.canRedo;
}
$('#deshacer').onclick = () => proyecto?.undo();
$('#rehacer').onclick = () => proyecto?.redo();
$('#exportarPintado').onclick = async () => { if (proyecto) bajar(await compressZip(proyecto.paintedModel(actual)), `${nombreArchivo}-pintado.3mf`, 'model/3mf'); };

// ---------- separar ----------
const ETIQUETAS = /** @type {Record<string, [string, string, string]>} */ ({
  depth: ['Profundidad del color', 'mm', 'Cuánto entra el color desde la superficie: el espesor de la pieza de color (zonas pintadas).'],
  inset: ['Achique de la extrusión', 'mm', 'Cuánto más chica que el color es la extrusión: deja un escalón que tapa la junta.'],
  length: ['Largo de la extrusión', 'mm', 'El tramo recto que entra en la otra pieza.'],
  cone: ['Largo del cono', 'mm', 'La punta en cono que centra la pieza al encastrar (0: sin cono).'],
  tip: ['Punta del cono', '×', 'El tamaño de la punta respecto de la base del cono (0: termina en punta).'],
  clearance: ['Holgura por lado', 'mm', 'El juego entre la extrusión y su alojamiento. 0,1–0,2 mm en PLA.'],
});
for (const [k, [nombre, unidad, ayuda]] of Object.entries(ETIQUETAS)) {
  const l = SEPARATION_LIMITS[/** @type {keyof typeof SEPARATION_LIMITS} */ (k)];
  const lab = document.createElement('label');
  lab.className = 'deslizador';
  lab.title = ayuda;
  lab.innerHTML = `${nombre} <input id="p-${k}" type="range" min="${l.min}" max="${l.max}" step="${l.step}" /><output for="p-${k}"></output>`;
  $('#parametros').append(lab);
  deslizador(`p-${k}`, /** @type {any} */ (params)[k], (v) => { /** @type {any} */ (params)[k] = v; esquema(); marcarViejas(); programarSeparar(); }, (v) => `${unidad === '×' ? v.toFixed(2) : v.toFixed(2).replace(/0$/, '')} ${unidad}`);
}
{
  const l = SEPARATION_LIMITS.explode;
  const el = /** @type {HTMLInputElement} */ ($('#explode'));
  Object.assign(el, { min: l.min, max: l.max, step: l.step });
  deslizador('explode', params.explode, (v) => { params.explode = v; vista.explode(explodeOffsets(piezas, v)); if (v > 0 && modo !== 'pieces' && piezas.length) ponerModo('pieces'); }, (v) => `${v} mm`);
}

/** El corte del encastre, con las medidas de ahora. */
function esquema() {
  const W = 220, s = 12; // px por mm
  const p = params;
  const ancho = 10; // un color de 10 mm de ancho, de ejemplo
  const x0 = W / 2, y0 = 22;
  const mm = (/** @type {number} */ v) => v * s;
  const anchoT = Math.max(0.6, ancho - 2 * p.inset);
  const ys = y0 + mm(p.depth), yc = ys + mm(p.length), yp = yc + mm(p.cone);
  const punta = anchoT * p.tip;
  const tapon = `M${x0 - mm(anchoT) / 2},${ys} V${yc} L${x0 - mm(punta) / 2},${yp} H${x0 + mm(punta) / 2} L${x0 + mm(anchoT) / 2},${yc} V${ys} Z`;
  const h = p.clearance;
  const anchoH = anchoT + 2 * h, puntaH = Math.min(anchoH, anchoH * (p.cone > 0 ? Math.min(1, p.tip + h / Math.max(p.cone, 1e-6)) : 1));
  const ych = yc + (p.cone > 0 ? 0 : mm(h)), yph = yc + mm(p.cone > 0 ? p.cone + h : h);
  const hueco = `M${x0 - mm(anchoH) / 2},${ys} V${ych} L${x0 - mm(puntaH) / 2},${yph} H${x0 + mm(puntaH) / 2} L${x0 + mm(anchoH) / 2},${ych} V${ys}`;
  const color = proyecto?.palette[colorActivo]?.color ?? '#d6461f';
  const base = proyecto?.palette[0]?.color ?? '#dddddd';
  /** @type {SVGSVGElement} */ ($('#esquema') /** @type {any} */).setAttribute('viewBox', `0 0 ${W + 40} ${Math.max(130, yp + 16)}`);
  $('#esquema').innerHTML = `
    <rect x="8" y="${y0}" width="${W - 16}" height="${Math.max(100, yp - y0 + 8)}" fill="${base}" stroke="#0004"/>
    <path d="${hueco}" fill="#fff" stroke="#0006" stroke-dasharray="3 2"/>
    <rect x="${x0 - mm(ancho) / 2}" y="${y0}" width="${mm(ancho)}" height="${mm(p.depth)}" fill="${color}" stroke="#0006"/>
    <path d="${tapon}" fill="${color}" stroke="#0006"/>
    <text x="${x0 + mm(ancho) / 2 + 6}" y="${y0 + mm(p.depth) / 2 + 4}" font-size="10" fill="currentColor">${p.depth} mm</text>
    <text x="${x0 + mm(anchoT) / 2 + 6}" y="${(ys + yc) / 2 + 4}" font-size="10" fill="currentColor">${p.length} mm</text>
    <text x="${x0 + mm(anchoT) / 2 + 6}" y="${(yc + yp) / 2 + 4}" font-size="10" fill="currentColor">cono ${p.cone} mm</text>
    <text x="12" y="14" font-size="10" fill="currentColor">holgura ${p.clearance} mm · achique ${p.inset} mm</text>`;
}
esquema();

function marcarViejas() { if (piezas.length) piezasViejas = true; }
let separarPend = 0;
function programarSeparar() {
  clearTimeout(separarPend);
  if (!(/** @type {HTMLInputElement} */ ($('#auto')).checked) || !proyecto || (!piezas.length && modo !== 'pieces')) return;
  separarPend = setTimeout(separarAhora, 400);
}
let corrida = 0;
async function separarAhora() {
  if (!proyecto) return;
  const yo = ++corrida;
  const boton = /** @type {HTMLButtonElement} */ ($('#separarBtn'));
  boton.disabled = true;
  try {
    estado('cargando las booleanas…');
    const K = await kernel();
    estado('separando…');
    await cuadro();
    const t0 = performance.now();
    const baseSel = /** @type {HTMLSelectElement} */ ($('#base')).value;
    const { explode, ...geo } = params;
    const r = proyecto.separate(actual, { kernel: K, params: geo, base: baseSel === '' ? null : +baseSel, onProgress: (t) => estado(t) });
    if (yo !== corrida) return;
    piezas = r.pieces;
    piezasViejas = false;
    const pal = proyecto.palette;
    const mats = await Promise.all(piezas.map((p) => materialDe(pal[p.color]?.color ?? '#999999')));
    vista.setPieces(piezas, (_, p) => mats[piezas.indexOf(p)]);
    vista.explode(explodeOffsets(piezas, params.explode));
    listarPiezas(r.warnings);
    ponerModo('pieces');
    estado(`${piezas.length} piezas en ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  } catch (e) {
    console.error(e);
    estado(`no se pudo separar: ${/** @type {Error} */ (e).message}`);
  } finally {
    boton.disabled = false;
  }
}
$('#separarBtn').onclick = separarAhora;

// ---------- corte ----------
/** El plano de corte, en x del modelo; el deslizador va de un lado al otro de las piezas. */
function corte() {
  const on = /** @type {HTMLInputElement} */ ($('#corte')).checked;
  $('#corteFila').hidden = !on;
  vista.section(on ? { at: corteX } : null);
}
let corteX = 0;
deslizador('cortePos', 0, (v) => { corteX = v; corte(); }, (v) => `${v} mm`);
$('#corte').onchange = () => {
  // arranca en el medio de la segunda pieza (la de color), así el corte pasa por su extrusión
  const p = piezas[1] ?? piezas[0];
  if (p && /** @type {HTMLInputElement} */ ($('#corte')).checked) {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < p.positions.length; i += 3) { min = Math.min(min, p.positions[i]); max = Math.max(max, p.positions[i]); }
    corteX = Math.round(min + max) / 2;
    const el = /** @type {HTMLInputElement} */ ($('#cortePos'));
    el.min = String(Math.floor(min - 20)); el.max = String(Math.ceil(max + 20)); el.value = String(corteX);
    el.dispatchEvent(new Event('input'));
  }
  corte();
};

/** @param {string[]} avisos */
function listarPiezas(avisos) {
  const pal = proyecto?.palette ?? [];
  const rol = { base: 'base', inlay: 'incrustado', part: 'parte' };
  $('#piezas').innerHTML = piezas.map((p, i) => `<li data-i="${i}" title="${esc(p.name)}"><span class="muestra" style="background:${pal[p.color]?.color}"></span><span>${esc(pal[p.color]?.name ?? '')} · ${rol[p.role]}</span><span class="vol">${(p.volume / 1000).toFixed(2)} cm³</span></li>`).join('');
  $('#avisos').innerHTML = avisos.map((a) => `<li>${esc(a)}</li>`).join('');
  for (const li of $$('#piezas li')) {
    li.onmouseenter = () => motor.select([vista.pieceMeshes[+(li.dataset.i ?? 0)]]);
    li.onmouseleave = () => motor.select([]);
  }
  for (const b of ['#exportar3mf', '#exportarStl']) /** @type {HTMLButtonElement} */ ($(b)).disabled = !piezas.length;
}

// ---------- modos ----------
/** @param {'paint' | 'pieces'} m */
function ponerModo(m) {
  modo = m;
  vista.mode(m);
  $('#modoPintar').classList.toggle('activo', m === 'paint');
  $('#modoPiezas').classList.toggle('activo', m === 'pieces');
  document.body.classList.toggle('pintando', m === 'paint');
  if (m === 'pieces') vista.preview(null);
  else motor.select([]);
}
$('#modoPintar').onclick = () => ponerModo('paint');
$('#modoPiezas').onclick = () => { if (!piezas.length || piezasViejas) separarAhora(); else ponerModo('pieces'); };
$('#encuadrar').onclick = () => motor.frame();

// ---------- exportar ----------
/** @param {BlobPart} datos @param {string} nombre @param {string} tipo */
function bajar(datos, nombre, tipo) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([datos], { type: tipo }));
  a.download = nombre;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const paraImprimir = () => arrangeForPrint(piezas, { gap: 6 });
$('#exportar3mf').onclick = async () => {
  if (!proyecto || !piezas.length) return;
  const pal = proyecto.palette;
  const datos = write3mf(paraImprimir().map((p) => ({ name: p.name, color: pal[p.color].color, filament: pal[p.color].filament ?? p.color + 1, positions: p.positions, indices: p.indices })), { title: nombreArchivo });
  bajar(await compressZip(datos), `${nombreArchivo}-separado.3mf`, 'model/3mf');
};
$('#exportarStl').onclick = async () => {
  if (!piezas.length) return;
  const archivos = paraImprimir().map((p, i) => ({ name: `${String(i + 1).padStart(2, '0')}-${p.name.replace(/[^\p{L}\p{N}]+/gu, '-')}.stl`, data: writeStl(p, p.name) }));
  bajar(await compressZip(writeZip(archivos)), `${nombreArchivo}-stl.zip`, 'application/zip');
};

// ---------- teclado ----------
addEventListener('keydown', (e) => {
  if (/** @type {HTMLElement} */ (e.target).tagName === 'INPUT' && /** @type {HTMLInputElement} */ (e.target).type !== 'range') return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); if (e.shiftKey) proyecto?.redo(); else proyecto?.undo(); }
  else if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); proyecto?.redo(); }
  else if (k === 'b') ponerHerramienta('pincel');
  else if (k === 'g') ponerHerramienta('relleno');
  else if (k === 'v' || k === 'escape') ponerHerramienta('ver');
  else if (k === 'f') motor.frame();
  else if (k === '[' || k === ']') {
    pintura.radius = Math.max(0.2, Math.min(20, pintura.radius * (k === ']' ? 1.25 : 0.8)));
    const el = /** @type {HTMLInputElement} */ ($('#radio'));
    el.value = String(pintura.radius);
    el.dispatchEvent(new Event('input'));
  }
});

ponerHerramienta('ver');
ponerModo('paint');
estado('Abrí un 3MF o un STL, o elegí un ejemplo.');
// para probar desde la consola
Object.assign(window, { motor, vista, THREE, materiales, app: { get proyecto() { return proyecto; }, get piezas() { return piezas; }, abrir, separarAhora, ponerHerramienta, ponerModo, params } });
// un ejemplo de arranque: ?ejemplo=placa-pintada
const ej = new URLSearchParams(location.search).get('ejemplo');
if (ej) fetch(`../examples/${ej}.3mf`).then((r) => r.arrayBuffer()).then((b) => abrir(b, `${ej}.3mf`));
