// @ts-check
/**
 * Pixel-art sprite painter.
 *
 * Each sprite is built into a tiny offscreen canvas at its native pixel size,
 * then exported as a data URL that the game engine loads as a texture. The
 * engine scales it up with nearest-neighbor filtering so we get chunky 8-bit
 * pixels. No square placeholders — every sprite is hand-composed from rects.
 */

export const C = {
    // outlines / ink
    ink:   '#1a1816',
    ink2:  '#3a3632',
    // neutrals
    white: '#f4efe6',
    whiteD:'#c9c3b5',
    gray:  '#8a8e99',
    grayD: '#4b4f58',
    black: '#121212',
    // skin
    skin:  '#ecb98f',
    skinS: '#b4855e',
    skinD: '#8a5f3e',
    tan:   '#d49b6a',
    // hair
    hair:  '#2b1b10',
    hairH: '#4d2f1a',
    blond: '#e6c878',
    // flag
    red:   '#d62828',
    redD:  '#8a1414',
    redL:  '#f25757',
    blue:  '#2a4fb8',
    blueD: '#1a2a5c',
    blueL: '#5d7fd8',
    // denim
    denim: '#345090',
    denimD:'#1c2d5a',
    // boots/leather
    boot:  '#4a2a14',
    bootD: '#2a180a',
    // metals
    steel: '#b0b6c4',
    steelD:'#6a7088',
    gun:   '#2e3240',
    gunD:  '#141822',
    brass: '#d9a93a',
    // mouth/blood
    mouth: '#a33030',
    blood: '#b31010',
    // plants
    grass: '#4a8a3a',
    grassD:'#2e6226',
    leaf:  '#3c7a2a',
    leafD: '#245818',
    wood:  '#6e4a28',
    woodD: '#3e2a16',
    // sky/clouds
    sky:   '#8ec8ee',
    skyD:  '#5aa8d8',
    cloud: '#f8f4ea',
    cloudD:'#d8d4ca',
    sun:   '#f6d24a',
    sunD:  '#e6a020',
    // camo/olive
    camo:  '#4a5a30',
    camoD: '#2a341a',
    khaki: '#b5a060',
    khakiD:'#7a6838',
    // pickups
    beer:  '#a06418',
    beerL: '#d89a3a',
    label: '#e8e4d4',
    hypoC: '#a0e0f4',
    hypoG: '#78c0d8',
    // church
    stone: '#a0a098',
    stoneD:'#60605a',
    purple:'#5a2a6a',
    purpleD:'#36163e',
};

/**
 * Create an offscreen canvas, let the painter draw into it, and return both.
 * The canvas's toDataURL() is what we feed the engine.
 * @param {number} w
 * @param {number} h
 * @param {(ctx: CanvasRenderingContext2D) => void} paint
 */
function sprite(w, h, paint) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
    ctx.imageSmoothingEnabled = false;
    paint(ctx);
    return { w, h, url: c.toDataURL() };
}

// Tiny rect helper, scoped per painter via closure for terseness.
const R = (ctx) => (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };

// ---------- PLAYER ---------------------------------------------------------

/**
 * Muscled man in white tank + jeans + backwards red cap.
 * @param {CanvasRenderingContext2D} ctx
 * @param {'idle'|'walk1'|'walk2'|'jump'|'hit'} frame
 * @param {{hasCap?: boolean, raging?: boolean}} [opts]
 */
function paintPlayer(ctx, frame, opts = {}) {
    const r = R(ctx);
    const skin = opts.raging ? C.redL : C.skin;
    const skinS = opts.raging ? C.red : C.skinS;

    // Cap (backwards — visor points right)
    if (opts.hasCap !== false) {
        r(4, 0, 9, 1, C.redD);
        r(3, 1, 11, 1, C.red);
        r(3, 2, 11, 1, C.red);
        r(3, 3, 11, 1, C.redD);
        // visor sticks out right
        r(14, 2, 2, 2, C.red);
        r(14, 4, 2, 1, C.redD);
    } else {
        // bare head — dark hair
        r(4, 0, 9, 1, C.hair);
        r(3, 1, 11, 3, C.hair);
    }

    // Head
    r(4, 4, 9, 1, C.ink);              // hairline shadow
    r(4, 5, 9, 4, skin);               // face
    r(4, 5, 1, 4, skinS);              // left shadow
    r(12, 5, 1, 4, skinS);             // right shadow
    // eyes
    r(6, 6, 1, 1, C.white); r(7, 6, 1, 1, C.ink);
    r(10, 6, 1, 1, C.white); r(11, 6, 1, 1, C.ink);
    // brow (angry if raging)
    if (opts.raging) {
        r(6, 5, 2, 1, C.ink);
        r(10, 5, 2, 1, C.ink);
    }
    // nose + mouth
    r(8, 7, 1, 1, skinS);
    r(7, 8, 3, 1, C.mouth);
    // jaw
    r(5, 9, 7, 1, skin);
    r(5, 9, 1, 1, skinS);
    r(11, 9, 1, 1, skinS);
    // neck
    r(7, 10, 3, 1, skinS);

    // Torso — white tank top
    r(3, 11, 11, 1, C.ink);             // shoulder line
    r(3, 12, 11, 6, C.white);
    r(3, 12, 1, 6, C.whiteD);           // left shade
    r(13, 12, 1, 6, C.whiteD);          // right shade
    // flag stripes on chest
    r(5, 13, 7, 1, C.red);
    r(5, 15, 7, 1, C.red);
    // little blue patch (stars)
    r(5, 12, 3, 1, C.blue);
    r(6, 12, 1, 1, C.white);

    // Arms (muscular — bulges below shoulders)
    if (frame === 'walk1') {
        r(1, 12, 2, 5, skin); r(1, 12, 1, 5, skinS); r(1, 17, 2, 1, C.ink);
        r(14, 12, 2, 5, skin); r(15, 12, 1, 5, skinS); r(14, 17, 2, 1, C.ink);
    } else if (frame === 'walk2') {
        r(2, 13, 2, 5, skin); r(2, 13, 1, 5, skinS); r(2, 18, 2, 1, C.ink);
        r(13, 13, 2, 5, skin); r(14, 13, 1, 5, skinS); r(13, 18, 2, 1, C.ink);
    } else if (frame === 'hit') {
        r(1, 10, 2, 4, skin); r(14, 14, 2, 4, skin);
    } else {
        // idle/jump
        r(1, 13, 2, 5, skin); r(1, 13, 1, 5, skinS); r(1, 18, 2, 1, C.ink);
        r(14, 13, 2, 5, skin); r(15, 13, 1, 5, skinS); r(14, 18, 2, 1, C.ink);
    }

    // Belt
    r(3, 18, 11, 1, C.ink);
    r(8, 18, 1, 1, C.brass);            // buckle

    // Legs (jeans) — with walk cycle
    if (frame === 'walk1') {
        r(3, 19, 4, 4, C.denim);
        r(9, 19, 4, 4, C.denim);
        r(3, 19, 1, 4, C.denimD);
        r(9, 19, 1, 4, C.denimD);
        // boots
        r(2, 23, 5, 1, C.boot);
        r(9, 23, 5, 1, C.boot);
    } else if (frame === 'walk2') {
        r(4, 19, 4, 4, C.denim);
        r(8, 19, 4, 4, C.denim);
        r(4, 19, 1, 4, C.denimD);
        r(8, 19, 1, 4, C.denimD);
        r(3, 23, 5, 1, C.boot);
        r(8, 23, 5, 1, C.boot);
    } else if (frame === 'jump') {
        r(3, 19, 4, 3, C.denim);
        r(9, 19, 4, 3, C.denim);
        r(3, 22, 4, 1, C.denimD);
        r(9, 22, 4, 1, C.denimD);
        r(2, 22, 5, 1, C.boot);
        r(9, 22, 5, 1, C.boot);
    } else {
        r(3, 19, 4, 4, C.denim);
        r(9, 19, 4, 4, C.denim);
        r(3, 19, 1, 4, C.denimD);
        r(9, 19, 1, 4, C.denimD);
        r(2, 23, 5, 1, C.boot);
        r(9, 23, 5, 1, C.boot);
    }
}

