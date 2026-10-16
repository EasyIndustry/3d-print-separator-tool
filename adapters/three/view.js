// Adaptador de three: dibuja el modelo pintado y las piezas separadas, y dice qué triángulo hay
// bajo el cursor. Es lo único de la app (fuera de web/) que importa three, y no decide nada:
// espeja lo que dice el núcleo.
//
// El núcleo trabaja como un slicer (z arriba, mm); three y el motor de render, con y arriba. El
// grupo raíz gira el modelo y lo centra sobre el piso; `pick` devuelve todo en el marco del
// modelo.
//
//   const vista = createSeparatorView(motor.content);
//   vista.setModel(proyecto.object(0), proyecto.palette, material);
//   const hit = vista.pick(raycaster);                  // { triangle, point, normal } o null
//   vista.setPieces(pieces, (color) => material);       // las piezas separadas
//   vista.explode(explodeOffsets(pieces, 10));
import * as THREE from 'three';

/** @typedef {import('../../src/threemf.js').ModelObject} ModelObject */
/** @typedef {import('../../src/threemf.js').PaletteEntry} PaletteEntry */
/** @typedef {import('../../src/separate.js').Piece} Piece */


/**
 * @param {THREE.Object3D} parent
 * @param {{ edgeColor?: string, colorEdgeColor?: string, cursorColor?: string, previewMix?: number }} [opts]
 */
