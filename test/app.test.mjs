// Las pruebas en Node: leer 3MF (núcleo, Bambu/Orca, Prusa), pintar, detectar aristas, refinar,
// separar con el kernel de manifold, deshacer, y que la ayuda coincida con la API. Lo que se
// dibuja se prueba en el navegador (web/, ver README).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import {
  readModel, createProject, read3mf, write3mf, write3mfPainted, readStl, writeStl, readZip, writeZip,
  decodePaint, encodePaintState, weld, topology, components, brush, fill, edges, refine, separate,
  explodeOffsets, checkParams, SEPARATION_DEFAULTS, PROJECT_MEMBERS, MODULE_MEMBERS, memberNames, help,
} from '../src/index.js';
import * as API from '../src/index.js';
import { parseXml } from '../src/xml.js';
import { volumeOf, boundsOf } from '../src/mesh.js';
import { createManifoldKernel } from '../adapters/manifold/kernel.js';

const enc = new TextEncoder();

/** Una caja de lados s, centrada en c: 8 vértices, 12 triángulos hacia afuera. */
function caja([sx, sy, sz], [cx, cy, cz] = [0, 0, 0]) {
  const positions = [];
  for (const z of [0, 1]) for (const y of [0, 1]) for (const x of [0, 1]) positions.push(cx + (x - 0.5) * sx, cy + (y - 0.5) * sy, cz + (z - 0.5) * sz);
  const indices = [];
  for (const [a, b, c, d] of [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]) indices.push(a, b, c, a, c, d);
  return { positions, indices };
}
const xmlCaja = ([sx, sy, sz], extra = () => '') => {
  const c = caja([sx, sy, sz], [sx / 2, sy / 2, sz / 2]);
  let v = '', t = '';
  for (let i = 0; i < c.positions.length; i += 3) v += `<vertex x="${c.positions[i]}" y="${c.positions[i + 1]}" z="${c.positions[i + 2]}"/>`;
  for (let i = 0; i < c.indices.length; i += 3) t += `<triangle v1="${c.indices[i]}" v2="${c.indices[i + 1]}" v3="${c.indices[i + 2]}"${extra(i / 3)}/>`;
  return `<mesh><vertices>${v}</vertices><triangles>${t}</triangles></mesh>`;
};
const paquete = (archivos) => writeZip([
  { name: '[Content_Types].xml', data: '<Types/>' },
  { name: '_rels/.rels', data: '<Relationships><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>' },
  ...Object.entries(archivos).map(([name, data]) => ({ name, data })),
]);
/** ¿Cerrada? Cada arista con su vecino. */
const cerrada = (o) => topology(o).neighbors.every((n) => n >= 0);
const cerca = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''}: ${a} no está a ${tol} de ${b}`);

let kernel;
const K = async () => (kernel ??= await createManifoldKernel());

// ---------- ZIP y XML ----------

test('zip: lo que se escribe se lee igual, también comprimido con deflate', async () => {
  const z = readZip(writeZip([{ name: 'a.txt', data: 'hola' }, { name: 'dir/b.bin', data: new Uint8Array([1, 2, 3]) }]));
  assert.deepEqual([...z.keys()], ['a.txt', 'dir/b.bin']);
  assert.equal(new TextDecoder().decode(await z.get('a.txt').read()), 'hola');
  assert.deepEqual([...await z.get('dir/b.bin').read()], [1, 2, 3]);
  // un ZIP con deflate, armado con CompressionStream (lo que escribe un slicer)
  const crudo = new Uint8Array(await new Response(new Blob([enc.encode('x'.repeat(1000))]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  const zip = writeZip([{ name: 'x.txt', data: crudo }]);
  const dv = new DataView(zip.buffer);
  dv.setUint16(8, 8, true); // método deflate en el encabezado local…
  const central = zip.length - 22 - (46 + 5);
  dv.setUint16(central + 10, 8, true); // …y en el directorio central
  dv.setUint32(central + 24, 1000, true);
  assert.equal(new TextDecoder().decode(await readZip(zip).get('x.txt').read()), 'x'.repeat(1000));
  assert.throws(() => readZip(new Uint8Array(10)), /no es un ZIP/);
  // y compressZip lo comprime sin cambiar lo que se lee
  const grande = writeZip([{ name: 'm.xml', data: '<a/>'.repeat(5000) }, { name: 'b.bin', data: new Uint8Array([9, 8]) }]);
  const chico = await API.compressZip(grande);
  assert.ok(chico.length < grande.length / 10);
  assert.equal(new TextDecoder().decode(await readZip(chico).get('m.xml').read()), '<a/>'.repeat(5000));
  assert.deepEqual([...await readZip(chico).get('b.bin').read()], [9, 8]);
});

test('xml: etiquetas, atributos sin prefijo, entidades y comentarios', () => {
  const vistos = [];
  parseXml('<?xml version="1.0"?><!-- c --><m:model unit="mm"><a x=\'1\' p:path="/3D/o.model" v="&lt;&amp;&#65;"/></m:model>', {
    open: (n, a, vacia) => vistos.push(['open', n, a, vacia]), close: (n) => vistos.push(['close', n]),
  });
  assert.deepEqual(vistos, [['open', 'model', { unit: 'mm' }, false], ['open', 'a', { x: '1', path: '/3D/o.model', v: '<&A' }, true], ['close', 'a'], ['close', 'model']]);
});

// ---------- 3MF ----------

test('3MF del núcleo: basematerials por objeto y por triángulo, colorgroup, unidades', async () => {
  const xml = `<?xml version="1.0"?><model unit="centimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
    <resources><basematerials id="1"><base name="Blanco" displaycolor="#FFFFFFFF"/><base name="Rojo" displaycolor="#F00"/></basematerials>
    <m:colorgroup id="5"><m:color color="#00FF00"/></m:colorgroup>
    <object id="2" type="model" pid="1" pindex="0">${xmlCaja([2, 2, 1], (t) => (t === 2 || t === 3 ? ' pid="1" p1="1"' : t === 4 ? ' pid="5" p1="0"' : ''))}</object></resources>
    <build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 10 0 0"/></build></model>`;
  const m = await read3mf(paquete({ '3D/3dmodel.model': xml }));
  assert.equal(m.objects.length, 1);
  const o = m.objects[0];
  assert.deepEqual(m.palette.map((p) => [p.color, p.name]), [['#ffffff', 'Blanco'], ['#ff0000', 'Rojo'], ['#00ff00', '#00ff00']]);
  assert.deepEqual([...o.colors], [0, 0, 1, 1, 2, 0, 0, 0, 0, 0, 0, 0]);
  const b = boundsOf(o.positions);
  assert.deepEqual([b.min, b.max], [[100, 0, 0], [120, 20, 10]], 'en mm, con la transformación del ítem (en la unidad del archivo)');
  cerca(volumeOf(o), 4000, 1e-9, 'mira hacia afuera');
});