// ---------- DOG (friendly brown mutt) --------------------------------------

function paintDog(ctx, frame) {
    const r = R(ctx);
    // Body
    r(4, 5, 11, 4, C.hairH);
    r(4, 5, 11, 1, C.hair);           // back shade
    r(4, 8, 11, 1, C.hair);           // belly shade
    // Head
    r(0, 4, 5, 4, C.hairH);
    r(0, 4, 5, 1, C.hair);
    // Ear
    r(1, 2, 2, 3, C.hair);
    // Snout
    r(0, 7, 2, 1, C.hair);
    r(0, 6, 1, 1, C.ink);
    // Eye
    r(2, 5, 1, 1, C.ink);
    // Nose
    r(0, 6, 1, 1, C.ink);
    // Tail
    r(14, 3, 2, 3, C.hair);
    r(15, 2, 1, 2, C.hair);
    // Legs — walk cycle
    if (frame === 'walk1') {
        r(5, 9, 2, 3, C.hair);
        r(12, 9, 2, 3, C.hair);
        r(8, 9, 1, 2, C.hair);
    } else {
        r(4, 9, 2, 3, C.hair);
        r(13, 9, 2, 3, C.hair);
        r(10, 9, 1, 2, C.hair);
    }
}

// ---------- DOG EVIL (monster) -----------------------------------------------

function paintDogEvil(ctx) {
    const r = R(ctx);
    // Dark, matted fur — almost black
    r(4, 5, 11, 4, C.ink2);
    r(4, 5, 11, 1, C.ink);
    r(4, 8, 11, 1, C.ink);
    // Head
    r(0, 4, 5, 4, C.ink2);
    r(0, 4, 5, 1, C.ink);
    // Spiked ear
    r(1, 1, 2, 4, C.ink);
    r(2, 0, 1, 2, C.ink);
    // Snout
    r(0, 6, 3, 2, C.ink2);
    // Fang
    r(1, 8, 1, 2, C.white);
    // Glowing red eye
    r(2, 5, 1, 1, C.red);
    // Spikes along back
    r(6, 4, 1, 2, C.ink);
    r(9, 3, 1, 3, C.ink);
    r(12, 4, 1, 2, C.ink);
    // Tail (spiked)
    r(14, 2, 2, 4, C.ink2);
    r(15, 1, 1, 2, C.ink);
    // Legs
    r(4, 9, 2, 3, C.ink2);
    r(13, 9, 2, 3, C.ink2);
    r(10, 9, 1, 2, C.ink2);
}

// ---------- GENERIC CIVILIAN TORSO (reused) --------------------------------

function paintPerson(ctx, frame, opts) {
    const r = R(ctx);
    const {
        hair = C.hair,
        skin = C.skin,
        skinS = C.skinS,
        shirt = C.blue,
        shirtS = C.blueD,
        pants = C.denim,
        pantsS = C.denimD,
        hat = null,  // {color, shadow} optional
        evil = false,  // dark red eyes if 'evil' (drug hallucination)
    } = opts;

    // Hair / hat
    if (hat) {
        r(4, 0, 8, 2, hat.color);
        r(4, 2, 8, 1, hat.shadow);
        r(3, 1, 10, 1, hat.color);
    } else {
        r(4, 0, 8, 3, hair);
        r(4, 3, 8, 1, C.ink);
    }

    // Head
    r(4, 4, 8, 4, skin);
    r(4, 4, 1, 4, skinS);
    r(11, 4, 1, 4, skinS);
    // eyes
    if (evil) {
        r(5, 5, 2, 1, C.red); r(9, 5, 2, 1, C.red);
    } else {
        r(5, 5, 1, 1, C.ink); r(6, 5, 1, 1, C.white);
        r(9, 5, 1, 1, C.ink); r(10, 5, 1, 1, C.white);
    }
    r(7, 6, 1, 1, skinS);               // nose
    r(6, 7, 3, 1, C.mouth);             // mouth
    r(6, 8, 4, 1, skinS);               // chin
    // neck
    r(7, 9, 2, 1, skinS);

    // Torso
    r(3, 10, 10, 1, C.ink);
    r(3, 11, 10, 6, shirt);
    r(3, 11, 1, 6, shirtS);
    r(12, 11, 1, 6, shirtS);

    // Arms — walk cycle
    if (frame === 'walk1') {
        r(1, 11, 2, 5, shirt); r(13, 12, 2, 5, shirt);
        r(1, 16, 2, 1, skin); r(13, 17, 2, 1, skin);
    } else if (frame === 'walk2') {
        r(2, 12, 2, 5, shirt); r(12, 11, 2, 5, shirt);
        r(2, 17, 2, 1, skin); r(12, 16, 2, 1, skin);
    } else {
        r(1, 12, 2, 5, shirt); r(13, 12, 2, 5, shirt);
        r(1, 17, 2, 1, skin); r(13, 17, 2, 1, skin);
    }

    // Legs
    r(3, 17, 10, 1, C.ink);
    if (frame === 'walk1') {
        r(3, 18, 4, 5, pants); r(9, 18, 4, 5, pants);
        r(3, 18, 1, 5, pantsS); r(9, 18, 1, 5, pantsS);
    } else if (frame === 'walk2') {
        r(4, 18, 4, 5, pants); r(8, 18, 4, 5, pants);
        r(4, 18, 1, 5, pantsS); r(8, 18, 1, 5, pantsS);
    } else {
        r(3, 18, 4, 5, pants); r(9, 18, 4, 5, pants);
        r(3, 18, 1, 5, pantsS); r(9, 18, 1, 5, pantsS);
    }
    // Shoes
    r(2, 23, 5, 1, C.boot);
    r(9, 23, 5, 1, C.boot);
}

// ---------- EVIL/HALLUCINATED CIVILIAN (insane mode) -----------------------
// Completely redrawn in 16x24 with: sickly skin, blazing 2x2 eyes, fangs,
// wild spiked hair, torn dark clothes, and heavy boots.

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ shirt?: string, pants?: string, pantsS?: string, hat?: {color:string,shadow:string}|null }} [opts]
 */
