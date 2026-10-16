// ZIP: leer y escribir el contenedor de un 3MF.
//
// Un 3MF es un ZIP con XML adentro. Para leerlo alcanza con el directorio central y, para cada
// archivo, guardado (0) o deflate (8); deflate se descomprime con DecompressionStream, que es
// estándar en el navegador y en Node (≥ 18). Para escribir se guarda sin comprimir: el 3MF lo
// admite y no necesita nada más.
//
// Puro: no importa three ni el DOM.

const FIRMA_FIN = 0x06054b50, FIRMA_CENTRAL = 0x02014b50, FIRMA_LOCAL = 0x04034b50;
const FIRMA_FIN64 = 0x06064b50, FIRMA_LOCALIZADOR64 = 0x07064b50;

/**
 * Las entradas de un ZIP, por nombre (sin la barra inicial). Cada una se lee a pedido.
 * @param {ArrayBuffer | Uint8Array} data
 * @returns {Map<string, { name: string, size: number, read: () => Promise<Uint8Array> }>}
 */
export function readZip(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let fin = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === FIRMA_FIN) { fin = i; break; }
  }
  if (fin < 0) throw new TypeError('no es un ZIP (y un 3MF es un ZIP): no tiene directorio central');
  let total = dv.getUint16(fin + 10, true);
  let central = dv.getUint32(fin + 16, true);
  // ZIP64: los campos de 32 bits valen 0xFFFFFFFF y el dato está en el registro de 64
  if ((central === 0xffffffff || total === 0xffff) && fin >= 20 && dv.getUint32(fin - 20, true) === FIRMA_LOCALIZADOR64) {
    const fin64 = Number(dv.getBigUint64(fin - 20 + 8, true));
    if (dv.getUint32(fin64, true) !== FIRMA_FIN64) throw new TypeError('ZIP64 inválido');
    total = Number(dv.getBigUint64(fin64 + 32, true));
    central = Number(dv.getBigUint64(fin64 + 48, true));
  }
  const dec = new TextDecoder();
  /** @type {Map<string, { name: string, size: number, read: () => Promise<Uint8Array> }>} */
  const entradas = new Map();
  let p = central;
  for (let k = 0; k < total; k++) {
    if (dv.getUint32(p, true) !== FIRMA_CENTRAL) throw new TypeError('ZIP inválido: directorio central roto');
    const metodo = dv.getUint16(p + 10, true);
    let comprimido = dv.getUint32(p + 20, true);
    let tam = dv.getUint32(p + 24, true);
    const largoNombre = dv.getUint16(p + 28, true), largoExtra = dv.getUint16(p + 30, true), largoComentario = dv.getUint16(p + 32, true);
    let local = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + largoNombre)).replace(/^\/+/, '');
    // el extra ZIP64 (0x0001) trae, en orden, los valores que quedaron en 0xFFFFFFFF
    let e = p + 46 + largoNombre;
    const finExtra = e + largoExtra;
    while (e + 4 <= finExtra) {
      const id = dv.getUint16(e, true), largo = dv.getUint16(e + 2, true);
      if (id === 1) {
        let q = e + 4;
        if (tam === 0xffffffff) { tam = Number(dv.getBigUint64(q, true)); q += 8; }
        if (comprimido === 0xffffffff) { comprimido = Number(dv.getBigUint64(q, true)); q += 8; }
        if (local === 0xffffffff) { local = Number(dv.getBigUint64(q, true)); }
      }
      e += 4 + largo;
    }
    p = finExtra + largoComentario;
    if (name.endsWith('/')) continue;
    const desde = local;
    entradas.set(name, {
      name, size: tam,
      read: async () => {
        if (dv.getUint32(desde, true) !== FIRMA_LOCAL) throw new TypeError(`ZIP inválido: ${name}`);
        const ini = desde + 30 + dv.getUint16(desde + 26, true) + dv.getUint16(desde + 28, true);
        const crudo = bytes.subarray(ini, ini + comprimido);
        if (metodo === 0) return crudo;
        if (metodo === 8) return inflate(crudo);
        throw new TypeError(`ZIP: ${name} está comprimido con un método que no se lee (${metodo})`);
      },
    });
  }
  return entradas;
}

