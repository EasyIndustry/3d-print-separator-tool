// Arma los modelos de ejemplo de examples/ (node scripts/examples.mjs). Son 3MF como los que
// guarda Bambu Studio u Orca: uno pintado triángulo por triángulo (paint_color) y uno con una
// parte de otro filamento (componentes + Metadata/model_settings.config).
import { writeFile, mkdir } from 'node:fs/promises';
import { createManifoldKernel } from '../adapters/manifold/kernel.js';
import { refine, weld, topology, writeZip, write3mfPainted, compressZip } from '../src/index.js';

const K = await createManifoldKernel();
const { Manifold, CrossSection } = K.wasm;
const malla = (/** @type {any} */ s) => { const m = s.getMesh(); return { positions: Float64Array.from(m.vertProperties), indices: Uint32Array.from(m.triVerts) }; };

/** Un rectángulo de esquinas redondeadas, centrado. */
const redondeado = (w, h, r) => new CrossSection([[[-w / 2 + r, -h / 2 + r], [w / 2 - r, -h / 2 + r], [w / 2 - r, h / 2 - r], [-w / 2 + r, h / 2 - r]]], 'Positive').offset(r, 'Round', 2, 32);
/** Una estrella de n puntas. */
const estrella = (R, r, n = 5, [cx, cy] = [0, 0]) => Array.from({ length: n * 2 }, (_, i) => {
  const a = Math.PI / 2 + (i * Math.PI) / n, q = i % 2 ? r : R;
  return /** @type {[number, number]} */ ([cx + q * Math.cos(a), cy + q * Math.sin(a)]);
});
/** ¿El punto está adentro del polígono? */
const adentro = ([x, y], poli) => {
  let c = false;
  for (let i = 0, j = poli.length - 1; i < poli.length; j = i++) {
    const [xi, yi] = poli[i], [xj, yj] = poli[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

await mkdir(new URL('../examples/', import.meta.url), { recursive: true });

// 1. una placa con una estrella y un círculo pintados en la cara de arriba
{
  const placa = Manifold.extrude(redondeado(60, 34, 5), 4);
  const m = malla(placa);
  let o = weld({ name: 'Placa', positions: m.positions, indices: m.indices, colors: new Int32Array(m.indices.length / 3) });
  o = refine(o, 1.4);
  const t = topology(o);
  const est = estrella(11, 4.6, 5, [-12, 0]);
  for (let i = 0; i < t.triangleCount; i++) {
    const c = [t.centers[i * 3], t.centers[i * 3 + 1]];
    if (t.normals[i * 3 + 2] < 0.99) continue;
    if (adentro(c, est)) o.colors[i] = 1;
    else if (Math.hypot(c[0] - 15, c[1]) < 7) o.colors[i] = 2;
  }
  const paleta = [
    { key: 'f:1', color: '#f2f2f2', name: 'Blanco', filament: 1 },
    { key: 'f:2', color: '#d6461f', name: 'Rojo', filament: 2 },
    { key: 'f:3', color: '#2b6cb0', name: 'Azul', filament: 3 },
  ];
  await writeFile(new URL('../examples/placa-pintada.3mf', import.meta.url), await compressZip(write3mfPainted(o, paleta)));
  console.log('examples/placa-pintada.3mf', o.indices.length / 3, 'triángulos');
}

// 2. una base con una parte de otro filamento que se mete 1 mm (como una parte de Bambu)
{
  const base = malla(Manifold.cylinder(5, 22, 22, 96));
  const sombrero = Manifold.extrude(new CrossSection([estrella(14, 6.5)], 'Positive'), 6).translate([0, 0, 4]);
  const parte = malla(sombrero);
  const f6 = (/** @type {number} */ x) => +x.toFixed(6);
  const objeto = (id, name, m) => {
    let v = '', tr = '';
    for (let k = 0; k < m.positions.length; k += 3) v += `<vertex x="${f6(m.positions[k])}" y="${f6(m.positions[k + 1])}" z="${f6(m.positions[k + 2])}"/>`;
    for (let k = 0; k < m.indices.length; k += 3) tr += `<triangle v1="${m.indices[k]}" v2="${m.indices[k + 1]}" v3="${m.indices[k + 2]}"/>`;
    return `<object id="${id}" type="model" name="${name}"><mesh><vertices>${v}</vertices><triangles>${tr}</triangles></mesh></object>`;
  };
  const modelo = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="es-AR" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${objeto(1, 'base', base)}${objeto(2, 'estrella', parte)}<object id="3" type="model" name="Medalla"><components><component objectid="1"/><component objectid="2"/></components></object></resources><build><item objectid="3" transform="1 0 0 0 1 0 0 0 1 128 128 0"/></build></model>`;
  const config = '<?xml version="1.0" encoding="UTF-8"?><config><object id="3"><metadata key="name" value="Medalla"/><metadata key="extruder" value="1"/><part id="1" subtype="normal_part"><metadata key="name" value="base"/></part><part id="2" subtype="normal_part"><metadata key="name" value="estrella"/><metadata key="extruder" value="2"/></part></object></config>';
  const zip = writeZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="text/xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>' },
    { name: '3D/3dmodel.model', data: modelo },
    { name: 'Metadata/model_settings.config', data: config },
    { name: 'Metadata/project_settings.config', data: JSON.stringify({ filament_colour: ['#F2F2F2', '#F2C12E'] }) },
  ]);
  await writeFile(new URL('../examples/medalla-dos-partes.3mf', import.meta.url), await compressZip(zip));
  console.log('examples/medalla-dos-partes.3mf');
}