function paintPersonEvil(ctx, opts = {}) {
    const r = R(ctx);
    const { shirt = C.redD, pants = C.ink, pantsS = C.black, hat = null } = opts;

    // Wild spiked hair (or sinister dark hat)
    if (hat) {
        r(4, 0, 8, 2, hat.shadow);
        r(3, 1, 10, 1, hat.shadow);
        r(4, 2, 8, 1, hat.color);
    } else {
        r(3, 0, 1, 3, C.ink);       // left spike
        r(7, 0, 2, 1, C.ink);       // center spike
        r(12, 0, 1, 3, C.ink);      // right spike
        r(4, 1, 8, 3, C.hair);      // hair mass
        r(4, 1, 8, 1, C.ink);       // dark top
    }

    // Head — sickly leathery skin with hard outline
    r(4, 4, 8, 5, C.skinD);
    r(4, 4, 1, 5, C.ink);
    r(11, 4, 1, 5, C.ink);

    // LARGE blazing red eyes (2x2 each) with bright hot core
    r(5, 5, 2, 2, C.red);
    r(9, 5, 2, 2, C.red);
    r(5, 5, 1, 1, C.redL);
    r(9, 5, 1, 1, C.redL);

    // Snarling grimace with dripping fangs
    r(5, 8, 6, 1, C.ink);          // mouth shadow
    r(6, 8, 4, 1, C.blood);        // blood gums
    r(6, 9, 1, 2, C.white);        // left fang
    r(9, 9, 1, 2, C.white);        // right fang

    // Thick neck
    r(7, 10, 2, 2, C.skinD);

    // Torso — dark tattered shirt with torn rips
    r(3, 12, 10, 1, C.ink);        // collar
    r(3, 13, 10, 4, shirt);        // shirt body (already the dark shade)
    r(3, 13, 1, 4, C.ink);
    r(12, 13, 1, 4, C.ink);
    r(5, 14, 2, 2, C.ink);         // rip/tear left
    r(9, 13, 2, 3, C.ink);         // rip/tear right

    // Arms — outstretched aggressively
    r(1, 12, 2, 5, shirt);
    r(13, 12, 2, 5, shirt);
    r(1, 17, 2, 1, C.skinD);       // clenched fist
    r(13, 17, 2, 1, C.skinD);

    // Belt
    r(3, 17, 10, 1, C.ink);

    // Legs — dark heavy stance
    r(3, 18, 4, 5, pants);
    r(9, 18, 4, 5, pants);
    r(3, 18, 1, 5, pantsS);
    r(9, 18, 1, 5, pantsS);

    // Heavy dark boots
    r(2, 23, 5, 1, C.bootD);
    r(9, 23, 5, 1, C.bootD);
}

// ---------- CHILD (small waddler) ------------------------------------------

function paintChild(ctx, frame, evil = false) {
    const r = R(ctx);
    // Hair
    r(3, 0, 6, 2, C.blond);
    r(3, 2, 6, 1, C.ink);
    // Head (big for kid)
    r(3, 3, 6, 4, C.skin);
    r(3, 3, 1, 4, C.skinS);
    r(8, 3, 1, 4, C.skinS);
    if (evil) {
        r(4, 4, 1, 1, C.red); r(7, 4, 1, 1, C.red);
    } else {
        r(4, 4, 1, 1, C.ink); r(7, 4, 1, 1, C.ink);
    }
    r(5, 5, 2, 1, C.mouth);         // smile
    // Torso — t-shirt (yellow)
    r(2, 7, 8, 1, C.ink);
    r(2, 8, 8, 4, C.brass);
    r(2, 8, 1, 4, C.khakiD);
    r(9, 8, 1, 4, C.khakiD);
    // arms
    if (frame === 'walk1') {
        r(1, 8, 1, 4, C.brass); r(10, 9, 1, 4, C.brass);
    } else {
        r(1, 9, 1, 4, C.brass); r(10, 8, 1, 4, C.brass);
    }
    // legs (shorts)
    r(3, 12, 2, 4, C.denim);
    r(7, 12, 2, 4, C.denim);
    // shoes
    r(2, 16, 3, 1, C.white);
    r(7, 16, 3, 1, C.white);
}

// ---------- EVIL CHILD (insane mode 12x17) ---------------------------------

/** @param {CanvasRenderingContext2D} ctx */
function paintChildEvil(ctx) {
    const r = R(ctx);
    // Wild spiked hair
    r(2, 0, 1, 2, C.ink);          // left spike
    r(5, 0, 2, 1, C.ink);          // center spike
    r(9, 0, 1, 2, C.ink);          // right spike
    r(3, 1, 6, 2, C.hair);         // hair mass
    r(3, 1, 6, 1, C.ink);          // dark top

    // Head — sickly, slightly wider
    r(2, 3, 8, 5, C.skinD);
    r(2, 3, 1, 5, C.ink);
    r(9, 3, 1, 5, C.ink);

    // Big glowing eyes (1x2 each with bright core)
    r(3, 4, 2, 2, C.red);
    r(7, 4, 2, 2, C.red);
    r(3, 4, 1, 1, C.redL);
    r(7, 4, 1, 1, C.redL);

    // Creepy grin with tiny fang
    r(4, 7, 4, 1, C.ink);          // mouth
    r(5, 7, 2, 1, C.blood);        // gums
    r(5, 8, 1, 1, C.white);        // tiny fang

    // Neck
    r(5, 8, 2, 1, C.skinD);

    // Tattered shirt (darker yellow)
    r(2, 9, 8, 1, C.ink);
    r(2, 10, 8, 3, C.sunD);
    r(2, 10, 1, 3, C.ink);
    r(9, 10, 1, 3, C.ink);
    r(4, 11, 2, 1, C.ink);         // rip

    // Arms
    r(1, 10, 1, 4, C.sunD);
    r(10, 10, 1, 4, C.sunD);

    // Dark pants
    r(3, 13, 2, 3, C.ink);
    r(7, 13, 2, 3, C.ink);

    // Dark shoes
    r(2, 16, 3, 1, C.bootD);
    r(7, 16, 3, 1, C.bootD);
}

// ---------- HOUSE ----------------------------------------------------------

function paintHouseInsane(ctx) {
    const r = R(ctx);
    r(0, 46, 64, 2, C.ink);
    // Dark stone walls
    r(4, 18, 56, 28, C.stoneD);
    r(4, 18, 56, 1, C.ink);
    for (let y = 22; y < 46; y += 4) r(4, y, 56, 1, C.ink);
    // Crenellated battlements
    r(2, 14, 60, 4, C.stoneD);
    r(0, 16, 64, 2, C.ink);
    r(4, 10, 56, 4, C.stoneD);
    for (let bx = 6; bx < 56; bx += 8) r(bx, 8, 4, 4, C.stoneD);
    // Chimney
    r(48, 4, 6, 10, C.stoneD);
    r(48, 4, 1, 10, C.ink);
    r(47, 4, 8, 1, C.ink);
    // Glowing red windows
    for (const wx of [10, 40]) {
        r(wx, 22, 10, 10, C.redD);
        r(wx + 2, 24, 6, 6, C.redL);
        r(wx, 22, 10, 1, C.ink);
        r(wx, 31, 10, 1, C.ink);
        r(wx, 22, 1, 10, C.ink);
        r(wx + 9, 22, 1, 10, C.ink);
        r(wx - 3, 22, 2, 10, C.stoneD);
        r(wx + 10, 22, 2, 10, C.stoneD);
    }
    // Dark doorway with skull
    r(27, 28, 10, 18, C.ink);
    r(26, 27, 12, 1, C.stoneD);
    r(26, 28, 1, 18, C.stoneD);
    r(37, 28, 1, 18, C.stoneD);
    r(30, 31, 4, 3, C.white);
    r(31, 30, 2, 1, C.white);
    r(30, 34, 1, 1, C.white);
    r(33, 34, 1, 1, C.white);
    r(30, 31, 1, 1, C.ink);
    r(33, 31, 1, 1, C.ink);
    r(31, 33, 2, 1, C.ink);
    // Porch step
    r(25, 46, 14, 2, C.stoneD);
}

