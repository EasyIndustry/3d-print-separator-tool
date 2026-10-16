// Los números de la app: valores por defecto de la separación y de la pintura, en milímetros
// (la unidad de un 3MF y de un slicer), y los colores de reserva. Viven acá y solo acá.
//
// Puro: no importa three ni el DOM.

/** El color de lo que no tiene color. */
export const NO_COLOR = '#b0b0b0';

/** Los colores de los filamentos cuando el proyecto no dice cuáles son. */
export const DEFAULT_FILAMENTS = Object.freeze(['#f2f2f2', '#d6461f', '#2b6cb0', '#2e9a5c', '#f2c12e', '#1f1f1f', '#9b4dca', '#e07a1f']);

/**
 * La separación por defecto (mm y grados). Ver `separate` en separate.js:
 * - depth: cuánto entra el color en la pieza, desde la superficie (el espesor de la pieza de color
 *   cuando el color es una zona pintada).
 * - inset: cuánto más chica que el contorno del color es la extrusión (deja un escalón que tapa la junta).
 * - length: el largo de la extrusión recta, desde el fondo del color hacia adentro de la otra pieza.
 * - cone: el largo del cono que la termina.
 * - tip: la escala de la punta del cono respecto de su base (0: una punta; 1: sin cono).
 * - clearance: la holgura entre la extrusión y su alojamiento, por lado.
 * - explode: cuánto se separan las piezas en la vista.
 */
export const SEPARATION_DEFAULTS = Object.freeze({
  depth: 1,
  inset: 0.4,
  length: 1.2,
  cone: 1,
  tip: 0.35,
  clearance: 0.15,
  explode: 0,
});

/** Los límites de cada valor, para la interfaz y para validar. */
export const SEPARATION_LIMITS = Object.freeze({
  depth: Object.freeze({ min: 0.2, max: 10, step: 0.1 }),
  inset: Object.freeze({ min: 0, max: 3, step: 0.05 }),
  length: Object.freeze({ min: 0, max: 30, step: 0.1 }),
  cone: Object.freeze({ min: 0, max: 20, step: 0.1 }),
  tip: Object.freeze({ min: 0, max: 1, step: 0.05 }),
  clearance: Object.freeze({ min: 0, max: 1, step: 0.01 }),
  explode: Object.freeze({ min: 0, max: 80, step: 0.5 }),
});

/**
 * La pintura por defecto:
 * - radius: el radio del pincel (mm).
 * - angle: la tolerancia del relleno y del detector de aristas (grados): una arista cuyas caras
 *   se doblan más que esto corta el relleno.
 * - refine: el lado más largo que queda al refinar la malla para pintar fino (mm).
 */
export const PAINT_DEFAULTS = Object.freeze({ radius: 2, angle: 30, refine: 1 });

/** Una zona pintada o un contacto de menos área que esto (mm²) no se separa: queda en la base. */
export const MIN_ZONE_AREA = 1;

/** Una cáscara de menos volumen que esto (mm³) que queda de las booleanas es una lámina: se descarta. */
export const MIN_SHELL_VOLUME = 0.01;

/** Un modelo de más triángulos que esto no se refina (el navegador se queda sin memoria). */
export const MAX_TRIANGLES = 2_000_000;

/** Dos vértices a menos de esto se sueldan (mm). */
export const WELD_TOLERANCE = 1e-5;
