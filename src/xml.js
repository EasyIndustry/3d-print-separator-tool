// Un lector de XML mínimo, en flujo (como SAX): avisa cada etiqueta que abre y que cierra, con
// sus atributos. Alcanza para un 3MF (un XML sin DTD, de etiquetas y atributos) y para los
// .config de los slicers, y no arma un árbol: un modelo de un millón de triángulos es un millón
// de etiquetas.
//
// Los nombres llegan sin prefijo de espacio de nombres ('m:color' → 'color',
// 'p:path' → 'path', 'slic3rpe:mmu_segmentation' → 'mmu_segmentation'): un 3MF los escribe con
// cualquier prefijo, y ninguno de los que leemos choca con otro.
//
// Puro: no importa three ni el DOM.

const ETIQUETA = /<(\/?)([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>/g;
const ATRIBUTO = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** @param {string} s */
export function unescapeXml(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return /** @type {Record<string, string>} */ ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e];
  });
}

/** @param {string} s */
export function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => /** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}

const local = (/** @type {string} */ n) => { const i = n.lastIndexOf(':'); return i < 0 ? n : n.slice(i + 1); };

/**
 * Recorre el XML y avisa cada etiqueta. `open` recibe el nombre sin prefijo, sus atributos (sin
 * prefijo) y si es vacía (`<a/>`); `close`, el nombre de la que cierra (también la vacía).
 * @param {string} xml
 * @param {{ open?: (name: string, attrs: Record<string, string>, empty: boolean) => void, close?: (name: string) => void, text?: (text: string) => void }} handlers
 */
export function parseXml(xml, { open, close, text }) {
  ETIQUETA.lastIndex = 0;
  let ultimo = 0;
  /** @type {RegExpExecArray | null} */
  let m;
  while ((m = ETIQUETA.exec(xml))) {
    if (text && m.index > ultimo) {
      const t = xml.slice(ultimo, m.index);
      if (t.trim()) text(unescapeXml(t));
    }
    ultimo = ETIQUETA.lastIndex;
    if (m[2] === undefined) {
      if (text && m[0].startsWith('<![CDATA[')) text(m[0].slice(9, -3));
      continue;
    }
    const name = local(m[2]);
    if (m[1]) { close?.(name); continue; }
    /** @type {Record<string, string>} */
    const attrs = {};
    const crudo = m[3];
    if (crudo) {
      ATRIBUTO.lastIndex = 0;
      /** @type {RegExpExecArray | null} */
      let a;
      while ((a = ATRIBUTO.exec(crudo))) {
        const n = a[1];
        if (n.startsWith('xmlns')) continue;
        attrs[local(n)] = unescapeXml(a[2] ?? a[3] ?? '');
      }
    }
    const vacia = m[4] === '/';
    open?.(name, attrs, vacia);
    if (vacia) close?.(name);
  }
}