function paintHouse(ctx, doorBroken = false) {
    const r = R(ctx);
    // ground shadow under house
    r(0, 46, 64, 2, C.grassD);
    // walls (clapboard)
    r(4, 18, 56, 28, C.khaki);
    r(4, 18, 56, 1, C.khakiD);
    for (let y = 21; y < 46; y += 4) r(4, y, 56, 1, C.khakiD);
    // roof
    r(2, 12, 60, 2, C.red);
    r(0, 14, 64, 4, C.redD);
    r(4, 10, 56, 2, C.red);
    r(6, 8, 52, 2, C.redL);
    // chimney
    r(48, 4, 6, 10, C.stone);
    r(48, 4, 1, 10, C.stoneD);
    r(47, 4, 8, 1, C.stoneD);
    // windows
    for (const wx of [10, 40]) {
        r(wx, 22, 10, 10, C.sky);
        r(wx, 22, 10, 1, C.ink);
        r(wx, 31, 10, 1, C.ink);
        r(wx, 22, 1, 10, C.ink);
        r(wx + 9, 22, 1, 10, C.ink);
        r(wx + 4, 22, 1, 10, C.ink);
        r(wx, 26, 10, 1, C.ink);
        // shutters
        r(wx - 3, 22, 2, 10, C.leafD);
        r(wx + 10, 22, 2, 10, C.leafD);
    }
    // door (or doorway)
    if (doorBroken) {
        r(27, 28, 10, 18, C.ink);       // dark doorway
        // splintered frame
        r(26, 28, 1, 18, C.woodD);
        r(37, 28, 1, 18, C.woodD);
        r(26, 27, 12, 1, C.woodD);
        // splinters
        r(28, 29, 2, 1, C.wood);
        r(34, 31, 2, 1, C.wood);
    } else {
        r(27, 28, 10, 18, C.wood);
        r(27, 28, 10, 1, C.woodD);
        r(27, 28, 1, 18, C.woodD);
        r(36, 28, 1, 18, C.woodD);
        r(34, 37, 1, 2, C.brass);       // doorknob
    }
    // porch step
    r(25, 46, 14, 2, C.stone);
}

// ---------- CHURCH ---------------------------------------------------------

function paintChurch(ctx) {
    const r = R(ctx);
    // Main building
    r(6, 28, 76, 28, C.stone);
    for (let y = 32; y < 56; y += 4) r(6, y, 76, 1, C.stoneD);
    // Steeple base
    r(36, 12, 16, 16, C.stone);
    r(36, 12, 16, 1, C.stoneD);
    // Steeple point
    r(38, 4, 12, 8, C.purple);
    r(38, 4, 12, 1, C.purpleD);
    r(42, 0, 4, 4, C.purple);
    // Cross
    r(43, -6, 2, 8, C.brass);
    r(40, -3, 8, 2, C.brass);
    // Stained glass (round window on steeple)
    r(40, 16, 8, 8, C.redL);
    r(41, 17, 6, 6, C.blue);
    r(42, 18, 4, 4, C.white);
    // Arched doorway
    r(40, 38, 8, 18, C.woodD);
    r(41, 36, 6, 2, C.woodD);
    r(42, 35, 4, 1, C.woodD);
    r(41, 40, 6, 14, C.wood);
    r(44, 40, 1, 14, C.woodD);
    // Windows along the sides
    for (const wx of [14, 66]) {
        r(wx, 36, 6, 12, C.blueL);
        r(wx, 36, 6, 1, C.ink);
        r(wx, 47, 6, 1, C.ink);
        r(wx, 36, 1, 12, C.ink);
        r(wx + 5, 36, 1, 12, C.ink);
        r(wx + 2, 36, 2, 12, C.brass);
    }
    // Ground
    r(0, 56, 88, 4, C.grassD);
}

// ---------- CHURCH (insane — portal to hell) --------------------------------

function paintChurchInsane(ctx) {
    const r = R(ctx);
    // Main building (dark stone)
    r(6, 28, 76, 28, C.stoneD);
    for (let y = 32; y < 56; y += 4) r(6, y, 76, 1, C.ink);
    // Steeple base
    r(36, 12, 16, 16, C.stoneD);
    r(36, 12, 16, 1, C.ink);
    // Steeple point (blood red)
    r(38, 4, 12, 8, C.redD);
    r(38, 4, 12, 1, C.ink);
    r(42, 0, 4, 4, C.redD);
    // Inverted cross
    r(43, -6, 2, 10, C.red);
    r(40, -1, 8, 2, C.red);
    // Round stained window (blood red)
    r(40, 16, 8, 8, C.redD);
    r(41, 17, 6, 6, C.red);
    r(42, 18, 4, 4, C.redL);
    // Arched dark doorway
    r(40, 38, 8, 18, C.ink);
    r(41, 36, 6, 2, C.ink);
    r(42, 35, 4, 1, C.ink);
    // Hellfire rising from entrance
    r(40, 52, 8, 4, C.redD);
    r(41, 49, 6, 4, C.red);
    r(42, 47, 4, 3, C.sunD);
    r(43, 45, 2, 2, C.sun);
    // Blood-red side windows
    for (const wx of [14, 66]) {
        r(wx, 36, 6, 12, C.redD);
        r(wx + 1, 37, 4, 8, C.redL);
        r(wx, 36, 6, 1, C.ink);
        r(wx, 47, 6, 1, C.ink);
        r(wx, 36, 1, 12, C.ink);
        r(wx + 5, 36, 1, 12, C.ink);
        r(wx + 2, 36, 2, 12, C.red);
    }
    // Scorched ground
    r(0, 56, 88, 4, C.ink);
}

// ---------- INTERIOR TILES / FURNITURE -------------------------------------

function paintFloorInt(ctx) {
    const r = R(ctx);
    // Wood plank floor — 16×16 tile
    r(0, 0, 16, 16, C.wood);
    r(0, 0, 16, 1, C.woodD);     // plank seam top
    r(0, 15, 16, 1, C.woodD);    // bottom shadow
    r(0, 0, 1, 16, C.woodD);     // left edge
    // grain lines
    r(3, 5, 1, 1, C.woodD);
    r(9, 9, 2, 1, C.woodD);
    r(5, 12, 1, 1, C.woodD);
    r(12, 3, 1, 1, C.woodD);
}

function paintWallInt(ctx) {
    const r = R(ctx);
    // Painted interior wall — 16×16 tile, pale flag-blue
    r(0, 0, 16, 16, C.khaki);
    // horizontal wainscoting strip
    r(0, 12, 16, 1, C.khakiD);
    r(0, 13, 16, 1, C.woodD);
    // subtle wallpaper dots
    r(3, 3, 1, 1, C.khakiD);
    r(10, 5, 1, 1, C.khakiD);
    r(6, 8, 1, 1, C.khakiD);
}

function paintExitDoor(ctx) {
    const r = R(ctx);
    // Interior-facing door the player uses to leave.
    // 14×26 — wooden panel door with a brass knob.
    r(0, 0, 14, 26, C.wood);
    r(0, 0, 14, 1, C.woodD);
    r(0, 25, 14, 1, C.woodD);
    r(0, 0, 1, 26, C.woodD);
    r(13, 0, 1, 26, C.woodD);
    // Two recessed panels
    r(2, 3, 10, 7, C.woodD);
    r(3, 4, 8, 5, C.wood);
    r(2, 13, 10, 10, C.woodD);
    r(3, 14, 8, 8, C.wood);
    // Brass knob
    r(10, 13, 2, 2, C.brass);
    r(10, 13, 1, 1, C.sun);
}