export function createSeparatorView(parent, { edgeColor = '#1d2a3a', colorEdgeColor = '#ffb300', cursorColor = '#ffb300', previewMix = 0.6 } = {}) {
  const root = new THREE.Group();
  root.name = 'separador';
  root.rotation.x = -Math.PI / 2; // z del slicer → y de three
  parent.add(root);
  const modelo = new THREE.Group();
  const piezas = new THREE.Group();
  root.add(modelo, piezas);

  /** @type {THREE.Mesh | null} */
  let malla = null;
  /** @type {ModelObject | null} */
  let obj = null;
  /** @type {THREE.Color[]} */
  let colores = [];
  /** @type {Int32Array | null} */
  let vistaPrevia = null;
  /** @type {{ at: number } | null} */
  let seccion = null;

  const aristas = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: 0.85, depthTest: true }));
  const aristasColor = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: colorEdgeColor, transparent: true, opacity: 0.9 }));
  for (const l of [aristas, aristasColor]) {
    l.userData.noEdge = l.userData.noAO = l.userData.noRender = true;
    l.renderOrder = 2;
    l.visible = false;
    modelo.add(l);
  }
  const cursor = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 48), new THREE.MeshBasicMaterial({ color: cursorColor, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthTest: false }));
  cursor.userData.noEdge = cursor.userData.noAO = cursor.userData.noRender = true;
  cursor.renderOrder = 3;
  cursor.visible = false;
  root.add(cursor);

  /** Centrar el modelo sobre el piso: x, y al medio; z desde 0. @param {ArrayLike<number>} p */
  function centrar(p) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[i + k]); max[k] = Math.max(max[k], p[i + k]); }
    // en el marco de three: x → x, z → y, y → -z
    root.position.set(-(min[0] + max[0]) / 2, -min[2], (min[1] + max[1]) / 2);
    return { min, max };
  }

  /** @param {number} t */
  function pintarTriangulo(t, /** @type {THREE.BufferAttribute} */ attr) {
    if (!obj) return;
    const base = colores[obj.colors[t]] ?? colores[0];
    let r = base.r, g = base.g, b = base.b;
    if (vistaPrevia && marcaPrevia[t]) { r += (colorPrevia.r - r) * previewMix; g += (colorPrevia.g - g) * previewMix; b += (colorPrevia.b - b) * previewMix; }
    for (let k = 0; k < 3; k++) attr.setXYZ(t * 3 + k, r, g, b);
  }
  let marcaPrevia = new Uint8Array(0);
  const colorPrevia = new THREE.Color('#ffffff');

  const vista = {
    root,
    /** El objeto que se pinta (su geometría, sus colores) y su material. @param {ModelObject} object @param {PaletteEntry[]} palette @param {THREE.Material} material */
    setModel(object, palette, material) {
      obj = object;
      if (malla) { malla.geometry.dispose(); modelo.remove(malla); }
      const T = object.indices.length / 3;
      const pos = new Float32Array(T * 9);
      for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) {
        const v = object.indices[t * 3 + k] * 3;
        pos.set([object.positions[v], object.positions[v + 1], object.positions[v + 2]], t * 9 + k * 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(T * 9), 3));
      g.computeVertexNormals();
      g.computeBoundingBox();
      g.computeBoundingSphere();
      // con three-mesh-bvh (si la app lo instaló en BufferGeometry), el cursor no recorre todos los triángulos
      const gb = /** @type {any} */ (g);
      if (typeof gb.computeBoundsTree === 'function') gb.computeBoundsTree();
      malla = new THREE.Mesh(g, material);
      malla.castShadow = malla.receiveShadow = true;
      modelo.add(malla);
      marcaPrevia = new Uint8Array(T);
      vistaPrevia = null;
      centrar(object.positions);
      vista.setPalette(palette);
    },
    /** Los colores de la paleta (todos los triángulos se repintan). @param {PaletteEntry[]} palette */
    setPalette(palette) {
      colores = palette.map((p) => new THREE.Color(p.color));
      vista.updateColors();
    },
    /** Repinta unos triángulos (o todos) desde los colores del objeto. @param {ArrayLike<number>} [triangles] */
    updateColors(triangles) {
      if (!malla || !obj) return;
      const attr = /** @type {THREE.BufferAttribute} */ (malla.geometry.getAttribute('color'));
      if (triangles) for (let i = 0; i < triangles.length; i++) pintarTriangulo(triangles[i], attr);
      else for (let t = 0; t < obj.indices.length / 3; t++) pintarTriangulo(t, attr);
      attr.needsUpdate = true;
    },
    /**
     * Resalta los triángulos que pintaría el relleno, mezclados con el color que van a tomar (null: nada).
     * @param {ArrayLike<number> | null} triangles @param {string} [color]
     */
    preview(triangles, color = '#ffffff') {
      colorPrevia.set(color);
      const antes = vistaPrevia;
      if (antes) for (let i = 0; i < antes.length; i++) marcaPrevia[antes[i]] = 0;
      vistaPrevia = triangles ? Int32Array.from(triangles) : null;
      if (vistaPrevia) for (let i = 0; i < vistaPrevia.length; i++) marcaPrevia[vistaPrevia[i]] = 1;
      if (antes) vista.updateColors(antes);
      if (vistaPrevia) vista.updateColors(vistaPrevia);
    },
    /** Las aristas del detector, como segmentos (null las saca). @param {{ sharp: Float32Array, color?: Float32Array } | null} e */
    showEdges(e) {
      for (const [l, s] of /** @type {Array<[THREE.LineSegments, Float32Array | undefined]>} */ ([[aristas, e?.sharp], [aristasColor, e?.color]])) {
        l.geometry.dispose();
        l.geometry = new THREE.BufferGeometry();
        if (s && s.length) l.geometry.setAttribute('position', new THREE.BufferAttribute(s, 3));
        l.visible = !!(s && s.length);
      }
    },
    /** El anillo del pincel en un punto del modelo, mirando según la normal (null lo saca). @param {{ point: number[], normal: number[], radius: number } | null} c */
    cursor(c) {
      cursor.visible = !!c;
      if (!c) return;
      cursor.position.set(c.point[0] + c.normal[0] * 0.05, c.point[1] + c.normal[1] * 0.05, c.point[2] + c.normal[2] * 0.05);
      cursor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...c.normal).normalize());
      cursor.scale.setScalar(c.radius);
    },
    /**
     * El triángulo bajo un rayo (del mundo de three): su índice, el punto y la normal en el marco del modelo.
     * @param {THREE.Raycaster} raycaster
     * @returns {{ triangle: number, point: number[], normal: number[] } | null}
     */
    pick(raycaster) {
      if (!malla || !modelo.visible || !obj) return null;
      raycaster.firstHitOnly = true;
      const h = raycaster.intersectObject(malla, false)[0];
      if (!h || !h.face) return null;
      const p = root.worldToLocal(h.point.clone());
      const n = h.face.normal;
      // la geometría no tiene índice propio: el triángulo t son los vértices 3t, 3t+1, 3t+2. (No
      // faceIndex: el BVH reordena los triángulos y faceIndex pasa a ser su lugar en ese orden.)
      return { triangle: Math.floor(h.face.a / 3), point: [p.x, p.y, p.z], normal: [n.x, n.y, n.z] };
    },
    /**
     * Las piezas separadas, cada una con el material de su color.
     * @param {Piece[]} pieces @param {(color: number, piece: Piece) => THREE.Material} materialFor
     */
    setPieces(pieces, materialFor) {
      for (const m of [...piezas.children]) { /** @type {THREE.Mesh} */ (m).geometry.dispose(); piezas.remove(m); }
      pieces.forEach((p, i) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(p.positions), 3));
        g.setIndex(new THREE.BufferAttribute(Uint32Array.from(p.indices), 1));
        g.computeVertexNormals();
        const m = new THREE.Mesh(g.toNonIndexed(), materialFor(p.color, p));
        g.dispose();
        m.geometry.computeVertexNormals();
        m.castShadow = m.receiveShadow = true;
        m.name = p.name;
        m.userData.piece = i;
        piezas.add(m);
      });
      if (seccion) vista.section(seccion);
    },
    /** Separar las piezas en la vista: un desplazamiento [x, y, z] por pieza (mm, marco del modelo). @param {number[][]} offsets */
    explode(offsets) {
      piezas.children.forEach((m, i) => { const o = offsets[i] ?? [0, 0, 0]; m.position.set(o[0], o[1], o[2]); });
    },
    /**
     * Un corte de las piezas por un plano vertical (en el marco del modelo: x = at), para ver cómo
     * entra la extrusión en su alojamiento; null lo saca. Necesita renderer.localClippingEnabled.
     * @param {{ at: number } | null} c
     */
    section(c) {
      // el plano en el mundo: el marco del modelo está girado y centrado por root
      root.updateMatrixWorld();
      const plano = c ? new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0).applyMatrix4(root.matrixWorld.clone().multiply(new THREE.Matrix4().makeTranslation(c.at, 0, 0))) : null;
      for (const m of /** @type {THREE.Mesh[]} */ (piezas.children)) {
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        m.material = mats.map((x) => {
          // cada pieza con su copia del material: el corte no toca el material compartido
          const propio = x.userData.corte ? x : Object.assign(x.clone(), { userData: { ...x.userData, corte: true } });
          propio.clippingPlanes = plano ? [plano] : null;
          propio.side = plano ? THREE.DoubleSide : THREE.FrontSide;
          propio.needsUpdate = true;
          return propio;
        })[0];
      }
      seccion = c;
    },
    /** Qué se ve: el modelo pintado o las piezas. @param {'paint' | 'pieces'} m */
    mode(m) {
      modelo.visible = m === 'paint';
      piezas.visible = m === 'pieces';
      if (m !== 'paint') cursor.visible = false;
    },
    /** Las mallas de las piezas (para seleccionarlas en el motor). */
    get pieceMeshes() { return /** @type {THREE.Mesh[]} */ ([...piezas.children]); },
    /** La malla pintada. */
    get modelMesh() { return malla; },
    dispose() {
      malla?.geometry.dispose();
      vista.setPieces([], () => new THREE.MeshBasicMaterial());
      aristas.geometry.dispose(); aristasColor.geometry.dispose(); cursor.geometry.dispose();
      parent.remove(root);
    },
  };
  return vista;
}