test('3MF: componentes en otro archivo, espejo, y micrones', async () => {
  const obj = `<?xml version="1.0"?><model unit="micron"><resources><object id="1" type="model">${xmlCaja([1000, 1000, 1000])}</object></resources><build/></model>`;
  const main = `<?xml version="1.0"?><model unit="millimeter" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources>
    <object id="7" type="model"><components><component p:path="/3D/Objects/o.model" objectid="1"/><component p:path="/3D/Objects/o.model" objectid="1" transform="-1 0 0 0 1 0 0 0 1 -5 0 0"/></components></object>
    <object id="8" type="support"><components><component p:path="/3D/Objects/o.model" objectid="1"/></components></object>
    </resources><build><item objectid="7"/><item objectid="8"/></build></model>`;
  const m = await read3mf(paquete({ '3D/3dmodel.model': main, '3D/Objects/o.model': obj }), { name: 'x.3mf' });
  assert.equal(m.objects.length, 1, 'un ítem de soporte no entra');
  assert.match(m.warnings.join(), /support/);
  const o = weld(m.objects[0]);
  assert.equal(o.indices.length / 3, 24);
  cerca(volumeOf(o), 2, 1e-9, 'dos cubos de 1 mm, el espejado también mirando hacia afuera');
  assert.ok(cerrada(o));
});

