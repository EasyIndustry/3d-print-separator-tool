# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/). Versiones según
[SemVer](https://semver.org).

## [0.1.0] - Sin publicar

Primera versión.

### Agregado

- **Leer 3MF con materiales**: `basematerials`, `colorgroup`, componentes en otros archivos
  (`p:path`), transformaciones con espejo, todas las unidades. También la pintura de Bambu, Orca
  y Prusa (`paint_color`, `mmu_segmentation`, con triángulos subdivididos y cosidos) y el
  filamento por parte y por objeto de sus `.config`. Los modificadores no entran. También STL.
- **Pintar**: pincel (por la superficie, con la opción de no pasar las aristas vivas o de pintar
  solo sobre un color), relleno hasta las aristas más vivas que una tolerancia en grados, con
  vista previa, detector de aristas, refinar la malla, deshacer y rehacer.
- **Separar por color**: cada zona pintada pasa a ser un incrustado y cada parte se encastra en
  la que toca, con una extrusión recta terminada en cono y su alojamiento con holgura. Las
  islas de menos de 1 mm² pasan al color de al lado, se descartan las láminas que dejan las
  booleanas, y la app avisa si la extrusión sale por el otro lado. Las booleanas, con manifold-3d.
- **Ver y exportar**: separación en la vista; 3MF con un objeto por pieza (color y filamento),
  acomodado para imprimir; ZIP con un STL por pieza; 3MF pintado.
- La página (`web/`) con threejs-render-engine, threejs-material-engine y threejs-cad-sdk
  vendorizados.
