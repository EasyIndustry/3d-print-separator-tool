# Política del repositorio

Esta es una **app** open source (MIT) que usa módulos vendorizables de EasyIndustry
(threejs-cad-sdk, threejs-render-engine, threejs-material-engine). Esta política dice qué entra
acá, qué va a un módulo y cómo se decide. Las etiquetas y el filtro son los mismos de los
módulos.

## El principio

**La app resuelve su problema (separar colores para imprimir), y lo general va al módulo que
corresponde.** Si algo que la app necesita le sirve a cualquier app de three.js (una unidad, un
gesto de cámara, un canal de material), no se escribe acá: se pide como issue en el módulo,
pasa por su `POLITICA.md` y la app lo toma cuando sale en una versión.

## El filtro

Cada pedido (issue o PR) pasa por estas preguntas, en orden. La primera que corta decide.

1. **¿Qué problema resuelve?** El pedido se lee por la necesidad, no por la solución que trae.
2. **¿Ya se puede?** Con la API, un valor de `src/config.js` o el kernel que se inyecta.
3. **¿Es de la app o de un módulo?** Leer, pintar y separar para imprimir son de la app. La
   geometría general, cómo se ve una escena y los materiales son de los módulos.
4. **¿Respeta el contrato?** El de **En este repo**.

## Qué puede pasar con un pedido

| Etiqueta | Qué quiere decir | Qué pasa |
|---|---|---|
| `aceptado` | pasa el filtro | queda abierto hasta que se implementa |
| `generalizar` | la necesidad sirve, el pedido es muy puntual | se reescribe en el issue y pasa a `aceptado` |
| `sin-cambios` | ya se puede | se cierra con el cómo |
| `fuera-de-alcance` | no es de la app | se cierra con dónde va (el issue del módulo, si es de un módulo) |

`error` marca lo que la app promete y no cumple. Ningún pedido se cierra sin una explicación.

## Vendorizar

- `vendor/` se copia con `scripts/vendor.sh`, **tal cual**, y **no se edita a mano**.
- Un cambio en un módulo se hace en el repo del módulo y se pide como issue. Mientras no sale en
  una versión, la app puede vendorizar desde un clon local con el cambio: el `VERSION` de la copia
  dice la rama y el commit, y el README lista el cambio con su issue.
- Cuando el módulo publica la versión, se vuelve a vendorizar desde la etiqueta y se saca la
  fila del README.

## Open source

- Licencia MIT ([`LICENSE`](LICENSE)). Convivencia: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
  Seguridad: [`SECURITY.md`](SECURITY.md), en privado. Cómo se contribuye: [`CONTRIBUTING.md`](CONTRIBUTING.md).
- **Idioma:** el repo está en castellano (código, documentación, issues). Un issue en otro
  idioma se acepta y se responde.

## En este repo

**3d-print-separator-tool:** de un modelo de varios colores, piezas de un color que se imprimen
aparte y encastran.

- **Entra:** leer y escribir los formatos de impresión (3MF del núcleo y de los slicers, STL),
  pintar zonas, separar por color con su encastre, acomodar para imprimir y la interfaz.
- **No entra:** lo que es de un módulo (ver arriba), ni un catálogo de filamentos o de
  impresoras con nombres comerciales.
- **Puntos de extensión:** el kernel de booleanas (`separate({ kernel })`) y los valores de
  `src/config.js`.
- **El contrato** está en [`CONTRIBUTING.md`](CONTRIBUTING.md).