test('3MF de Bambu/Orca: filamento por parte y por objeto, colores del proyecto, modificadores afuera', async () => {
  const parte = (id) => `<object id="${id}" type="model">${xmlCaja([10, 10, 10])}</object>`;
  const obj = `<?xml version="1.0"?><model unit="millimeter"><resources>${parte(1)}${parte(2)}${parte(3)}</resources><build/></model>`;
  const main = `<?xml version="1.0"?><model unit="millimeter" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources>
    <object id="4" type="model"><components>
      <component p:path="/3D/Objects/object_1.model" objectid="1"/>
      <component p:path="/3D/Objects/object_1.model" objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 10"/>
      <component p:path="/3D/Objects/object_1.model" objectid="3" transform="1 0 0 0 1 0 0 0 1 0 0 20"/>
    </components></object></resources><build><item objectid="4"/></build></model>`;
  const config = `<?xml version="1.0"?><config><object id="4"><metadata key="name" value="Torre"/><metadata key="extruder" value="1"/>
    <part id="1" subtype="normal_part"><metadata key="name" value="abajo"/></part>
    <part id="2" subtype="normal_part"><metadata key="extruder" value="3"/></part>
    <part id="3" subtype="modifier_part"><metadata key="extruder" value="2"/></part>
  </object><plate><metadata key="plater_id" value="1"/></plate></config>`;
  const m = await read3mf(paquete({
    '3D/3dmodel.model': main, '3D/Objects/object_1.model': obj, 'Metadata/model_settings.config': config,
    'Metadata/project_settings.config': JSON.stringify({ filament_colour: ['#FFFFFF', '#00AE42', '#C12E1F'] }),
  }));
  const o = m.objects[0];
  assert.equal(o.name, 'Torre');
  assert.equal(o.indices.length / 3, 24, 'el modificador no es geometría');
  assert.deepEqual(m.palette.map((p) => [p.name, p.color, p.filament]), [['Filamento 1', '#ffffff', 1], ['Filamento 3', '#c12e1f', 3]]);
  assert.deepEqual([...new Set(o.colors.slice(0, 12))], [0]);
  assert.deepEqual([...new Set(o.colors.slice(12))], [1]);
});

test('pintura de slicer: el árbol de TriangleSelector, leído como lo escribe Bambu', () => {
  let n = 3;
  const medios = new Map();
  const medio = (a, b) => { const k = a < b ? `${a},${b}` : `${b},${a}`; if (!medios.has(k)) medios.set(k, n++); return medios.get(k); };
  assert.deepEqual(decodePaint('4', [0, 1, 2], medio), [{ v: [0, 1, 2], state: 1 }]);
  assert.deepEqual(decodePaint('8', [0, 1, 2], medio), [{ v: [0, 1, 2], state: 2 }]);
  assert.deepEqual(decodePaint('2C', [0, 1, 2], medio), [{ v: [0, 1, 2], state: 5 }], 'estado ≥ 3: "11" y un nibble más');
  assert.deepEqual(decodePaint('2FC', [0, 1, 2], medio), [{ v: [0, 1, 2], state: 20 }]);
  for (const s of [0, 1, 2, 3, 7, 17, 18, 30]) assert.deepEqual(decodePaint(encodePaintState(s), [0, 1, 2], medio)[0].state, s);
  // partido en 4 (código 3: tres lados, especial 0); los hijos van del último al primero:
  // el texto se lee de atrás para adelante → '3', y después hijo 3, 2, 1, 0
  const h = decodePaint('0084' + '3', [0, 1, 2], medio);
  assert.equal(h.length, 4);
  assert.deepEqual(h.map((x) => x.state), [1, 2, 0, 0], 'hijo 3: 1, hijo 2: 2, hijos 1 y 0: sin pintar');
  const [m01, m12, m20] = [medio(0, 1), medio(1, 2), medio(2, 0)];
  assert.deepEqual(h[0].v, [m01, m12, m20], 'el hijo 3 es el del medio');
  assert.deepEqual(h[1].v, [m12, 2, m20]);
  assert.equal(decodePaint('3', [0, 1, 2], medio), null, 'un árbol cortado no se lee');
  assert.equal(decodePaint('zz', [0, 1, 2], medio), null);
});