function paintCabinet(ctx) {
    const r = R(ctx);
    // White medicine cabinet, 20×26, with red cross.
    r(0, 0, 20, 26, C.white);
    r(0, 0, 20, 1, C.ink);
    r(0, 25, 20, 1, C.ink);
    r(0, 0, 1, 26, C.ink);
    r(19, 0, 1, 26, C.ink);
    // Split doors
    r(9, 1, 2, 24, C.whiteD);
    // Red cross, centered
    r(8, 8, 4, 10, C.red);
    r(5, 11, 10, 4, C.red);
    r(8, 8, 4, 1, C.redD);
    r(5, 14, 10, 1, C.redD);
    // Little latches
    r(7, 13, 1, 2, C.steelD);
    r(12, 13, 1, 2, C.steelD);
}

function paintTable(ctx) {
    const r = R(ctx);
    // Wooden table, 24×14
    r(0, 0, 24, 4, C.wood);
    r(0, 0, 24, 1, C.woodD);
    r(0, 3, 24, 1, C.woodD);
    // legs
    r(2, 4, 2, 10, C.woodD);
    r(20, 4, 2, 10, C.woodD);
}

// ---------- PICKUPS --------------------------------------------------------

function paintAmmo(ctx) {
    const r = R(ctx);
    // Wooden crate with bullets sticking out
    r(0, 2, 14, 8, C.wood);
    r(0, 2, 14, 1, C.woodD);
    r(0, 9, 14, 1, C.woodD);
    r(0, 2, 1, 8, C.woodD);
    r(13, 2, 1, 8, C.woodD);
    // metal band
    r(0, 5, 14, 1, C.steelD);
    r(0, 6, 14, 1, C.steel);
    // bullets poking out top
    for (const x of [2, 5, 8, 11]) {
        r(x, 0, 2, 2, C.brass);
        r(x, 0, 2, 1, C.gun);
    }
}

function paintCap(ctx) {
    const r = R(ctx);
    r(2, 1, 8, 2, C.red);
    r(1, 2, 10, 2, C.red);
    r(1, 3, 10, 1, C.redD);
    r(11, 3, 3, 1, C.red);      // visor
    r(11, 4, 3, 1, C.redD);
    r(3, 1, 6, 1, C.redL);      // highlight
    // tiny white stitching "U"
    r(5, 2, 1, 1, C.white);
    r(6, 2, 1, 1, C.white);
    r(7, 2, 1, 1, C.white);
}

function paintSyringe(ctx) {
    const r = R(ctx);
    // body
    r(2, 3, 8, 3, C.hypoC);
    r(2, 3, 8, 1, C.hypoG);
    r(2, 5, 8, 1, C.hypoG);
    // liquid
    r(3, 4, 5, 1, C.purple);
    // plunger
    r(10, 2, 2, 5, C.red);
    r(10, 2, 2, 1, C.redD);
    // needle
    r(0, 4, 2, 1, C.steel);
    r(1, 4, 1, 1, C.steelD);
}

// Insane-mode syringe variant: looks like a health pack / medkit.
function paintHealthPack(ctx) {
    const r = R(ctx);
    // Green box
    r(1, 1, 10, 7, C.grass);
    r(1, 1, 10, 1, C.ink);
    r(1, 7, 10, 1, C.ink);
    r(1, 1, 1, 7, C.ink);
    r(10, 1, 1, 7, C.ink);
    r(1, 1, 1, 7, C.grassD);       // left shadow
    r(1, 7, 10, 1, C.grassD);      // bottom shadow
    // White cross
    r(5, 2, 2, 5, C.white);
    r(3, 4, 6, 2, C.white);
}

function paintBeer(ctx) {
    const r = R(ctx);
    // neck
    r(4, 0, 4, 3, C.beer);
    r(4, 0, 1, 3, C.beerL);
    // body
    r(2, 3, 8, 9, C.beer);
    r(2, 3, 1, 9, C.beerL);
    r(9, 3, 1, 9, C.woodD);
    // label
    r(3, 6, 6, 4, C.label);
    r(3, 6, 6, 1, C.ink);
    r(3, 9, 6, 1, C.ink);
    // tiny text lines
    r(4, 7, 4, 1, C.red);
    r(4, 8, 4, 1, C.blue);
}

// Insane-mode beer variant: looks like a glowing energy drink can.
function paintBeerInsane(ctx) {
    const r = R(ctx);
    // Can shape (cylindrical, electric red)
    r(2, 0, 8, 1, C.steelD);       // top rim
    r(2, 11, 8, 1, C.steelD);      // bottom rim
    r(2, 1, 8, 10, C.red);
    r(2, 1, 1, 10, C.redL);        // highlight
    r(9, 1, 1, 10, C.redD);        // shadow
    // Yellow "E" label (Energy)
    r(3, 3, 6, 5, C.sun);
    r(3, 3, 6, 1, C.sunD);
    r(3, 7, 6, 1, C.sunD);
    // "E" strokes
    r(4, 4, 3, 1, C.red);
    r(4, 5, 2, 1, C.red);
    r(4, 6, 3, 1, C.red);
    r(4, 4, 1, 3, C.red);
}

// ---------- WEAPON (handgun silhouette, held / on ground) ------------------

function paintHandgun(ctx) {
    const r = R(ctx);
    r(1, 3, 10, 3, C.gun);
    r(1, 3, 10, 1, C.gunD);
    r(4, 6, 4, 3, C.gun);           // grip
    r(4, 6, 4, 1, C.gunD);
    r(10, 3, 1, 1, C.ink);          // muzzle
    r(8, 2, 2, 1, C.steelD);        // sight
}

function paintBat(ctx) {
    const r = R(ctx);
    // Baseball bat along diagonal — simplified horizontal
    r(0, 3, 3, 2, C.wood);
    r(3, 2, 9, 4, C.wood);
    r(3, 2, 9, 1, C.woodD);
    r(3, 5, 9, 1, C.woodD);
}

// Sawed-off 12-gauge shotgun — chunky wooden stock + twin steel barrels.
function paintShotgun(ctx) {
    const r = R(ctx);
    // Stock
    r(0, 3, 4, 4, C.wood);
    r(0, 3, 4, 1, C.woodD);
    r(0, 6, 4, 1, C.woodD);
    r(0, 3, 1, 4, C.woodD);
    // Double-barrel body
    r(4, 2, 8, 2, C.gun);
    r(4, 4, 8, 2, C.gun);
    r(4, 2, 8, 1, C.steel);
    r(4, 5, 8, 1, C.gunD);
    // Separator between barrels
    r(4, 3, 8, 1, C.gunD);
    // Trigger guard
    r(4, 6, 2, 2, C.gunD);
    // Muzzles
    r(11, 2, 1, 2, C.ink);
    r(11, 4, 1, 2, C.ink);
}

// SMG — compact, boxy, utilitarian. Drops from SWAT.
function paintSmg(ctx) {
    const r = R(ctx);
    // Stock
    r(0, 4, 4, 3, C.gunD);
    r(0, 4, 4, 1, C.ink);
    // Receiver body
    r(2, 2, 7, 4, C.gun);
    r(2, 2, 7, 1, C.gunD);
    r(2, 5, 7, 1, C.gunD);
    // Barrel
    r(8, 3, 5, 2, C.gun);
    r(13, 3, 1, 2, C.ink);
    // Magazine hanging below receiver
    r(4, 5, 2, 3, C.gunD);
    r(4, 7, 2, 1, C.ink);
    // Sight nub
    r(5, 1, 1, 1, C.steelD);
}