/** deflate crudo → bytes, con DecompressionStream. @param {Uint8Array} crudo */
async function inflate(crudo) {
  const ds = new DecompressionStream('deflate-raw');
  const salida = new Blob([/** @type {BlobPart} */ (crudo)]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(salida).arrayBuffer());
}

/** @type {Uint32Array | null} */
let tablaCrc = null;
/** @param {Uint8Array} b */
export function crc32(b) {
  if (!tablaCrc) {
    tablaCrc = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      tablaCrc[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = tablaCrc[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Un ZIP con estos archivos, sin comprimir (o con lo que ya viene comprimido: `deflated` son los
 * bytes en deflate crudo de `data`).
 * @param {Array<{ name: string, data: Uint8Array | string, deflated?: Uint8Array }>} files
 * @returns {Uint8Array}
 */
export function writeZip(files) {
  const enc = new TextEncoder();
  /** @type {Uint8Array[]} */
  const partes = [];
  /** @type {Uint8Array[]} */
  const centrales = [];
  let offset = 0;
  for (const f of files) {
    const nombre = enc.encode(f.name);
    const plano = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(plano);
    const datos = f.deflated ?? plano;
    const metodo = f.deflated ? 8 : 0;
    const local = new Uint8Array(30 + nombre.length);
    const dl = new DataView(local.buffer);
    dl.setUint32(0, FIRMA_LOCAL, true); dl.setUint16(4, 20, true); dl.setUint16(6, 0x0800, true);
    dl.setUint16(8, metodo, true);
    dl.setUint32(14, crc, true); dl.setUint32(18, datos.length, true); dl.setUint32(22, plano.length, true);
    dl.setUint16(26, nombre.length, true); local.set(nombre, 30);
    const cen = new Uint8Array(46 + nombre.length);
    const dc = new DataView(cen.buffer);
    dc.setUint32(0, FIRMA_CENTRAL, true); dc.setUint16(4, 20, true); dc.setUint16(6, 20, true); dc.setUint16(8, 0x0800, true);
    dc.setUint16(10, metodo, true);
    dc.setUint32(16, crc, true); dc.setUint32(20, datos.length, true); dc.setUint32(24, plano.length, true);
    dc.setUint16(28, nombre.length, true); dc.setUint32(42, offset, true); cen.set(nombre, 46);
    partes.push(local, datos);
    centrales.push(cen);
    offset += local.length + datos.length;
  }
  const largoCentral = centrales.reduce((s, c) => s + c.length, 0);
  const fin = new Uint8Array(22);
  const df = new DataView(fin.buffer);
  df.setUint32(0, FIRMA_FIN, true); df.setUint16(8, files.length, true); df.setUint16(10, files.length, true);
  df.setUint32(12, largoCentral, true); df.setUint32(16, offset, true);
  const todo = new Uint8Array(offset + largoCentral + 22);
  let q = 0;
  for (const b of [...partes, ...centrales, fin]) { todo.set(b, q); q += b.length; }
  return todo;
}

/**
 * El mismo ZIP, con cada archivo comprimido con deflate (CompressionStream, del navegador y de
 * Node): un 3MF de texto queda de un décimo.
 * @param {Uint8Array} zip @returns {Promise<Uint8Array>}
 */
export async function compressZip(zip) {
  const archivos = [];
  for (const e of readZip(zip).values()) {
    const data = await e.read();
    const cs = new Blob([/** @type {BlobPart} */ (data)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    archivos.push({ name: e.name, data, deflated: new Uint8Array(await new Response(cs).arrayBuffer()) });
  }
  return writeZip(archivos);
}