test('3MF pintado: triángulos partidos de varios colores, cosidos en una malla cerrada', async () => {
  // la cara de arriba de la caja (triángulos 2 y 3) partida: uno en 4 con un hijo pintado del filamento 2
  const pint = { 2: '0084' + '3', 3: '8' };
  const xml = `<?xml version="1.0"?><model unit="millimeter"><resources><object id="1" type="model">${xmlCaja([10, 10, 10], (t) => (pint[t] ? ` paint_color="${pint[t]}"` : ''))}</object></resources><build><item objectid="1"/></build></model>`;
  const m = await readModel(paquete({ '3D/3dmodel.model': xml, 'Metadata/project_settings.config': JSON.stringify({ filament_colour: ['#FFFFFF', '#FF0000'] }) }));
  const o = m.objects[0];
  assert.ok(cerrada(o), 'sin vértices colgados: se puede separar');
  cerca(volumeOf(o), 1000, 1e-9);
  assert.deepEqual(m.palette.map((p) => p.color), ['#ffffff', '#ff0000']);
  const t = topology(o);
  let rojo = 0;
  for (let i = 0; i < t.triangleCount; i++) if (o.colors[i] === 1) rojo += t.areas[i];
  cerca(rojo, 50 + 50 / 4, 1e-9, 'un triángulo entero (50 mm²) y un cuarto de otro');
  // y escrito pintado, se vuelve a leer igual
  const otra = await readModel(write3mfPainted(o, m.palette));
  assert.deepEqual([...otra.objects[0].colors], [...o.colors]);
});