// Taser — bright yellow, electric blue crackle between prongs.
function paintTaser(ctx) {
    const r = R(ctx);
    // Grip
    r(0, 4, 3, 3, C.sun);
    r(0, 4, 3, 1, C.sunD);
    r(0, 6, 3, 1, C.sunD);
    // Body
    r(3, 2, 5, 4, C.sun);
    r(3, 2, 5, 1, C.sunD);
    r(3, 5, 5, 1, C.sunD);
    // Prongs
    r(8, 1, 1, 2, C.steel);
    r(8, 5, 1, 2, C.steel);
    // Electric crackle between prongs
    r(9, 2, 3, 1, C.hypoC);
    r(9, 5, 3, 1, C.hypoC);
    r(10, 3, 1, 2, C.white);
    // "TASER" decal dot
    r(4, 4, 1, 1, C.red);
}

// 'Not A Flamethrower' — olive body, brass fuel canister, angry muzzle.
function paintFlamethrower(ctx) {
    const r = R(ctx);
    // Rear tank
    r(0, 5, 4, 4, C.camo);
    r(0, 5, 4, 1, C.camoD);
    r(0, 8, 4, 1, C.camoD);
    // Body
    r(4, 4, 6, 4, C.camo);
    r(4, 4, 6, 1, C.camoD);
    r(4, 7, 6, 1, C.camoD);
    // Brass fuel canister on top
    r(3, 1, 5, 3, C.brass);
    r(3, 1, 5, 1, C.sun);
    r(3, 3, 5, 1, C.woodD);
    // Nozzle
    r(10, 3, 3, 3, C.gun);
    r(10, 3, 3, 1, C.gunD);
    r(13, 3, 1, 3, C.ink);
    // Red "not a" flame decal
    r(5, 5, 1, 2, C.red);
    r(6, 5, 1, 1, C.sun);
}

// Grenade — a 'lithium battery'. Upright cylinder, red (+) cap on top.
function paintGrenade(ctx) {
    const r = R(ctx);
    // Positive cap
    r(2, 0, 6, 2, C.red);
    r(2, 0, 6, 1, C.redD);
    r(3, 1, 1, 1, C.redL);
    // Terminal nub
    r(4, 0, 2, 1, C.ink);
    // Body (white)
    r(1, 2, 8, 10, C.white);
    r(1, 2, 1, 10, C.whiteD);
    r(8, 2, 1, 10, C.whiteD);
    r(1, 2, 8, 1, C.ink);
    // Red label stripes
    r(1, 4, 8, 1, C.red);
    r(1, 8, 8, 1, C.red);
    // Lightning bolt decal
    r(4, 5, 2, 1, C.ink);
    r(3, 6, 2, 1, C.ink);
    r(5, 6, 1, 1, C.ink);
    r(4, 7, 2, 1, C.ink);
    // Negative cap
    r(1, 12, 8, 2, C.gun);
    r(1, 12, 8, 1, C.gunD);
}

// Clenched fist — used as the HUD icon for the 'fists' weapon slot.
function paintFist(ctx) {
    const r = R(ctx);
    // forearm cuff
    r(0, 4, 3, 3, C.skin);
    r(0, 4, 3, 1, C.skinS);
    r(0, 6, 3, 1, C.skinS);
    // hand mass
    r(3, 2, 8, 7, C.skin);
    r(3, 2, 8, 1, C.skinS);
    r(3, 8, 8, 1, C.skinS);
    r(10, 2, 1, 7, C.skinS);
    // knuckles
    r(11, 2, 2, 2, C.skinD);
    r(11, 5, 2, 2, C.skinD);
    // finger creases
    r(4, 4, 6, 1, C.skinS);
    r(4, 6, 6, 1, C.skinS);
    // thumb on top
    r(6, 1, 3, 1, C.skinS);
    r(6, 2, 3, 1, C.skin);
}

// Molotov cocktail — green glass bottle with a burning rag fuse.
function paintMolotov(ctx) {
    const r = R(ctx);
    // flame tip
    r(5, 0, 2, 1, C.sun);
    r(4, 0, 1, 1, C.sunD);
    r(7, 0, 1, 1, C.sunD);
    // rag fuse
    r(4, 1, 4, 2, C.label);
    r(4, 1, 4, 1, C.whiteD);
    // bottle neck
    r(5, 3, 2, 2, C.leafD);
    r(5, 3, 1, 2, C.ink);
    // bottle body
    r(2, 5, 8, 8, C.leaf);
    r(2, 5, 1, 8, C.leafD);
    r(9, 5, 1, 8, C.leafD);
    r(2, 5, 8, 1, C.leafD);
    r(2, 12, 8, 1, C.leafD);
    // glass highlight
    r(3, 6, 1, 5, C.grass);
    // label
    r(3, 8, 6, 2, C.red);
    r(3, 8, 6, 1, C.redD);
    // base shadow
    r(3, 13, 6, 1, C.ink);
}

// Fire AoE — two-frame flicker.
function paintFire(ctx, frame) {
    const r = R(ctx);
    // embers on the ground
    r(0, 14, 24, 2, C.redD);
    r(2, 12, 20, 2, C.red);
    // lower body
    r(1, 9, 22, 4, C.sunD);
    r(3, 10, 18, 3, C.sun);
    if (frame === 0) {
        // three peaks
        r(4, 6, 5, 4, C.sun);
        r(11, 4, 6, 6, C.sun);
        r(18, 7, 4, 3, C.sun);
        // tips
        r(5, 3, 3, 3, C.sunD);
        r(12, 1, 4, 3, C.sunD);
        r(19, 4, 3, 3, C.sunD);
        // hot core
        r(6, 8, 2, 2, C.white);
        r(13, 6, 2, 2, C.white);
    } else {
        // shifted peaks
        r(3, 7, 4, 3, C.sun);
        r(10, 5, 6, 5, C.sun);
        r(17, 6, 5, 4, C.sun);
        // tips
        r(4, 4, 3, 3, C.sunD);
        r(11, 2, 4, 3, C.sunD);
        r(18, 3, 3, 3, C.sunD);
        // hot core
        r(5, 8, 2, 2, C.white);
        r(12, 6, 2, 2, C.white);
        r(19, 7, 2, 2, C.white);
    }
}

// ---------- ENVIRONMENT TILES ----------------------------------------------

function paintGround(ctx) {
    const r = R(ctx);
    // grass top
    r(0, 0, 16, 3, C.grass);
    r(0, 0, 16, 1, C.leaf);
    // scatter grass tufts
    r(2, 1, 1, 1, C.leaf);
    r(7, 0, 1, 1, C.leafD);
    r(11, 1, 1, 1, C.leaf);
    // dirt body
    r(0, 3, 16, 13, C.wood);
    r(0, 3, 16, 1, C.woodD);
    // pebbles
    r(3, 6, 1, 1, C.steelD);
    r(9, 9, 2, 1, C.steelD);
    r(5, 12, 1, 1, C.steelD);
}

function paintRoad(ctx) {
    const r = R(ctx);
    r(0, 0, 16, 16, C.grayD);
    r(0, 0, 16, 1, C.gray);
    r(0, 15, 16, 1, C.black);
    // worn patches
    r(2, 4, 3, 1, C.grayD);
    r(9, 9, 4, 1, C.black);
    r(6, 12, 2, 1, C.ink2);
}

function paintBush(ctx) {
    const r = R(ctx);
    r(2, 3, 10, 6, C.leaf);
    r(2, 3, 10, 1, C.leafD);
    r(0, 5, 3, 4, C.leaf);
    r(12, 5, 3, 4, C.leaf);
    r(1, 6, 1, 2, C.leafD);
    r(13, 6, 1, 2, C.leafD);
    // highlights
    r(4, 4, 2, 1, C.grass);
    r(8, 5, 2, 1, C.grass);
}

