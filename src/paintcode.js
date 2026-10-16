// La pintura multicolor que guardan PrusaSlicer, Bambu Studio y OrcaSlicer en un 3MF.
//
// Cada triángulo pintado lleva un texto hexadecimal (`paint_color` en Bambu y Orca,
// `slic3rpe:mmu_segmentation` en Prusa) que describe un árbol: el triángulo se parte en 2, 3 o
// 4 hijos por los puntos medios de sus lados, y cada hoja tiene un estado (0: sin pintar, k: el
// filamento k). El texto se lee de atrás para adelante, un nibble por carácter; los hijos van del
// último al primero. Es el formato de `TriangleSelector::deserialize`.
//
// Puro: no importa three ni el DOM.

/**
 * Una hoja del árbol: sus tres vértices como combinaciones de los del triángulo original (los
 * números son ids de vértice; los puntos medios se piden a `midpoint`) y su estado.
 * @typedef {{ v: [number, number, number], state: number }} PaintLeaf
 */

/**
 * Decodifica el texto de un triángulo. `verts` son sus tres vértices; `midpoint(a, b)` devuelve
 * el id del punto medio entre dos vértices (y lo crea si no estaba, compartido con el vecino).
 * Devuelve las hojas, o null si el texto está roto (el slicer, en ese caso, lo deja sin pintar).
 * @param {string} code
 * @param {[number, number, number]} verts
 * @param {(a: number, b: number) => number} midpoint
 * @returns {PaintLeaf[] | null}
 */
export function decodePaint(code, verts, midpoint) {
  const s = code.trim().toUpperCase();
  if (!s || !/^[0-9A-F]+$/.test(s)) return null;
  let pos = s.length - 1;
  const nibble = () => {
    if (pos < 0) throw new RangeError('fin');
    return parseInt(s[pos--], 16);
  };
  /** @type {PaintLeaf[]} */
  const hojas = [];
  /** @param {[number, number, number]} v */
  const nodo = (v) => {
    const c = nibble();
    const lados = c & 0b11;
    if (lados === 0) {
      let state = c >> 2;
      if (state === 3) {
        const n = nibble();
        state = n === 0b1111 ? nibble() + 18 : n + 3;
      }
      hojas.push({ v, state });
      return;
    }
    const especial = lados === 3 ? 0 : c >> 2;
    if (especial > 2) throw new RangeError('lado');
    const hijos = partir(v, lados, especial, midpoint);
    // los hijos vienen del último al primero
    for (let i = hijos.length - 1; i >= 0; i--) nodo(hijos[i]);
  };
  try {
    nodo(verts);
  } catch {
    return null;
  }
  return hojas;
}

/**
 * Los hijos de un triángulo partido, como en `TriangleSelector::perform_split`.
 * @param {[number, number, number]} t @param {number} lados @param {number} especial
 * @param {(a: number, b: number) => number} mid
 * @returns {Array<[number, number, number]>}
 */
function partir(t, lados, especial, mid) {
  const a = t[especial], b = t[(especial + 1) % 3], c = t[(especial + 2) % 3];
  if (lados === 1) {
    const m = mid(b, c);
    return [[a, b, m], [m, c, a]];
  }
  if (lados === 2) {
    const mab = mid(a, b), mca = mid(c, a);
    return [[a, mab, mca], [mab, b, mca], [b, c, mca]];
  }
  const mab = mid(a, b), mbc = mid(b, c), mca = mid(c, a);
  return [[a, mab, mca], [mab, b, mbc], [mbc, c, mca], [mab, mbc, mca]];
}

/**
 * El texto de una hoja sin partir, con su estado: lo inverso de `decodePaint` para un triángulo
 * entero (sirve para escribir un 3MF que un slicer lea pintado).
 * @param {number} state
 */
export function encodePaintState(state) {
  if (!Number.isInteger(state) || state < 0) throw new TypeError(`estado inválido: ${state}`);
  if (state < 3) return (state << 2).toString(16).toUpperCase();
  if (state <= 17) return (state - 3).toString(16).toUpperCase() + 'C';
  return (state - 18).toString(16).toUpperCase() + 'FC';
}
