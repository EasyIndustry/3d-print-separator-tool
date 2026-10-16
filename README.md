# 3d-print-separator-tool

Separá cada color de un modelo 3D en **piezas que se imprimen aparte y encastran**. Abrís un 3MF
con colores (de Bambu Studio, OrcaSlicer, PrusaSlicer o cualquiera que use los materiales del
3MF) o un STL y lo pintás acá. Cada color pasa a ser un sólido con una **extrusión terminada en
cono** que entra en la pieza de al lado, y la otra pieza recibe su alojamiento con holgura. Así
se imprime cada color en su filamento, sin cambios de color ni torre de purga, y después se
arma a presión: el cono centra la pieza.

Es una página web con [three.js](https://threejs.org), sin build: `web/index.html`.

```
npm install          # solo para las pruebas (manifold-3d, three); la página no lo necesita
npm start            # python3 -m http.server 8000 → http://localhost:8000/web/
```

Con `?ejemplo=placa-pintada` o `?ejemplo=medalla-dos-partes` arranca con un ejemplo.

## Qué hace

- **Lee 3MF con materiales.** De dónde sale el color de cada triángulo, del que manda al que menos:
  1. la pintura del slicer: `paint_color` (Bambu, Orca) o `slic3rpe:mmu_segmentation` (Prusa).
     Es el árbol de `TriangleSelector`, con los triángulos subdivididos; los vértices que quedan
     en medio de un lado vecino se cosen, así la malla sigue cerrada;
  2. el filamento de cada parte (`Metadata/model_settings.config` de Bambu y Orca, los volúmenes
     de `Metadata/Slic3r_PE_model.config` de Prusa) o del objeto;
  3. las propiedades del 3MF: `basematerials` y `colorgroup`, por triángulo o por objeto.

  También lee componentes en otros archivos del paquete (`p:path`), transformaciones con espejo,
  todas las unidades del 3MF (también micrones) y los colores de los filamentos del proyecto.
  Deja afuera los modificadores, los volúmenes negativos y los bloqueadores de soporte. También
  lee **STL** (binario o ASCII), que entra de un color.
- **Pintar.** Con el **pincel**, arrastrás un círculo de radio dado por la superficie. No salta a
  la pared de atrás, y con *No pasar las aristas vivas* tampoco baja por el canto. El **relleno**
  pinta hasta las aristas vivas: una arista cuyas caras se doblan más que la **tolerancia**
  (grados) corta el relleno, y una más suave (las facetas de un cilindro) se cruza. Antes del
  clic muestra la zona que va a pintar. El **detector de aristas** dibuja las aristas vivas con
  esa misma tolerancia y los bordes entre colores. **Refinar** parte los triángulos hasta un lado
  máximo para pintar más fino, sin cambiar la forma y sin dejar vértices colgados. Deshacer y
  rehacer: un trazo entero es un paso.
- **Separar.** Cada zona de otro color pasa a ser un sólido:
  - una **zona pintada** se extruye hacia adentro `profundidad` mm (el incrustado). Si llega al
    canto del objeto, lo pasa, así la base no queda con una lámina;
  - una **parte** (un sólido por color, como una parte de Bambu) se encastra en la pieza más
    grande que toca. Lo que se mete en ella, se le quita.

  Desde la cara que toca la otra pieza sale la extrusión: el contorno del color, achicado
  `achique`, recto `largo` mm y en cono `cono` mm hasta una punta de `punta` veces la base. La
  otra pieza recibe el mismo hueco, agrandado `holgura` por lado. Las zonas de menos de 1 mm²
  (una punta suelta al pintar) pasan al color de al lado. La app avisa si la extrusión sale por el
  otro lado de la pieza o si una zona es demasiado curva para tener una dirección.
- **Ver separado.** Cada pieza sale de su madre en su dirección, tanto como diga el deslizador
  *Separación en la vista*.
- **Exportar.** Un **3MF separado** lleva un objeto por pieza, con su color y su filamento, y
  cada pieza acomodada para imprimir: un incrustado va boca abajo, con la extrusión para arriba
  y sin soportes. También un **ZIP con un STL por pieza** y el **3MF pintado** (con
  `paint_color`), para seguir en el slicer.

## Estructura

La misma que los módulos de EasyIndustry que usa: un núcleo puro, adaptadores, la ayuda en
`help()` verificada por prueba, pruebas en Node y tipos en JSDoc verificados por `tsc`.

```
src/                    el núcleo: puro (sin three, sin DOM), corre en Node y en el navegador
  index.js              la API: readModel, createProject (pintar, deshacer, separar) y lo demás
  threemf.js            leer y escribir 3MF (núcleo, Bambu/Orca, Prusa)
  paintcode.js          la pintura de los slicers (árbol de TriangleSelector)
  zip.js, xml.js, stl.js
  mesh.js               soldar, vecinos por arista, cáscaras, contornos
  paint.js              pincel, relleno, detector de aristas, refinar
  separate.js           separar por color: incrustado, extrusión con cono, holgura; acomodar para imprimir
  config.js             los valores por defecto y los límites (mm, grados)
  help.js, members.js   help(): una línea por miembro
adapters/
  manifold/kernel.js    las booleanas con manifold-3d (WASM), a pedido
  three/view.js         el modelo pintado, las aristas, el cursor y las piezas, en three
web/                    la página: index.html, app.js, style.css
vendor/                 los módulos de EasyIndustry, vendorizados tal cual (scripts/vendor.sh)
examples/               modelos de ejemplo (scripts/examples.mjs los arma)
test/                   las pruebas, en Node
```

### Los módulos que usa

| módulo | para qué |
|---|---|
| [threejs-render-engine](https://github.com/EasyIndustry/threejs-render-engine) | el visor: estudio, luces, sombras, cámara con valores planos (`view.ray`, `view.claim` para que el pincel no pelee con la órbita), contorno de selección y encuadre |
| [threejs-material-engine](https://github.com/EasyIndustry/threejs-material-engine) | el plástico de cada filamento: color, rugosidad y un relieve fino de ruido, con mapeo triplanar (las piezas no tienen UV) |
| [ThreeJS-cad-SDK](https://github.com/EasyIndustry/ThreeJS-cad-SDK) | las unidades: el lector de 3MF lleva cualquier unidad a mm con `convertLength` |

Se vendorizan con `scripts/vendor.sh`, que los copia tal cual en `vendor/` con su `VERSION`
(de dónde salió cada uno: versión, rama y commit) y su licencia. **La copia no se edita.** Si
la app necesita un cambio en un módulo, el cambio se hace en el repo del módulo, se pide como
issue (los módulos son agnósticos: pasa por su `POLITICA.md`) y se vuelve a vendorizar.

**Cambios locales pendientes.** Mientras un pedido no sale en una versión del módulo, la app
vendoriza desde un clon local con el cambio. El `VERSION` lo dice: rama
`claude/modest-tesla-q4cx1t` y commit sin publicar.

| módulo | cambio | issue |
|---|---|---|
| ThreeJS-cad-SDK | `'um'` (micrones) como unidad: la unidad `micron` de un 3MF | [EasyIndustry/ThreeJS-cad-SDK#19](https://github.com/EasyIndustry/ThreeJS-cad-SDK/issues/19) |

### Dependencias

Ninguna en la página fuera de lo que carga el importmap del CDN, y cada una con su versión
fija: three 0.170, three-mesh-bvh 0.8.3 (el cursor sobre mallas grandes), manifold-3d 3.5.4
(las booleanas, se carga la primera vez que se separa) y three-gpu-pathtracer 0.0.23 (solo para
el render final del motor). `npm install` es solo para las pruebas en Node.

## La API

```js
import { readModel, createProject } from './src/index.js';
import { createManifoldKernel } from './adapters/manifold/kernel.js';

const modelo = await readModel(bytes, { name: 'llavero.3mf' });   // 3MF o STL
const proyecto = createProject(modelo);
const rojo = proyecto.addColor('#d6461f', 'Rojo');
proyecto.fill(0, { triangle: 120, color: rojo, angle: 30 });      // hasta las aristas de más de 30°
proyecto.brush(0, { triangle: 40, point: [x, y, z], radius: 2, color: rojo });
proyecto.undo();
const { pieces, warnings } = proyecto.separate(0, {
  kernel: await createManifoldKernel(),
  params: { depth: 1, inset: 0.4, length: 1.2, cone: 1, tip: 0.35, clearance: 0.15 },
});
proyecto.help();   // todo lo que hay
```

`help()` del módulo y `proyecto.help()` imprimen la tabla de cada miembro (`src/members.js`), y una
prueba exige que la tabla y la API coincidan.

El kernel de booleanas es un punto de extensión, como en el SDK: `separate` recibe
`{ union, subtract, intersect, extrude, offset, area }` con valores planos (mallas
`{ positions, indices }` y polígonos `[[x, y], …]`). El de manifold es el que viene.

## Probarlo

```bash
npm test             # las pruebas, en Node (separar usa manifold-3d)
npm run typecheck    # tsc estricto
```

Lo que se dibuja se prueba a mano en `web/` (servido por HTTP desde la raíz del repo).

## Lo que todavía no está

- **Una zona pintada sale en una sola dirección**, la normal media de la zona. Una zona curva
  (un anillo alrededor de un cilindro) avisa y queda en la base; conviene partirla en zonas más
  planas.
- **Separar corre en el hilo de la página**: con mallas grandes, la página espera unos
  segundos.
- **El pincel pinta triángulos enteros**: para un borde fino hay que refinar antes. La app no
  parte un triángulo por el borde del pincel como hacen los slicers.
- **Los modificadores de color de Bambu y Prusa** (una parte modificadora que cambia el filamento
  de lo que toca) se ignoran: cuentan la pintura, las partes y los objetos.

## Licencia

[MIT](LICENSE) © 2026 EasyIndustry.

## Contribuir

Qué entra en la app y qué va a un módulo: [`POLITICA.md`](POLITICA.md). Cómo se contribuye:
[`CONTRIBUTING.md`](CONTRIBUTING.md). Convivencia: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md);
seguridad: [`SECURITY.md`](SECURITY.md).