function paintTree(ctx) {
    const r = R(ctx);
    // trunk
    r(14, 20, 4, 12, C.wood);
    r(14, 20, 1, 12, C.woodD);
    // canopy
    r(4, 0, 24, 18, C.leaf);
    r(4, 0, 24, 2, C.leafD);
    r(2, 4, 2, 12, C.leaf);
    r(28, 4, 2, 12, C.leaf);
    r(6, 16, 20, 2, C.leafD);
    // highlights
    r(8, 3, 4, 2, C.grass);
    r(18, 5, 3, 2, C.grass);
}

function paintCloud(ctx) {
    const r = R(ctx);
    r(4, 2, 22, 4, C.cloud);
    r(2, 4, 26, 4, C.cloud);
    r(8, 0, 12, 2, C.cloud);
    r(0, 6, 30, 2, C.cloudD);
}

// Insane-mode cloud variant: dark storm cloud with lightning bolt.
function paintCloudStorm(ctx) {
    const r = R(ctx);
    r(4, 2, 22, 4, C.grayD);
    r(2, 4, 26, 4, C.grayD);
    r(8, 0, 12, 2, C.grayD);
    r(0, 6, 30, 2, C.ink2);
    // Lightning bolt
    r(14, 4, 2, 3, C.sun);
    r(12, 6, 4, 1, C.sun);
    r(13, 7, 2, 3, C.sunD);
}

function paintSun(ctx) {
    const r = R(ctx);
    r(4, 4, 8, 8, C.sun);
    r(3, 5, 10, 6, C.sun);
    r(5, 3, 6, 10, C.sun);
    r(4, 4, 2, 2, C.sunD);
    r(10, 4, 2, 2, C.sunD);
}

function paintTruck(ctx) {
    const r = R(ctx);
    // flat tire shows it's broken down
    // bed
    r(2, 10, 20, 8, C.red);
    r(2, 10, 20, 1, C.redD);
    r(2, 17, 20, 1, C.redD);
    // cab
    r(22, 6, 12, 12, C.red);
    r(22, 6, 12, 1, C.redD);
    // window
    r(24, 8, 8, 5, C.sky);
    r(24, 8, 8, 1, C.ink);
    r(31, 8, 1, 5, C.ink);
    // wheels
    r(5, 18, 6, 4, C.ink);
    r(26, 18, 6, 3, C.ink);    // flat one, squashed
    r(6, 19, 4, 2, C.gun);
    r(27, 19, 4, 1, C.gun);
    // chrome bumper
    r(33, 15, 3, 3, C.steel);
    // hood up (broken)
    r(30, 2, 4, 5, C.redD);
}

// ---------- PROJECTILE -----------------------------------------------------

function paintBullet(ctx) {
    const r = R(ctx);
    r(0, 1, 6, 2, C.brass);
    r(0, 0, 5, 1, C.steel);
    r(0, 3, 5, 1, C.steelD);
    r(5, 1, 1, 2, C.red);
}

// ---------- FX: muzzle flash, blood hit ------------------------------------

function paintFlash(ctx) {
    const r = R(ctx);
    r(3, 3, 6, 2, C.sun);
    r(4, 2, 4, 4, C.sun);
    r(2, 4, 8, 1, C.sun);
    r(5, 0, 2, 1, C.sunD);
    r(5, 7, 2, 1, C.sunD);
    r(0, 4, 2, 1, C.sunD);
    r(10, 4, 2, 1, C.sunD);
}

function paintPoof(ctx) {
    const r = R(ctx);
    r(4, 4, 6, 4, C.cloud);
    r(2, 5, 10, 3, C.cloudD);
    r(6, 2, 4, 10, C.cloud);
    r(4, 10, 2, 2, C.cloudD);
    r(10, 10, 2, 2, C.cloudD);
}

// Tiny airborne blood droplet — a 3-pixel spatter with a single lighter pixel.
/** @param {CanvasRenderingContext2D} ctx */
function paintBlood(ctx) {
    const r = R(ctx);
    r(1, 1, 2, 2, C.blood);
    r(0, 2, 1, 1, C.blood);
    r(2, 0, 1, 1, C.blood);
    r(1, 1, 1, 1, C.red);
}

// Landed blood stain — an irregular wet splash on the ground.
function paintBloodSplat(ctx) {
    const r = R(ctx);
    r(1, 2, 7, 1, C.blood);
    r(0, 3, 9, 1, C.blood);
    r(2, 4, 5, 1, C.blood);
    r(3, 1, 2, 1, C.blood);
    r(6, 1, 1, 1, C.blood);
    r(1, 5, 1, 1, C.blood);
    r(7, 0, 1, 1, C.blood);
    r(3, 2, 1, 1, C.red);       // wet highlight
}

// Taser dart — yellow body with a sharp steel tip and electric crackle tail.
function paintTaserDart(ctx) {
    const r = R(ctx);
    r(0, 1, 5, 2, C.sun);
    r(0, 1, 5, 1, C.sunD);
    r(5, 1, 2, 2, C.steel);
    r(7, 1, 1, 2, C.ink);
    // Electric arc trailing behind
    r(0, 0, 1, 1, C.hypoC);
    r(2, 3, 1, 1, C.hypoC);
}

// Flame bolt — short-lived projectile fired by the flamethrower.
function paintFlameBolt(ctx) {
    const r = R(ctx);
    // Core
    r(2, 2, 4, 2, C.sun);
    r(1, 3, 6, 1, C.sun);
    // Hot tip
    r(5, 1, 2, 1, C.white);
    r(4, 2, 2, 1, C.white);
    // Trailing embers
    r(0, 3, 1, 1, C.sunD);
    r(3, 4, 2, 1, C.red);
    r(2, 5, 2, 1, C.redD);
}

// Grenade explosion — big radial burst with a hot white core.
function paintExplosion(ctx) {
    const r = R(ctx);
    // Outer radiation
    r(3, 3, 12, 12, C.sunD);
    r(5, 1, 8, 16, C.sunD);
    r(1, 5, 16, 8, C.sunD);
    // Core
    r(5, 5, 8, 8, C.sun);
    r(6, 6, 6, 6, C.sun);
    // Fire-rim pockets
    r(2, 6, 2, 6, C.red);
    r(14, 6, 2, 6, C.red);
    r(6, 2, 6, 2, C.red);
    r(6, 14, 6, 2, C.red);
    // Hot white heart
    r(7, 7, 4, 4, C.white);
    r(8, 8, 2, 2, C.sun);
}

// Larger muzzle flash — shotgun's kick feels meatier with a bigger bloom.
function paintFlashBig(ctx) {
    const r = R(ctx);
    r(5, 4, 10, 4, C.sun);
    r(7, 2, 6, 8, C.sun);
    r(9, 0, 2, 2, C.sunD);
    r(9, 10, 2, 2, C.sunD);
    r(0, 5, 5, 2, C.sunD);
    r(15, 5, 5, 2, C.sunD);
    r(8, 4, 4, 4, C.white);
    r(9, 5, 2, 2, C.white);
}

function paintHeart(ctx) {
    const r = R(ctx);
    r(1, 1, 2, 2, C.red);
    r(5, 1, 2, 2, C.red);
    r(0, 2, 8, 3, C.red);
    r(1, 5, 6, 1, C.red);
    r(2, 6, 4, 1, C.red);
    r(3, 7, 2, 1, C.redD);
    // highlight
    r(1, 2, 1, 1, C.redL);
}

// ---------- EXPORTED SPRITE MAP --------------------------------------------

