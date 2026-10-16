## Qué cambia y por qué

<!-- Qué problema resuelve. -->

Cierra #

## Política

- [ ] Viene de un issue `aceptado` (o es un error).
- [ ] Lo general no entró acá: va como issue al módulo que corresponde ([POLITICA.md](../POLITICA.md)).
- [ ] `vendor/` no se editó a mano: se vendorizó con `scripts/vendor.sh` (y si es una copia con un cambio local, está su issue en el README).

## Contrato

- [ ] Entró primero al núcleo (`src/`), con su prueba en Node, y después a la interfaz.
- [ ] Cada miembro nuevo tiene su línea en `src/members.js` (help()).
- [ ] `src/` no importa three, el DOM ni nada de afuera salvo el SDK vendorizado.
- [ ] Los números de la separación y la pintura van en `src/config.js`.
- [ ] `npm test` y `npm run typecheck` pasan, y se probó a mano en `web/`.