test('3MF de Prusa: volúmenes por rango de triángulos, modificadores afuera, colores de extrusor', async () => {
  const dos = `<?xml version="1.0"?><model unit="millimeter"><resources><object id="1" type="model"><mesh><vertices>${
    caja([10, 10, 10], [5, 5, 5]).positions.reduce((s, _, i, p) => (i % 3 ? s : s + `<vertex x="${p[i]}" y="${p[i + 1]}" z="${p[i + 2]}"/>`), '')
    + caja([10, 10, 10], [5, 5, 15]).positions.reduce((s, _, i, p) => (i % 3 ? s : s + `<vertex x="${p[i]}" y="${p[i + 1]}" z="${p[i + 2]}"/>`), '')
  }</vertices><triangles>${[...caja([1, 1, 1]).indices, ...caja([1, 1, 1]).indices.map((v) => v + 8)].reduce((s, _, i, ix) => (i % 3 ? s : s + `<triangle v1="${ix[i]}" v2="${ix[i + 1]}" v3="${ix[i + 2]}"/>`), '')}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
  const conf = `<?xml version="1.0"?><config><object id="1" instances_count="1"><metadata type="object" key="extruder" value="1"/>
    <volume firstid="0" lastid="11"><metadata type="volume" key="volume_type" value="ModelPart"/></volume>
    <volume firstid="12" lastid="23"><metadata type="volume" key="extruder" value="2"/><metadata type="volume" key="volume_type" value="ParameterModifier"/></volume></object></config>`;
  const m = await read3mf(paquete({ '3D/3dmodel.model': dos, 'Metadata/Slic3r_PE_model.config': conf, 'Metadata/Slic3r_PE.config': '; extruder_colour = "";""\n; filament_colour = #FF8000;#DB5182\n' }));
  assert.equal(m.objects[0].indices.length / 3, 12, 'el modificador no entra');
  assert.deepEqual(m.palette.map((p) => p.color), ['#ff8000']);
});

test('STL: binario y ASCII, de un color, soldado; y se escribe', () => {
  const c = caja([10, 10, 10]);
  const bin = writeStl(c);
  const m = readStl(bin, { name: 'cubo.stl' });
  assert.equal(m.objects[0].name, 'cubo');
  assert.equal(m.objects[0].positions.length / 3, 8, 'soldado');
  assert.ok(cerrada(m.objects[0]));
  const ascii = 'solid x\n' + [0, 1, 2].map(() => '').join('') + 'facet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid\n';
  assert.equal(readStl(enc.encode(ascii)).objects[0].indices.length, 3);
});

// ---------- pintar ----------

const plano = () => {
  // una caja de 20 × 20 × 10, refinada a 1 mm: la cara de arriba es una grilla
  const c = caja([20, 20, 10], [0, 0, 5]);
  return refine(weld({ name: 'caja', positions: Float64Array.from(c.positions), indices: Uint32Array.from(c.indices), colors: new Int32Array(12) }), 1);
};
const triEn = (o, t, [x, y, z]) => {
  let mejor = -1, d = Infinity;
  for (let i = 0; i < t.triangleCount; i++) {
    const q = (t.centers[i * 3] - x) ** 2 + (t.centers[i * 3 + 1] - y) ** 2 + (t.centers[i * 3 + 2] - z) ** 2;
    if (q < d) { d = q; mejor = i; }
  }
  return mejor;
};

test('refinar: ningún lado pasa del largo, la forma y los colores se conservan, sin vértices colgados', () => {
  const o = plano();
  const t = topology(o);
  assert.ok(cerrada(o));
  cerca(volumeOf(o), 4000, 1e-9);
  const P = o.positions, ix = o.indices;
  for (let k = 0; k < ix.length; k += 3) for (let e = 0; e < 3; e++) {
    const a = ix[k + e] * 3, b = ix[k + (e + 1) % 3] * 3;
    assert.ok(Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]) <= 1 + 1e-9);
  }
  assert.ok(t.triangleCount > 1000);
  assert.throws(() => refine(o, 0), /largo inválido/);
  assert.throws(() => refine(o, 0.01, { maxTriangles: 5000 }), /más de 5000 triángulos/);
});

test('relleno: se frena en las aristas más vivas que la tolerancia, y en otro color', () => {
  const o = plano();
  const t = topology(o);
  const arriba = triEn(o, t, [0, 0, 10]);
  const c = fill(o, t, { triangle: arriba, color: 1, angle: 30 });
  const area = [...c.triangles].reduce((s, i) => s + t.areas[i], 0);
  cerca(area, 400, 1e-6, 'solo la cara de arriba: el canto de 90° la corta');
  // con 95° cruza los cantos: toda la caja
  const d = fill(o, t, { triangle: arriba, color: 2, angle: 95, sameColor: false });
  assert.equal(d.triangles.length, t.triangleCount);
  // sameColor: un relleno sobre el lateral no pasa a la cara de arriba ya pintada
  fill(o, t, { triangle: arriba, color: 1, angle: 30 });
  const e = fill(o, t, { triangle: triEn(o, t, [10, 0, 5]), color: 3, angle: 95 });
  assert.ok(![...e.triangles].some((i) => o.colors[i] === 1));
});

test('pincel: pinta por la superficie a menos del radio, y con ángulo no se pasa al canto', () => {
  const o = plano();
  const t = topology(o);
  const c = brush(o, t, { triangle: triEn(o, t, [0, 0, 10]), point: [0, 0, 10], radius: 3, color: 1 });
  const area = [...c.triangles].reduce((s, i) => s + t.areas[i], 0);
  assert.ok(area > Math.PI * 9 && area < Math.PI * 16, `un disco de radio 3 (y los triángulos que toca): ${area}`);
  const borde = brush(o, t, { triangle: triEn(o, t, [9.5, 0, 10]), point: [9.9, 0, 10], radius: 2, color: 2, angle: 30 });
  assert.ok([...borde.triangles].every((i) => t.normals[i * 3 + 2] > 0.99), 'con angle no baja por el canto');
  const sin = brush(o, t, { triangle: triEn(o, t, [9.5, 0, 10]), point: [9.9, 0, 10], radius: 2, color: 3 });
  assert.ok([...sin.triangles].some((i) => t.normals[i * 3] > 0.99), 'sin angle sí');
});

test('detector de aristas: las vivas según la tolerancia, y las de cambio de color', () => {
  const o = plano();
  const t = topology(o);
  const vivas = edges(o, t, { angle: 30 }).sharp.length / 6;
  const largo = 4 * 20 + 4 * 20 + 4 * 10; // las 12 aristas de la caja, en tramos de 0,625 mm
  assert.equal(vivas, largo / 0.625);
  assert.equal(edges(o, t, { angle: 95 }).sharp.length, 0);
  fill(o, t, { triangle: triEn(o, t, [0, 0, 10]), color: 1, angle: 30 });
  assert.equal(edges(o, t, { angle: 95, colors: true }).color.length / 6, 80 / 0.625, 'el contorno de la cara pintada');
});

// ---------- separar ----------

test('separar una zona pintada: incrustado, extrusión con cono, y la base pierde el alojamiento con holgura', async () => {
  const o = plano();
  const t = topology(o);
  for (let i = 0; i < t.triangleCount; i++) {
    if (t.centers[i * 3 + 2] > 9.99 && Math.abs(t.centers[i * 3]) < 5 && Math.abs(t.centers[i * 3 + 1]) < 5) o.colors[i] = 1;
  }
  const p = { depth: 1, inset: 0.5, length: 2, cone: 1.5, tip: 0.4, clearance: 0.2 };
  const { pieces, warnings } = separate(o, { kernel: await K(), params: p });
  assert.deepEqual(warnings, []);
  assert.deepEqual(pieces.map((x) => [x.role, x.color, x.parent]), [['base', 0, -1], ['inlay', 1, 0]]);
  const [base, color] = pieces;
  // el color: 10 × 10 × 1, más la extrusión de 9 × 9 × 2 y el cono de 9 × 9 a 3,6 × 3,6 en 1,5
  const cono = (lado, s, h) => lado * lado * h * (1 + s + s * s) / 3;
  cerca(color.volume, 100 + 81 * 2 + cono(9, 0.4, 1.5), 0.5, 'color');
  assert.deepEqual(color.direction, [0, 0, 1]);
  const bc = boundsOf(color.positions);
  cerca(bc.min[2], 10 - 1 - 2 - 1.5, 1e-3, 'la punta del cono, adentro de la base');
  cerca(bc.max[2], 10, 1e-6, 'la cara de arriba, en su lugar');
  // la base: pierde el incrustado y el alojamiento (9,4 × 9,4, con su cono más largo)
  const sTip = 0.4 + 0.2 / 1.5;
  cerca(base.volume, 4000 - 100 - 9.4 * 9.4 * 2 - cono(9.4, sTip, 1.7), 1, 'base');
  // no se pisan: la holgura queda libre
  const comun = (await K()).intersect(base, color);
  assert.ok(Math.abs(volumeOf(comun)) < 1e-3);
  // encaja: el color (con su extrusión) queda entero adentro del objeto original, y entre las dos
  // piezas solo falta el juego de la holgura (y el sobrante de 0,02 mm de las paredes del incrustado)
  const original = { positions: o.positions, indices: o.indices };
  cerca(volumeOf((await K()).intersect(color, original)), color.volume, 1e-3, 'la extrusión no sale del objeto');
  const juego = 4000 - base.volume - color.volume;
  const esperado = (9.4 * 9.4 - 81) * 2 + (cono(9.4, sTip, 1.7) - cono(9, 0.4, 1.5)) + 0.02 * 40 * 1;
  cerca(juego, esperado, 0.5, 'el juego es el de la holgura');
  // y separadas a 5 mm, el color sube por su dirección
  assert.deepEqual(explodeOffsets(pieces, 5), [[0, 0, 0], [0, 0, 5]]);
});

test('separar partes: lo que se mete se le quita a la grande, y la chica se encastra en su contacto', async () => {
  const a = caja([30, 30, 4], [0, 0, 2]);
  const b = caja([10, 10, 6], [0, 0, 6]); // se mete 1 mm en la base
  const pos = [...a.positions, ...b.positions], idx = [...a.indices, ...b.indices.map((v) => v + 8)];
  const o = { name: 'dos', positions: Float64Array.from(pos), indices: Uint32Array.from(idx), colors: Int32Array.from({ length: 24 }, (_, i) => (i < 12 ? 0 : 1)) };
  const { pieces, warnings } = separate(o, { kernel: await K(), params: { length: 1.5, cone: 1, tip: 0.5, clearance: 0, inset: 0 } });
  assert.deepEqual(warnings, []);
  assert.deepEqual(pieces.map((x) => [x.role, x.color, x.parent]), [['base', 0, -1], ['part', 1, 0]]);
  // la base: 3600 − lo que se metía (100) − el alojamiento (sin holgura, del mismo tamaño que la extrusión)
  const tapon = 100 * 1.5 + 100 * 1 * (1 + 0.5 + 0.25) / 3;
  cerca(pieces[1].volume, 600 + tapon, 0.5, 'la parte');
  cerca(pieces[0].volume, 3600 - 100 - tapon, 0.5, 'la base');
  assert.deepEqual(pieces[1].direction.map((v) => v + 0), [0, 0, 1], 'sale hacia arriba');
});

test('separar avisa: una extrusión que sale por el otro lado, una zona sin dirección', async () => {
  const o = plano();
  const t = topology(o);
  for (let i = 0; i < t.triangleCount; i++) if (t.centers[i * 3 + 2] > 9.99 && Math.abs(t.centers[i * 3]) < 5 && Math.abs(t.centers[i * 3 + 1]) < 5) o.colors[i] = 1;
  const { warnings } = separate(o, { kernel: await K(), params: { length: 12, cone: 0 } });
  assert.match(warnings.join(), /sale por el otro lado/);
  const todo = plano();
  const tt = topology(todo);
  for (let i = 0; i < tt.triangleCount; i++) todo.colors[i] = tt.normals[i * 3 + 2] < -0.99 ? 0 : 1; // abajo 0; arriba y los lados, 1
  const r = separate(todo, { kernel: await K(), base: 0 });
  assert.match(r.warnings.join(), /da la vuelta al objeto/);
  assert.throws(() => separate(o, {}), /falta el kernel/);
});

test('parámetros: se completan con los de config.js, se limitan, y uno desconocido falla', () => {
  assert.deepEqual(checkParams({}), { ...SEPARATION_DEFAULTS });
  assert.equal(checkParams({ clearance: 5 }).clearance, 1);
  assert.throws(() => checkParams({ holgura: 1 }), /parámetro desconocido: holgura/);
  assert.throws(() => checkParams({ depth: 'mucho' }), /depth inválido/);
});

// ---------- proyecto ----------

test('proyecto: pintar, juntar un trazo en un paso, refinar, deshacer y rehacer', async () => {
  const c = caja([20, 20, 10], [0, 0, 5]);
  const m = await readModel(write3mf([{ name: 'caja', color: '#ffffff', ...c }]));
  const p = createProject(m);
  const avisos = [];
  p.on('paint', (e) => avisos.push(['paint', e.triangles.length]));
  p.on('geometry', () => avisos.push(['geometry']));
  assert.equal(p.objects[0].triangleCount, 12);
  assert.ok(p.refine(0, 2));
  assert.equal(p.objects[0].triangleCount, topology(p.object(0)).triangleCount);
  const rojo = p.addColor('#D6461F', 'Rojo');
  assert.equal(p.palette[rojo].color, '#d6461f');
  const t = p.topology(0);
  const arriba = triEn(p.object(0), t, [0, 0, 10]);
  p.begin();
  p.brush(0, { triangle: arriba, point: [0, 0, 10], radius: 2, color: rojo });
  p.brush(0, { triangle: triEn(p.object(0), t, [3, 0, 10]), point: [3, 0, 10], radius: 2, color: rojo });
  p.commit();
  const pintados = p.object(0).colors.filter((x) => x === rojo).length;
  assert.ok(pintados > 0);
  p.undo();
  assert.equal(p.object(0).colors.filter((x) => x === rojo).length, 0, 'el trazo entero es un paso');
  p.undo();
  assert.equal(p.objects[0].triangleCount, 12, 'deshacer el refinado vuelve a la malla de antes');
  assert.ok(!p.undo());
  p.redo(); p.redo();
  assert.equal(p.object(0).colors.filter((x) => x === rojo).length, pintados);
  assert.ok(!p.canRedo && p.canUndo);
  assert.deepEqual(avisos[0], ['geometry']);
  assert.throws(() => p.fill(0, { triangle: 0, color: 99, angle: 30 }), /color inválido/);
  assert.throws(() => p.object(3), /objeto inválido/);
  assert.throws(() => p.addColor('rojo'), /color inválido/);
  const sep = p.separate(0, { kernel: await K() });
  assert.equal(sep.pieces.length, 2);
  const otra = await readModel(p.paintedModel(0));
  assert.deepEqual([...otra.objects[0].colors].sort(), [...p.object(0).colors].sort());
});

test('un 3MF separado se vuelve a leer: un objeto por pieza, con su color y su filamento', async () => {
  const o = plano();
  const t = topology(o);
  for (let i = 0; i < t.triangleCount; i++) if (t.centers[i * 3 + 2] > 9.99 && t.centers[i * 3] > 0) o.colors[i] = 1;
  const { pieces } = separate(o, { kernel: await K() });
  const colores = ['#eeeeee', '#d6461f'];
  const m = await readModel(write3mf(pieces.map((x) => ({ name: x.name, color: colores[x.color], positions: x.positions, indices: x.indices }))));
  assert.equal(m.objects.length, 3, 'las dos piezas, y las dos juntas');
  assert.equal(m.objects[2].name, 'Todos juntos');
  assert.equal(m.objects[2].indices.length, m.objects[0].indices.length + m.objects[1].indices.length);
  assert.deepEqual(m.palette.map((x) => x.color), colores);
  for (const ob of m.objects) assert.ok(cerrada(ob), `${ob.name} cerrada`);
});

// ---------- el contrato ----------

test('help(): cada miembro de la API está en su tabla y cada entrada de la tabla existe', async () => {
  const p = createProject(readStl(writeStl(caja([1, 1, 1]))));
  const doc = new Set(PROJECT_MEMBERS.flatMap(([s]) => memberNames(s)));
  for (const k of Object.keys(p)) assert.ok(doc.has(k), `proyecto.${k} sin documentar`);
  for (const k of doc) assert.ok(k in p, `PROJECT_MEMBERS documenta ${k}, que no existe`);
  const mod = new Set(MODULE_MEMBERS.flatMap(([s]) => memberNames(s)));
  const exportados = Object.keys(API).filter((k) => k !== 'memberNames');
  for (const k of exportados) assert.ok(mod.has(k), `${k} exportado sin documentar`);
  for (const k of mod) assert.ok(exportados.includes(k), `MODULE_MEMBERS documenta ${k}, que no se exporta`);
  assert.equal(help({ print: false }).length, MODULE_MEMBERS.length);
  assert.equal(p.help({ print: false }).length, PROJECT_MEMBERS.length);
});

test('src/ es puro: no importa three, ni el DOM, ni nada de afuera salvo el SDK vendorizado', async () => {
  for (const f of await readdir(new URL('../src/', import.meta.url))) {
    const s = await readFile(new URL(`../src/${f}`, import.meta.url), 'utf8');
    for (const [, de] of s.matchAll(/from\s+'([^']+)'/g)) assert.ok(de.startsWith('./') || de.startsWith('../vendor/threejs-cad-sdk/src/'), `${f} importa ${de}`);
    assert.ok(!/\b(document|window)\./.test(s), `${f} usa el DOM`);
    assert.ok(!/await import\(/.test(s), `${f} importa a pedido`);
  }
});

test('los números de la separación y la pintura viven en config.js', async () => {
  for (const f of ['separate.js', 'paint.js', 'index.js']) {
    const s = await readFile(new URL(`../src/${f}`, import.meta.url), 'utf8');
    assert.ok(!/clearance:\s*\d|depth:\s*\d|radius:\s*\d/.test(s), `${f} escribe un valor por defecto a mano`);
  }
});

test('acomodar para imprimir: el color boca abajo con la extrusión para arriba, todo sobre la cama y sin pisarse', async () => {
  const o = plano();
  const t = topology(o);
  for (let i = 0; i < t.triangleCount; i++) if (t.centers[i * 3 + 2] > 9.99 && Math.abs(t.centers[i * 3]) < 5 && Math.abs(t.centers[i * 3 + 1]) < 5) o.colors[i] = 1;
  const { pieces } = separate(o, { kernel: await K() });
  const listas = API.arrangeForPrint(pieces, { gap: 4 });
  const [b0, b1] = listas.map((p) => boundsOf(p.positions));
  cerca(b0.min[2], 0, 1e-9); cerca(b1.min[2], 0, 1e-9);
  cerca(b1.min[0] - b0.max[0], 4, 1e-9, 'a 4 mm');
  // el color: su cara de arriba (10 × 10) quedó apoyada, y la extrusión sube
  const p1 = listas[1].positions;
  let abajo = 0;
  for (let i = 2; i < p1.length; i += 3) if (p1[i] < 1e-6) abajo++;
  assert.ok(abajo >= 4);
  cerca(b1.max[2], 1 + SEPARATION_DEFAULTS.length + SEPARATION_DEFAULTS.cone, 1e-6, 'alto: color + extrusión + cono');
  for (let k = 0; k < 2; k++) cerca(volumeOf(listas[k]), pieces[k].volume, 1e-6, 'girar no cambia el volumen (ni da vuelta las caras)');
});