/** Builds every sprite. Call once at game boot. */
export function buildSprites() {
    const s = /** @type {Record<string, any>} */ ({});

    // Player 16x24
    s.playerIdle  = sprite(16, 24, (c) => paintPlayer(c, 'idle'));
    s.playerWalk1 = sprite(16, 24, (c) => paintPlayer(c, 'walk1'));
    s.playerWalk2 = sprite(16, 24, (c) => paintPlayer(c, 'walk2'));
    s.playerJump  = sprite(16, 24, (c) => paintPlayer(c, 'jump'));
    s.playerHit   = sprite(16, 24, (c) => paintPlayer(c, 'hit'));
    s.playerCap   = sprite(16, 24, (c) => paintPlayer(c, 'idle', { hasCap: true }));
    s.playerRage  = sprite(16, 24, (c) => paintPlayer(c, 'idle', { raging: true }));

    // Dog 16x12
    s.dogIdle  = sprite(16, 12, (c) => paintDog(c, 'idle'));
    s.dogWalk1 = sprite(16, 12, (c) => paintDog(c, 'walk1'));
    s.dogEvil  = sprite(16, 12, paintDogEvil);

    // Civilians — use paintPerson with different palettes.
    const civilian = (shirt, shirtS, pants = C.denim, pantsS = C.denimD, extra = {}) =>
        (c, frame) => paintPerson(c, frame, { shirt, shirtS, pants, pantsS, ...extra });

    const father = civilian(C.red, C.redD);
    const mother = civilian(C.purple, C.purpleD, C.red, C.redD, { hair: C.blond });
    const cop    = civilian(C.blueD, C.ink, C.blueD, C.ink, { hat: { color: C.blueD, shadow: C.ink } });
    const scout  = civilian(C.camo, C.camoD, C.camo, C.camoD, { hat: { color: C.camoD, shadow: C.ink } });
    const mallCop= civilian(C.steelD, C.ink, C.gray, C.grayD, { hat: { color: C.ink, shadow: C.ink } });
    const boss   = civilian(C.ink, C.black, C.ink, C.black, { hair: C.hair });
    const choir  = civilian(C.red, C.redD, C.red, C.redD, { hair: C.hair });
    // SWAT — dark plate armor, helmet, near-black fatigues.
    const swat   = civilian(C.gunD, C.ink, C.gunD, C.ink, { hat: { color: C.ink, shadow: C.black }, hair: C.ink });

    // Evil opts keyed by name — shirt uses the shadow colour (already dark) for
    // a tattered, blood-soaked look; hat-wearing enemies keep their headgear.
    const evilOpts = /** @type {Record<string, any>} */ ({
        father:  { shirt: C.redD,   pants: C.ink,   pantsS: C.black },
        mother:  { shirt: C.purpleD, pants: C.redD,  pantsS: C.ink },
        cop:     { shirt: C.ink,    pants: C.ink,   pantsS: C.black, hat: { color: C.ink, shadow: C.black } },
        scout:   { shirt: C.camoD,  pants: C.camoD, pantsS: C.ink,  hat: { color: C.camoD, shadow: C.ink } },
        mallCop: { shirt: C.ink,    pants: C.grayD, pantsS: C.ink,  hat: { color: C.ink, shadow: C.black } },
        boss:    { shirt: C.black,  pants: C.black, pantsS: C.ink },
        choir:   { shirt: C.redD,   pants: C.redD,  pantsS: C.ink },
        swat:    { shirt: C.ink,    pants: C.black, pantsS: C.ink,  hat: { color: C.black, shadow: C.ink } },
    });

    for (const [name, fn] of [
        ['father', father], ['mother', mother],
        ['cop', cop], ['scout', scout], ['mallCop', mallCop],
        ['boss', boss], ['choir', choir], ['swat', swat],
    ]) {
        s[name + 'Idle']  = sprite(16, 24, (c) => fn(c, 'idle'));
        s[name + 'Walk1'] = sprite(16, 24, (c) => fn(c, 'walk1'));
        s[name + 'Walk2'] = sprite(16, 24, (c) => fn(c, 'walk2'));
        s[name + 'Evil']  = sprite(16, 24, (c) => paintPersonEvil(c, evilOpts[name]));
    }

    // Child 12x17
    s.childIdle  = sprite(12, 17, (c) => paintChild(c, 'idle'));
    s.childWalk1 = sprite(12, 17, (c) => paintChild(c, 'walk1'));
    s.childEvil  = sprite(12, 17, paintChildEvil);

    // House
    s.house        = sprite(64, 48, (c) => paintHouse(c, false));
    s.houseBroken  = sprite(64, 48, (c) => paintHouse(c, true));
    s.houseInsane  = sprite(64, 48, paintHouseInsane);

    // Church
    s.church       = sprite(88, 60, paintChurch);
    s.churchInsane = sprite(88, 60, paintChurchInsane);

    // Pickups (serene + insane variants)
    s.ammo        = sprite(14, 10, paintAmmo);
    s.cap         = sprite(14, 6, paintCap);
    s.syringe     = sprite(12, 9, paintSyringe);
    s.healthPack  = sprite(12, 9, paintHealthPack);
    s.beer        = sprite(12, 12, paintBeer);
    s.beerInsane  = sprite(12, 12, paintBeerInsane);

    // Weapons (world sprites + HUD icons)
    s.handgun      = sprite(12, 10, paintHandgun);
    s.bat          = sprite(12, 8,  paintBat);
    s.fist         = sprite(14, 10, paintFist);
    s.molotov      = sprite(12, 14, paintMolotov);
    s.shotgun      = sprite(12, 8,  paintShotgun);
    s.smg          = sprite(14, 8,  paintSmg);
    s.taser        = sprite(12, 8,  paintTaser);
    s.flamethrower = sprite(14, 10, paintFlamethrower);
    s.grenade      = sprite(10, 14, paintGrenade);

    // Fire AoE (two-frame flicker)
    s.fire  = sprite(24, 16, (c) => paintFire(c, 0));
    s.fire2 = sprite(24, 16, (c) => paintFire(c, 1));

    // Tiles
    s.ground   = sprite(16, 16, paintGround);
    s.road     = sprite(16, 16, paintRoad);
    s.floorInt = sprite(16, 16, paintFloorInt);
    s.wallInt  = sprite(16, 16, paintWallInt);

    // Interior furniture
    s.exitDoor = sprite(14, 26, paintExitDoor);
    s.cabinet  = sprite(20, 26, paintCabinet);
    s.table    = sprite(24, 14, paintTable);

    // Scenery
    s.bush       = sprite(15, 10, paintBush);
    s.tree       = sprite(32, 32, paintTree);
    s.cloud      = sprite(30, 10, paintCloud);
    s.cloudStorm = sprite(30, 10, paintCloudStorm);
    s.sun        = sprite(16, 16, paintSun);
    s.truck = sprite(36, 24, paintTruck);

    // FX
    s.bullet     = sprite(6,  4,  paintBullet);
    s.flash      = sprite(12, 8,  paintFlash);
    s.flashBig   = sprite(20, 12, paintFlashBig);
    s.poof       = sprite(14, 14, paintPoof);
    s.heart      = sprite(8,  8,  paintHeart);
    s.blood      = sprite(4,  4,  paintBlood);
    s.bloodSplat = sprite(9,  6,  paintBloodSplat);
    s.taserDart  = sprite(8,  4,  paintTaserDart);
    s.flameBolt  = sprite(8,  6,  paintFlameBolt);
    s.explosion  = sprite(18, 18, paintExplosion);

    return s;
}
