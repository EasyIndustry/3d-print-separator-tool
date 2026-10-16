# Contribuir

**Primero, [`POLITICA.md`](POLITICA.md):** qué entra en la app, qué va a un módulo y qué puede
pasar con un pedido. Un pedido es un issue con la plantilla *Pedido*; un error, con la plantilla
*Error*; un PR, mejor después de un issue `aceptado`.

## El contrato

Las pruebas hacen cumplir esto:

1. **El núcleo es puro.** `src/` no importa three, el DOM ni nada de afuera salvo el SDK
   vendorizado (`vendor/threejs-cad-sdk/src/`). Corre igual en Node y en el navegador. three
   está en `adapters/three/`, manifold en `adapters/manifold/`, y la interfaz en `web/`.
2. **Una feature entra primero al núcleo, con su prueba en Node, y después a la interfaz.**
3. **Cada miembro de la API tiene su línea en `src/members.js`.** Una prueba exige que la tabla
   de `help()` y la API coincidan, en las dos direcciones.
4. **Los números van en `src/config.js`:** los valores por defecto y los límites de la
   separación y de la pintura, en mm y grados. No se escriben a mano en el resto de `src/`.
5. **Las booleanas son del kernel.** `separate` no sabe de manifold: recibe un kernel con
   valores planos. Una prueba la corre con el de manifold.
6. **`vendor/` no se edita.** Ver *Vendorizar* en [`POLITICA.md`](POLITICA.md).

## Cómo se agrega algo

1. En `src/`, con su prueba en `test/app.test.mjs`.
2. Expuesto en `src/index.js`, con su línea en `src/members.js`.
3. Si se ve, en `adapters/three/view.js` (que espeja y no decide) y en `web/`.
4. `npm test`, `npm run typecheck` y una prueba a mano en `web/`.

Los tipos van en JSDoc, verificados por `tsc` en modo estricto: los archivos siguen siendo `.js`
y no hay build.

## Los ejemplos

`npm run examples` vuelve a armar `examples/` con manifold: una placa pintada triángulo por
triángulo (`paint_color`) y una medalla de dos partes (componentes con filamento por parte),
como los guardan Bambu Studio y Orca.
