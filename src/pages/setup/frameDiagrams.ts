/**
 * `FRAME_TYPE` classes for which the param does something — verified against
 * `AP_MotorsMatrix`/`AP_MotorsTri`/`AP_MotorsSingle`/`AP_MotorsCoax`/the
 * scripting matrix classes in ArduPilot's own source, not the param's prose
 * description alone (which only names Tri and "Traditional Helicopters").
 * Everything else — Tri, Single, Coax, the whole Heli family, BiCopter (its
 * `AP_MotorsMatrix` case has no defined layout at all), and the 3 scripted
 * classes — ignores FRAME_TYPE outright.
 */
export const FRAME_TYPE_APPLIES_FOR = new Set([1, 2, 3, 4, 5, 12, 14]);

/** The three script-defined classes (Scripting Matrix, 6DoF Scripting,
 * Dynamic Scripting Matrix): the motor layout comes from a Lua script, so
 * there's no fixed geometry to draw. */
export const SCRIPTED_FRAME_CLASSES = new Set([15, 16, 17]);
