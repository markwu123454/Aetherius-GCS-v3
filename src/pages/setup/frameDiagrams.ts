import type {ComponentType} from "react";
import {CoaxCopterIcon, HeliDualIcon, HeliIcon, HeliQuadIcon, SingleCopterIcon} from "./frameIcons.tsx";

/**
 * What to render for one `FRAME_CLASS` value: a bundled ArduPilot diagram
 * (optionally with per-`FRAME_TYPE` variants), a hand-drawn stand-in for the
 * classes ArduPilot has no usable diagram for, or — for the 3 script-defined
 * classes, where no fixed geometry exists to draw at all — a plain marker
 * meaning "render the Code icon instead".
 */
export type FrameClassDiagram =
    | {kind: "image"; classImage: string; types?: Record<number, string>}
    | {kind: "custom"; Icon: ComponentType}
    | {kind: "scripted"};

const FRAMES = "/frames";

/**
 * Per-class `FRAME_TYPE` coverage, verified against the actual images
 * ArduPilot publishes on its "Connect ESCs and Motors" page (not guessed from
 * the FRAME_TYPE enum) — a class only lists a type here if ArduPilot drew
 * that specific combination. Type values valid in the param sheet but absent
 * from a class's map (e.g. Hexa + V) get a text-only tile instead of an
 * image, rather than being hidden — the param itself doesn't forbid them,
 * ArduPilot's docs just never illustrated that combination.
 */
export const FRAME_CLASS_DIAGRAMS: Record<number, FrameClassDiagram> = {
    1: {
        kind: "image",
        classImage: `${FRAMES}/m_01_01_quad_x.svg`,
        types: {
            0: `${FRAMES}/m_01_00_quad_plus.svg`,
            1: `${FRAMES}/m_01_01_quad_x.svg`,
            2: `${FRAMES}/m_01_02_quad_v.svg`,
            3: `${FRAMES}/m_01_03_quad_h.svg`,
            4: `${FRAMES}/m_01_04_quad_v_tail.svg`,
            5: `${FRAMES}/m_01_05_quad_a_tail.svg`,
            12: `${FRAMES}/m_01_12_quad_x_bf.svg`,
            13: `${FRAMES}/m_01_13_quad_x_dji.svg`,
            14: `${FRAMES}/m_01_14_quad_x_cw.svg`,
            18: `${FRAMES}/m_01_18_quad_x_bf_rev.svg`,
            19: `${FRAMES}/m_01_19_quad_y4a.svg`,
        },
    },
    2: {
        kind: "image",
        classImage: `${FRAMES}/m_02_01_hexa_x.svg`,
        types: {
            0: `${FRAMES}/m_02_00_hexa_plus.svg`,
            1: `${FRAMES}/m_02_01_hexa_x.svg`,
            3: `${FRAMES}/m_02_03_hexa_h.svg`,
            13: `${FRAMES}/m_02_13_hexa_x_dji.svg`,
            14: `${FRAMES}/m_02_14_hexa_x_cw.svg`,
        },
    },
    3: {
        kind: "image",
        classImage: `${FRAMES}/m_03_01_octo_x.svg`,
        types: {
            0: `${FRAMES}/m_03_00_octo_plus.svg`,
            1: `${FRAMES}/m_03_01_octo_x.svg`,
            2: `${FRAMES}/m_03_02_octo_v.svg`,
            3: `${FRAMES}/m_03_03_octo_h.svg`,
            13: `${FRAMES}/m_03_13_octo_x_dji.svg`,
            14: `${FRAMES}/m_03_14_octo_x_cw.svg`,
            15: `${FRAMES}/m_03_15_octo_i.svg`,
        },
    },
    4: {
        kind: "image",
        classImage: `${FRAMES}/m_04_01_octo_quad_x.svg`,
        types: {
            0: `${FRAMES}/m_04_00_octo_quad_plus.svg`,
            1: `${FRAMES}/m_04_01_octo_quad_x.svg`,
            2: `${FRAMES}/m_04_02_octo_quad_v.svg`,
            3: `${FRAMES}/m_04_03_octo_quad_h.svg`,
            12: `${FRAMES}/m_04_12_octo_quad_x_bf.svg`,
            14: `${FRAMES}/m_04_14_octo_quad_x_cw.svg`,
            18: `${FRAMES}/m_04_18_octo_quad_x_bf_rev.svg`,
        },
    },
    5: {
        kind: "image",
        classImage: `${FRAMES}/m_05_00_y6_a.svg`,
        types: {
            0: `${FRAMES}/m_05_00_y6_a.svg`,
            10: `${FRAMES}/m_05_10_y6_b.svg`,
            11: `${FRAMES}/m_05_11_y6_f.svg`,
        },
    },
    6: {kind: "custom", Icon: HeliIcon},
    7: {kind: "image", classImage: `${FRAMES}/m_07_00_tricopter.svg`},
    8: {kind: "custom", Icon: SingleCopterIcon},
    9: {kind: "custom", Icon: CoaxCopterIcon},
    10: {kind: "image", classImage: `${FRAMES}/m_10_00_bicopter.svg`},
    11: {kind: "custom", Icon: HeliDualIcon},
    12: {
        kind: "image",
        classImage: `${FRAMES}/m_12_01_dodecahexa_x.svg`,
        types: {
            0: `${FRAMES}/m_12_00_dodecahexa_plus.svg`,
            1: `${FRAMES}/m_12_01_dodecahexa_x.svg`,
        },
    },
    13: {kind: "custom", Icon: HeliQuadIcon},
    14: {
        kind: "image",
        classImage: `${FRAMES}/m_14_01_deca_x_and_cw_x.svg`,
        types: {
            0: `${FRAMES}/m_14_00_deca_plus.svg`,
            1: `${FRAMES}/m_14_01_deca_x_and_cw_x.svg`,
            14: `${FRAMES}/m_14_01_deca_x_and_cw_x.svg`,
        },
    },
    15: {kind: "scripted"},
    16: {kind: "scripted"},
    17: {kind: "scripted"},
};

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
