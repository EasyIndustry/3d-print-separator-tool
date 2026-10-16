// Prueba de punta a punta en un navegador (Playwright + Chromium): abre la página, mueve los
// controles de la separación con el puntero y el teclado, y mide que la extrusión cambie y siga
// adentro de la otra pieza. Deja capturas en e2e-out/.
//
//   npm run e2e                      # levanta su propio servidor de la carpeta del repo
//   node scripts/e2e.mjs <url-base>  # o contra una página que ya está servida
//
// Necesita Playwright (devDependency) y su Chromium (npx playwright install chromium). Los paquetes
// del CDN (three, three-mesh-bvh, manifold-3d) se sirven desde node_modules: corre sin red.
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, normalize } from 'node:path';
import assert from 'node:assert/strict';
import * as pw from 'playwright';

const ROOT = new URL('..', import.meta.url).pathname;
/** Un servidor estático de la carpeta del repo, si no se pasó una URL. */
async function servir() {
  const tipos = /** @type {Record<string, string>} */ ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.3mf': 'model/3mf', '.json': 'application/json' });
  const s = createServer(async (req, res) => {
    const ruta = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    try {
      const body = await readFile(ROOT + ruta.replace(/^\//, '') + (ruta.endsWith('/') ? 'index.html' : ''));
      res.writeHead(200, { 'content-type': tipos[extname(ruta)] ?? (ruta.endsWith('/') ? 'text/html' : 'application/octet-stream') });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', () => r(undefined)));
  const a = /** @type {import('node:net').AddressInfo} */ (s.address());
  return { url: `http://127.0.0.1:${a.port}`, cerrar: () => s.close() };
}
const servidor = process.argv[2] ? null : await servir();
const BASE = process.argv[2] ?? /** @type {{ url: string }} */ (servidor).url;
const OUT = `${ROOT}e2e-out/`;
await mkdir(OUT, { recursive: true });

const browser = await pw.chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
/** @type {string[]} */
const errores = [];
page.on('pageerror', (/** @type {Error} */ e) => errores.push(e.message));
await page.route('https://cdn.jsdelivr.net/npm/**', async (/** @type {any} */ route) => {
  const m = new URL(route.request().url()).pathname.match(/^\/npm\/((?:@[^/]+\/)?[^@/]+)@[^/]+\/(.*)$/);
  await route.fulfill({ body: await readFile(`${ROOT}node_modules/${m[1]}/${m[2]}`), contentType: m[2].endsWith('.wasm') ? 'application/wasm' : 'text/javascript' });
});

/** El fondo de la pieza de color (z mínima, mm) y su volumen; y cuánto se pisa con la base. */
const medir = () => page.evaluate(async () => {
  const w = /** @type {any} */ (window);
  const [base, color] = w.app.piezas;
  let zMin = Infinity;
  for (let i = 2; i < color.positions.length; i += 3) zMin = Math.min(zMin, color.positions[i]);
  return { zMin, volumen: color.volume, base: base.volume, corrida: w.app.piezas };
}).then(({ zMin, volumen, base }) => ({ zMin, volumen, base }));
const esperarSeparado = async (/** @type {number} */ antes) => {
  await page.waitForFunction((/** @type {number} */ v) => {
    const w = /** @type {any} */ (window);
    return w.app.piezas.length > 1 && Math.abs(w.app.piezas[1].volume - v) > 1e-6 && !(/** @type {HTMLButtonElement} */ (document.querySelector('#separarBtn'))).disabled;
  }, antes, { timeout: 60000 });
  await page.waitForTimeout(300);
};
/** Lleva un deslizador a un valor con el teclado, como un usuario (cada tecla es un paso). */
const deslizar = async (/** @type {string} */ id, /** @type {number} */ valor) => {
  const el = page.locator(`#${id}`);
  await el.focus();
  const { v, step } = await el.evaluate((/** @type {HTMLInputElement} */ e) => ({ v: +e.value, step: +e.step }));
  const n = Math.round((valor - v) / step);
  for (let i = 0; i < Math.abs(n); i++) await page.keyboard.press(n > 0 ? 'ArrowRight' : 'ArrowLeft');
};

await page.goto(`${BASE}/web/?ejemplo=medalla-dos-partes`);
await page.waitForFunction(() => /** @type {any} */ (window).app?.piezas?.length > 1, null, { timeout: 120000 });
const inicial = await medir();
console.log('inicial:', inicial, await page.textContent('output[for=p-length]'), await page.textContent('output[for=p-cone]'));

// 1. más largo de extrusión (deslizador "Largo de la extrusión"): la punta baja lo mismo
await deslizar('p-length', 2.2);
await esperarSeparado(inicial.volumen);
const largo = await medir();
console.log('largo 2.2:', largo, await page.textContent('output[for=p-length]'));
assert.ok(Math.abs((inicial.zMin - largo.zMin) - 1) < 0.02, `la punta baja 1 mm: ${inicial.zMin} → ${largo.zMin}`);
assert.ok(largo.volumen > inicial.volumen && largo.base < inicial.base, 'el color crece y la base pierde el alojamiento más hondo');

// 2. sin cono (deslizador "Largo del cono" a 0): la punta sube 1 mm
await deslizar('p-cone', 0);
await esperarSeparado(largo.volumen);
const sinCono = await medir();
console.log('cono 0:', sinCono);
assert.ok(Math.abs((sinCono.zMin - largo.zMin) - 1) < 0.02, 'sin cono, la extrusión termina 1 mm más arriba');

// 3. cono hasta una punta (cono 3, punta 0)
await deslizar('p-cone', 3);
await esperarSeparado(sinCono.volumen);
const c3 = await medir();
await deslizar('p-tip', 0);
await esperarSeparado(c3.volumen);
const punta = await medir();
console.log('cono 3, punta 0:', punta);
assert.ok(punta.volumen < c3.volumen, 'con punta 0 el cono es más chico');

// 4. holgura: con más holgura la base pierde más (el color no cambia)
await deslizar('p-clearance', 0.4);
await esperarSeparado(punta.volumen).catch(() => {}); // el color no cambia de volumen: se espera a la base
await page.waitForFunction((/** @type {number} */ b) => Math.abs(/** @type {any} */ (window).app.piezas[0].volume - b) > 1e-6, punta.base, { timeout: 60000 });
const holgura = await medir();
console.log('holgura 0.4:', holgura);
assert.ok(holgura.base < punta.base - 1, 'más holgura: alojamiento más grande');
assert.ok(Math.abs(holgura.volumen - punta.volumen) < 1e-6, 'el color no cambia');

// 5. encaja: el color no se pisa con la base, y con la vista en corte se ve adentro
const pisan = await page.evaluate(async () => {
  const w = /** @type {any} */ (window);
  const { createManifoldKernel } = await import('../adapters/manifold/kernel.js');
  const K = await createManifoldKernel();
  const [base, color] = w.app.piezas;
  const c = K.intersect(base, color);
  let v = 0;
  const p = c.positions, ix = c.indices;
  for (let k = 0; k < ix.length; k += 3) {
    const a = ix[k] * 3, b = ix[k + 1] * 3, d = ix[k + 2] * 3;
    v += p[a] * (p[b + 1] * p[d + 2] - p[b + 2] * p[d + 1]) - p[a + 1] * (p[b] * p[d + 2] - p[b + 2] * p[d]) + p[a + 2] * (p[b] * p[d + 1] - p[b + 1] * p[d]);
  }
  return Math.abs(v / 6);
});
console.log('volumen que se pisan:', pisan);
assert.ok(pisan < 1e-3, 'la extrusión entra en su alojamiento sin pisar la base');
await page.check('#corte');
await page.evaluate(() => /** @type {any} */ (window).motor.view.go('right', { animate: false, fit: /** @type {any} */ (window).vista.pieceMeshes, margin: 1.15 }));
await page.waitForTimeout(1000);
await page.screenshot({ path: `${OUT}corte-encastrado.png` });
await deslizar('explode', 8);
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}corte-separado.png` });

assert.deepEqual(errores, [], 'sin errores en la página');
console.log('ok: los controles cambian la extrusión y sigue encastrando; capturas en e2e-out/');
await browser.close();
servidor?.cerrar();
