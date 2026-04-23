// @ts-check
/**
 * All game scenes for B.A.M.
 *
 * Scene flow:
 *   splash  → game → death    → scoreboard → splash
 *                  → ending   → scoreboard → splash
 *   splash  → scoreboard → splash
 *
 * The game scene is deliberately dense — one big factory function that spawns
 * the level, enemies, and pickups. Scope is tight (single level), so we keep
 * everything here instead of over-splitting into twenty files.
 */

import { buildSprites } from './sprites.js';
import { fetchTopScores, submitScore, askForName } from './api.js';
import { openShare, readChallenge } from './share.js';

/**
 * Game-world constants. Sprites are painted at 2× native resolution (see
 * `S` in sprites.js), so every pixel-denominated world value is scaled to
 * match. The 512×288 viewport is unchanged; the world is now twice as wide
 * in pixels and each character fills roughly twice the screen area.
 */
const WORLD = {
    width: 8400,
    groundY: 444,
    gravity: 1960,
    playerSpeed: 220,
    jumpVel: 680,
    bulletSpeed: 720,
    // Momentum tuning — player accelerates toward target speed rather than
    // snapping, so runs have weight and mid-air direction changes feel drifty.
    accelGround: 1800,
    accelAir: 1040,
    friction: 1600,
};

/**
 * X-ranges where the ground is missing — holes for the player to fall into.
 * Each is [xStart, xEnd]. Ordered left-to-right; non-overlapping.
 */
const HOLES = [
    [1080, 1170],
    [2680, 2780],
    [5040, 5150],
    [6000, 6090],
];

/** Crime sentencing (years of prison per act). Tuned for satire. */
const SENTENCES = {
    brokeDoor: 2,        // breaking and entering
    drankBeer: 0,        // not a crime on its own
    tookDrugs: 1,        // controlled substance
    theft: 1,            // handgun / ammo / cap / bat
    arson: 15,           // per molotov thrown
    sexOffense: 20,      // entering the ladies' changing room, per offense
    dog: 1,
    child: 99,
    civilian: 25,
    cop: 50,
    choir: 25,
    boss: 50,
    towelWoman: 30,      // murdering an unarmed woman in a towel
};

/** @type {Record<string, {w:number,h:number,url:string}>} */
let SPR;

/** @type {any} */
let k;

/**
 * True whenever the world should appear in its warped "insane" presentation:
 * drunk (intoxicatedUntil not yet elapsed), high (rageUntil), or bleeding
 * (below 70 % of max health). Does NOT affect aggression — only visuals.
 */
function isInsane() {
    if (!run) return false;
    const p = run.player;
    return k.time() < p.intoxicatedUntil
        || k.time() < p.rageUntil
        || p.health < p.maxHealth * 0.7;
}

/**
 * Per-run state that needs to survive scene transitions — the player walks
 * between the outside game scene and the house interior, and we don't want
 * their health / ammo / collected pickups / killed enemies to reset.
 * Reset to `null` when the splash scene loads so each run starts fresh.
 * @type {any}
 */
let run = null;

/**
 * Art-testing mode entered via `?calm`. NPCs never attack, hazards don't
 * damage, no death or ending transitions fire, and the `I` key toggles the
 * insane-mode visuals on/off so you can inspect every sprite variant.
 */
let calmMode = false;
export function setCalmMode(v) { calmMode = !!v; }

/**
 * Ending-cinematic test mode entered via `?ending`. Boots straight into the
 * church interior with BAM pre-equipped with the full arsenal and unlimited
 * ammo so you can quickly murder the priest and watch the cinematic without
 * replaying the whole level. Kept separate from calmMode so the priest/choir
 * stay killable and the cinematic actually fires.
 */
export function bootstrapEndingTest() {
    run = createRun();
    run.startTime = k.time();
    run.player.weapons = ['fists', 'bat', 'handgun', 'shotgun', 'smg', 'taser', 'flamethrower', 'grenade', 'molotov'];
    run.player.weaponIdx = 3;   // shotgun — chunky satisfying priest-killer
    run.player.ammo = {
        fists: null, bat: null,
        handgun: 999, shotgun: 999, smg: 999, taser: 999,
        flamethrower: 999, grenade: 999, molotov: 999,
    };
    // Start drunk so the church reads as the insane hellscape for visual
    // testing; the cinematic will clear intoxicatedUntil itself mid-sequence.
    run.player.intoxicatedUntil = k.time() + 600;
    k.go('churchInterior');
}

function createRun() {
    return {
        /** Set once on first entry into the game scene. */
        startTime: null,
        player: {
            health: 100, maxHealth: 100,
            // All weapon IDs — fists and bat are melee (ammo=null), handgun and
            // molotov use their own per-weapon counter. Unified so the HUD and
            // the single-button "use" handler just look up the current slot.
            // BAM's handgun starts on the ground by the crashed truck — he has
            // to pick it up. Picking up his own gun is not theft.
            weapons: ['fists', 'molotov'],
            weaponIdx: 0,
            ammo: {
                fists: null, bat: null,
                handgun: 0, shotgun: 0, smg: 0, taser: 0,
                flamethrower: 0, grenade: 0, molotov: 2,
            },
            invulnUntil: 0,
            rageUntil: 0,
            intoxicatedUntil: 0,    // set to k.time()+20 on game start (drunk from crash)
            facing: 1,
            stunUntil: 0,
            knockVx: 0,
            lastAttack: -999,
            lastFire: -999,  // cooldown guard for cadence-limited weapons
        },
        stats: {
            kills: { dog: 0, child: 0, civilian: 0, cop: 0, choir: 0, boss: 0, towelWoman: 0 },
            drankBeer: false,
            tookDrugs: false,
            brokeDoor: false,
            stoleItems: 0,
            arsonCount: 0,
            sexOffenseCount: 0,
        },
        /** Set once the front door is smashed so re-entering the game scene
         *  from the interior keeps the broken-door visual. */
        doorBroken: false,
        /** IDs of pickups consumed so far so they don't respawn on scene reload. */
        consumedPickups: new Set(),
        /** IDs of enemies killed so far so they don't respawn on scene reload. */
        killedEnemies: new Set(),
        /** Once a human is murdered, every surviving human (cops, civilians,
         *  choir, boss, mall cops) becomes permanently hostile — even ones
         *  not yet spawned or currently offscreen. Children are exempt. */
        globalAggro: false,
    };
}

/** Register all scenes and initialize sprites. Call once on boot. */
export function registerScenes(kaplay) {
    k = kaplay;
    SPR = buildSprites();
    for (const [name, s] of Object.entries(SPR)) {
        k.loadSprite(name, s.url);
    }

    k.scene('splash', splashScene);
    k.scene('game', gameScene);
    k.scene('house', houseScene);
    k.scene('bank', bankScene);
    k.scene('gunShop', gunShopScene);
    k.scene('poolLobby', poolLobbyScene);
    k.scene('poolMens', poolMensScene);
    k.scene('poolWomens', poolWomensScene);
    k.scene('churchInterior', churchInteriorScene);
    k.scene('policeOutside', policeOutsideScene);
    k.scene('death', deathScene);
    k.scene('ending', endingScene);
    k.scene('scoreboard', scoreboardScene);
    k.scene('debug', debugScene);
}

// ===========================================================================
// SHARED: player setup, input, HUD, factories
//
// Both the outside `game` scene and the interior `house` scene need the same
// set of mechanics — a player entity with input, a HUD, collision handlers,
// and enemy/pickup factories that respect the persistent `run` state.
// `buildPlayingContext` creates all of that in one place and returns the
// helpers each scene needs to spawn its specific level content.
// ===========================================================================

/**
 * @param {{ spawnX: number, minX: number, maxX: number, invincible?: boolean, enemyActiveDistance?: number, spawnFireAt?: (x: number) => void }} opts
 */
function buildPlayingContext(opts) {
    const player = run.player;
    const stats = run.stats;
    const invincible = !!opts.invincible;
    const enemyActiveDistance = opts.enemyActiveDistance ?? 600;

    // Fraction of the intoxication/rage bar currently filled (0..1). Used by
    // both the HUD readout and the run-speed multiplier so they can't drift.
    const intoxLevel = () => {
        const drunkLeft = Math.max(0, player.intoxicatedUntil - k.time());
        const highLeft  = Math.max(0, player.rageUntil - k.time());
        return Math.max(
            Math.min(1, drunkLeft / 20),
            highLeft > 0 ? Math.min(1, highLeft / 25) : 0,
        );
    };

    // ----- Player entity ----------------------------------------------------
    const p = k.add([
        k.sprite('playerIdle'),
        k.pos(opts.spawnX, WORLD.groundY - 48),
        k.area({ collisionIgnore: ['enemy'] }),
        k.body(),
        k.anchor('top'),
        'player',
        { walkFrame: 0, walkTick: 0, curSprite: 'playerIdle' },
    ]);

    // Movement is driven by edge-triggered key events rather than isKeyDown
    // polling. KAPLAY's global key state can leak across scene transitions
    // (e.g. when the name-entry overlay steals focus and swallows a keyup),
    // which caused the player to run off on restart. Scene-scoped flags start
    // fresh every time buildPlayingContext runs.
    let leftHeld = false, rightHeld = false;
    k.onKeyPress(['left', 'a'],    () => { leftHeld  = true;  });
    k.onKeyRelease(['left', 'a'],  () => { leftHeld  = false; });
    k.onKeyPress(['right', 'd'],   () => { rightHeld = true;  });
    k.onKeyRelease(['right', 'd'], () => { rightHeld = false; });

    p.onUpdate(() => {
        // Clamp to scene bounds (minX/maxX are scene-specific).
        if (p.pos.x < opts.minX) p.pos.x = opts.minX;
        if (p.pos.x > opts.maxX) p.pos.x = opts.maxX;

        // Momentum-based horizontal movement. Target speed comes from held keys,
        // actual velocity lerps toward it with different accel values on the
        // ground vs. in the air — air control is reduced but still enough to
        // change direction mid-jump, which is what players expect from a 2D
        // platformer even if it isn't realistic.
        if (k.time() < player.stunUntil) {
            p.vel.x = player.knockVx;
        } else {
            const grounded = p.isGrounded();
            const accel = grounded ? WORLD.accelGround : WORLD.accelAir;
            const decel = grounded ? WORLD.friction : WORLD.friction * 0.35;
            // Running faster while drunk / raging — scales linearly with the
            // intox bar up to 1.5× at full energy.
            const spd = WORLD.playerSpeed * (1 + 0.5 * intoxLevel());
            let targetVx = 0;
            if (leftHeld)  { targetVx -= spd; player.facing = -1; }
            if (rightHeld) { targetVx += spd; player.facing =  1; }
            const dt = k.dt();
            if (targetVx === 0) {
                if (p.vel.x > 0)      p.vel.x = Math.max(0, p.vel.x - decel * dt);
                else if (p.vel.x < 0) p.vel.x = Math.min(0, p.vel.x + decel * dt);
            } else if (p.vel.x < targetVx) {
                p.vel.x = Math.min(targetVx, p.vel.x + accel * dt);
            } else if (p.vel.x > targetVx) {
                p.vel.x = Math.max(targetVx, p.vel.x - accel * dt);
            }
        }


        // Sprite swapping by state
        const moving = Math.abs(p.vel.x) > 20;
        const grounded = p.isGrounded();
        let spriteName;
        if (!grounded) spriteName = 'playerJump';
        else if (k.time() - player.lastAttack < 0.15) spriteName = 'playerHit';
        else if (moving) {
            p.walkTick += k.dt();
            if (p.walkTick > 0.12) { p.walkTick = 0; p.walkFrame = 1 - p.walkFrame; }
            spriteName = p.walkFrame === 0 ? 'playerWalk1' : 'playerWalk2';
        } else {
            spriteName = 'playerIdle';
        }
        if (k.time() < player.rageUntil) spriteName = 'playerRage';
        if (spriteName !== p.curSprite) {
            p.curSprite = spriteName;
            p.use(k.sprite(spriteName));
        }
        p.flipX = player.facing < 0;

        // Fall-off-world safety.
        if (p.pos.y > k.height() + 120) playerDeath();
    });

    // Jump (one-shot impulse)
    k.onKeyPress(['up', 'w'], () => {
        if (p.isGrounded() && k.time() >= player.stunUntil) {
            p.vel.y = -WORLD.jumpVel;
        }
    });

    // Use current weapon (X). Fists, bat, handgun and molotov are all
    // "weapons" — a single key triggers whichever is equipped, so the player
    // only ever has to think about what they're holding, not which button.
    k.onKeyPress('x', () => useWeapon());
    // SMG fires continuously while the key is held; other weapons stay
    // press-to-fire (their own cooldown guards block re-entry anyway).
    k.onKeyDown('x', () => {
        if (player.weapons[player.weaponIdx] === 'smg') useWeapon();
    });

    // Cycle weapon (Z). X and Z sit next to each other on QWERTY so the
    // player can fire and swap with the same hand while the other holds
    // movement — closer than the old X/C pair.
    k.onKeyPress('z', () => {
        if (player.weapons.length > 1) {
            player.weaponIdx = (player.weaponIdx + 1) % player.weapons.length;
        }
    });

    /**
     * If the player is standing right in front of the intact front door, any
     * attack lands on it regardless of facing or spawn-offset math. Returns
     * true when the door was hit and useWeapon should early-return.
     */
    function tryHitDoor(wp) {
        const door = k.get('door')[0];
        if (!door) return false;
        const doorCx = door.pos.x + door.width / 2;
        if (Math.abs(p.pos.x - doorCx) > 40) return false;
        const rage = k.time() < player.rageUntil;
        let dmg = 0;
        let consumesAmmo = true;
        if (wp === 'fists')             { dmg = rage ? 50 : 25;   consumesAmmo = false; }
        else if (wp === 'bat')          { dmg = rage ? 90 : 45;   consumesAmmo = false; }
        else if (wp === 'handgun')      dmg = rage ? 80 : 40;
        else if (wp === 'shotgun')      dmg = rage ? 60 : 30;
        else if (wp === 'smg')          dmg = rage ? 30 : 15;
        else if (wp === 'taser')        dmg = 6;
        else if (wp === 'flamethrower') dmg = 20;
        else if (wp === 'molotov')      dmg = 40;
        else if (wp === 'grenade')      dmg = 70;
        else return false;
        if (consumesAmmo) {
            const count = player.ammo[wp];
            if (count == null || count <= 0) return false;
            player.ammo[wp] = count - 1;
        }
        if (wp === 'molotov') {
            stats.arsonCount++;
            if (opts.spawnFireAt) opts.spawnFireAt(door.pos.x + 10);
        }
        player.lastAttack = k.time();
        player.lastFire = k.time();
        door.hurt(dmg);
        // Flash at the door so the player sees the hit register.
        k.add([k.sprite('flash'), k.pos(doorCx, door.pos.y + 8), k.anchor('center'), k.opacity(1), k.lifespan(0.08), k.z(40)]);
        return true;
    }

    function useWeapon() {
        const wp = player.weapons[player.weaponIdx];
        if (tryHitDoor(wp)) return;
        if (wp === 'fists' || wp === 'bat') {
            player.lastAttack = k.time();
            const isBat = wp === 'bat';
            const reach = isBat ? 20 : 12;
            const base = isBat ? 45 : 25;
            const damage = k.time() < player.rageUntil ? base * 2 : base;
            // Hitbox starts at the player's body edge (±16 from center, since the
            // 32-wide sprite uses anchor 'top') and extends `reach` px outward.
            const rx = p.pos.x + (player.facing > 0 ? 16 : -(16 + reach));
            const ry = p.pos.y + 8;
            k.add([
                k.rect(reach, 36),
                k.pos(rx, ry),
                k.opacity(0),
                k.area(),
                k.lifespan(0.1),
                'playerMelee',
                { damage },
            ]);
            if (isBat) {
                // Anchor 'left' puts the rotation pivot at the handle end of
                // the 24×16 sprite; angles below are chosen so the barrel arcs
                // overhead and down on the facing side of the player.
                const facing = player.facing;
                const swingStart = facing > 0 ?  -70 : -110;
                const swingEnd   = facing > 0 ?   45 : -225;
                const SWING_DUR = 0.18;
                const batVis = k.add([
                    k.sprite('bat'),
                    k.pos(p.pos.x + facing * 4, p.pos.y + 20),
                    k.anchor('left'),
                    k.rotate(swingStart),
                    k.opacity(1),
                    k.z(10),
                    k.lifespan(SWING_DUR),
                    { swingAge: 0, swingStart, swingEnd, swingDur: SWING_DUR, swingFacing: facing },
                ]);
                batVis.onUpdate(() => {
                    batVis.swingAge += k.dt();
                    const t = Math.min(1, batVis.swingAge / batVis.swingDur);
                    batVis.angle = batVis.swingStart + (batVis.swingEnd - batVis.swingStart) * t;
                    batVis.pos.x = p.pos.x + batVis.swingFacing * 4;
                    batVis.pos.y = p.pos.y + 20;
                });
            }
        } else if (wp === 'handgun') {
            if (player.ammo.handgun <= 0) return;
            const dir = player.facing;
            const bx = p.pos.x + (dir > 0 ? 28 : -20);
            const by = p.pos.y + 20;
            player.ammo.handgun--;
            player.lastAttack = k.time();
            const bullet = k.add([
                k.sprite('bullet', { flipX: dir < 0 }),
                k.pos(bx, by),
                k.area(),
                k.anchor('center'),
                k.offscreen({ destroy: true, distance: 400 }),
                'bullet',
                { damage: k.time() < player.rageUntil ? 80 : 40, vx: dir * WORLD.bulletSpeed },
            ]);
            bullet.onUpdate(() => { bullet.pos.x += bullet.vx * k.dt(); });
            k.add([
                k.sprite('flash'),
                k.pos(bx, by - 4),
                k.anchor('center'),
                k.opacity(1),
                k.lifespan(0.06),
            ]);
        } else if (wp === 'molotov') {
            if (player.ammo.molotov <= 0) return;
            const dir = player.facing;
            const mx = p.pos.x + (dir > 0 ? 20 : -20);
            const my = p.pos.y + 4;
            player.ammo.molotov--;
            stats.arsonCount++;
            player.lastAttack = k.time();
            const bottle = k.add([
                k.sprite('molotov'),
                k.pos(mx, my),
                k.area(),
                k.anchor('center'),
                'molotov',
                { vx: dir * 560, vy: -560 },
            ]);
            bottle.onUpdate(() => {
                bottle.vy += WORLD.gravity * 1.2 * k.dt();
                bottle.pos.x += bottle.vx * k.dt();
                bottle.pos.y += bottle.vy * k.dt();
                if (bottle.pos.y >= WORLD.groundY - 8) {
                    spawnFire(bottle.pos.x, WORLD.groundY);
                    k.destroy(bottle);
                }
            });
        } else if (wp === 'shotgun') {
            if (player.ammo.shotgun <= 0) return;
            if (k.time() - player.lastFire < 0.55) return;
            player.ammo.shotgun--;
            player.lastFire = k.time();
            player.lastAttack = k.time();
            const dir = player.facing;
            const bx = p.pos.x + (dir > 0 ? 28 : -20);
            const by = p.pos.y + 20;
            // Seven pellets in a cone — individual lifespans clip the effective
            // range so the shotgun punishes distance.
            for (let i = 0; i < 7; i++) {
                const spread = (Math.random() - 0.5) * 0.55;
                const speed = WORLD.bulletSpeed * 1.2 * (0.85 + Math.random() * 0.3);
                const pellet = k.add([
                    k.sprite('bullet', { flipX: dir < 0 }),
                    k.pos(bx, by + (Math.random() - 0.5) * 8),
                    k.area(),
                    k.anchor('center'),
                    k.offscreen({ destroy: true, distance: 400 }),
                    k.opacity(1),
                    k.lifespan(0.32),
                    'bullet',
                    { damage: k.time() < player.rageUntil ? 24 : 12, vx: dir * speed, vy: spread * speed },
                ]);
                pellet.onUpdate(() => {
                    pellet.pos.x += pellet.vx * k.dt();
                    pellet.pos.y += pellet.vy * k.dt();
                });
            }
            k.add([k.sprite('flashBig'), k.pos(bx + dir * 8, by - 4), k.anchor('center'), k.opacity(1), k.lifespan(0.1), k.z(40)]);
            if (k.shake) k.shake(4);
        } else if (wp === 'smg') {
            if (player.ammo.smg < 1) return;
            // Full-auto: one bullet every ~90 ms while the fire key is held.
            if (k.time() - player.lastFire < 0.09) return;
            player.lastFire = k.time();
            player.lastAttack = k.time();
            player.ammo.smg--;
            const dir = player.facing;
            const bx = p.pos.x + (dir > 0 ? 28 : -20);
            const by = p.pos.y + 20 + (Math.random() - 0.5) * 4;
            const b = k.add([
                k.sprite('bullet', { flipX: dir < 0 }),
                k.pos(bx, by),
                k.area(),
                k.anchor('center'),
                k.offscreen({ destroy: true, distance: 400 }),
                'bullet',
                { damage: k.time() < player.rageUntil ? 30 : 15, vx: dir * WORLD.bulletSpeed * 1.15 },
            ]);
            b.onUpdate(() => { b.pos.x += b.vx * k.dt(); });
            k.add([k.sprite('flash'), k.pos(bx, by - 4), k.anchor('center'), k.opacity(1), k.lifespan(0.04), k.z(40)]);
        } else if (wp === 'taser') {
            if (player.ammo.taser <= 0) return;
            if (k.time() - player.lastFire < 0.5) return;
            player.ammo.taser--;
            player.lastFire = k.time();
            player.lastAttack = k.time();
            const dir = player.facing;
            const bx = p.pos.x + (dir > 0 ? 28 : -20);
            const by = p.pos.y + 20;
            const dart = k.add([
                k.sprite('taserDart', { flipX: dir < 0 }),
                k.pos(bx, by),
                k.area(),
                k.anchor('center'),
                k.offscreen({ destroy: true, distance: 400 }),
                k.opacity(1),
                k.lifespan(1.2),
                'taserDart',
                { damage: 6, vx: dir * WORLD.bulletSpeed * 0.9 },
            ]);
            dart.onUpdate(() => { dart.pos.x += dart.vx * k.dt(); });
        } else if (wp === 'flamethrower') {
            if (player.ammo.flamethrower <= 0) return;
            if (k.time() - player.lastFire < 0.08) return;
            player.ammo.flamethrower--;
            player.lastFire = k.time();
            player.lastAttack = k.time();
            const dir = player.facing;
            const bx = p.pos.x + (dir > 0 ? 28 : -20);
            const by = p.pos.y + 20;
            // Short-range stream of flame bolts. Each one does modest damage,
            // arcs slightly downward, and leaves a little fire if it hits ground.
            for (let i = 0; i < 4; i++) {
                const spread = (Math.random() - 0.5) * 0.35;
                const speed = 560 + Math.random() * 160;
                const flame = k.add([
                    k.sprite('flameBolt', { flipX: dir < 0 }),
                    k.pos(bx + dir * Math.random() * 12, by - 4 + Math.random() * 12),
                    k.area(),
                    k.anchor('center'),
                    k.opacity(1),
                    k.lifespan(0.35),
                    'flameBolt',
                    { damage: 9, vx: dir * speed, vy: spread * speed + 120 },
                ]);
                flame.onUpdate(() => {
                    flame.pos.x += flame.vx * k.dt();
                    flame.pos.y += flame.vy * k.dt();
                    flame.vy += 360 * k.dt();
                    if (flame.pos.y >= WORLD.groundY - 4) {
                        if (Math.random() < 0.25) spawnFire(flame.pos.x, WORLD.groundY);
                        k.destroy(flame);
                    }
                });
            }
        } else if (wp === 'grenade') {
            if (player.ammo.grenade <= 0) return;
            if (k.time() - player.lastFire < 0.4) return;
            player.ammo.grenade--;
            player.lastFire = k.time();
            player.lastAttack = k.time();
            const dir = player.facing;
            const mx = p.pos.x + (dir > 0 ? 20 : -20);
            const my = p.pos.y + 4;
            const nade = k.add([
                k.sprite('grenade'),
                k.pos(mx, my),
                k.area(),
                k.anchor('center'),
                'grenade',
                { vx: dir * 520, vy: -520, fuse: 1.8 },
            ]);
            nade.onUpdate(() => {
                nade.fuse -= k.dt();
                nade.vy += WORLD.gravity * 1.1 * k.dt();
                nade.pos.x += nade.vx * k.dt();
                nade.pos.y += nade.vy * k.dt();
                if (nade.pos.y >= WORLD.groundY - 6) {
                    nade.pos.y = WORLD.groundY - 6;
                    nade.vy = -Math.abs(nade.vy) * 0.3;
                    nade.vx *= 0.5;
                }
                if (nade.fuse <= 0) {
                    explode(nade.pos.x, nade.pos.y - 8);
                    k.destroy(nade);
                }
            });
        }
    }

    // ----- Blood splatter + explosion --------------------------------------
    /** @param {number} x @param {number} y @param {number} dirX @param {number} intensity */
    function spawnBloodSplatter(x, y, dirX, intensity) {
        const count = Math.floor(3 * intensity + Math.random() * 3 * intensity) + 2;
        for (let i = 0; i < count; i++) {
            const speedX = dirX * (80 + Math.random() * 320) + (Math.random() - 0.5) * 160;
            const speedY = -(120 + Math.random() * 320);
            const droplet = k.add([
                k.sprite('blood'),
                k.pos(x + (Math.random() - 0.5) * 12, y + (Math.random() - 0.5) * 8),
                k.anchor('center'),
                k.z(30),
                k.opacity(1),
                k.lifespan(1.2),
                { vx: speedX, vy: speedY, landed: false, curDropSprite: 'blood' },
            ]);
            droplet.onUpdate(() => {
                if (droplet.landed) return;
                droplet.vy += WORLD.gravity * 1.4 * k.dt();
                droplet.pos.x += droplet.vx * k.dt();
                droplet.pos.y += droplet.vy * k.dt();
                if (droplet.pos.y >= WORLD.groundY - 2) {
                    droplet.pos.y = WORLD.groundY - 2;
                    droplet.landed = true;
                    droplet.vx = 0;
                    droplet.vy = 0;
                    if (droplet.curDropSprite !== 'bloodSplat') {
                        droplet.curDropSprite = 'bloodSplat';
                        droplet.use(k.sprite('bloodSplat'));
                    }
                }
            });
        }
    }

    /**
     * Grenade explosion — AoE damage, knockback, screen shake, residual fire.
     * @param {number} x @param {number} y
     */
    function explode(x, y) {
        const radius = 112;
        const damage = 70;
        const boom = k.add([
            k.sprite('explosion'),
            k.pos(x, y),
            k.anchor('center'),
            k.scale(1),
            k.opacity(1),
            k.z(60),
            k.lifespan(0.4),
            { age: 0 },
        ]);
        boom.onUpdate(() => {
            boom.age += k.dt();
            const s = 1 + boom.age * 5;
            boom.scale = k.vec2(s, s);
            boom.opacity = Math.max(0, 1 - boom.age / 0.4);
        });
        for (const e of k.get('enemy')) {
            const dx = e.pos.x - x;
            const dy = e.pos.y - y;
            if (Math.abs(dx) < radius && Math.abs(dy) < 96) {
                e.hurt(damage);
                if (e.kind !== 'child') e.state = 'hostile';
                spawnBloodSplatter(e.pos.x + 16, e.pos.y + 24, Math.sign(dx) || 1, 1.2);
            }
        }
        const pDx = p.pos.x - x;
        if (Math.abs(pDx) < radius) {
            hurtPlayer(40, { pos: { x, y } });
        }
        // Residual fire at ground zero.
        spawnFire(x, WORLD.groundY);
        if (k.shake) k.shake(16);
    }

    // Molotov impact — direct hit on an enemy or the front door spawns fire.
    k.onCollide('molotov', 'enemy', (m) => {
        spawnFire(m.pos.x, WORLD.groundY);
        k.destroy(m);
    });
    k.onCollide('molotov', 'door', (m, d) => {
        spawnFire(m.pos.x, WORLD.groundY);
        d.hurt(40);
        k.destroy(m);
    });

    function spawnFire(x, y) {
        const fire = k.add([
            k.sprite('fire'),
            k.pos(x, y),
            k.anchor('bot'),
            k.opacity(1),
            k.lifespan(3),
            'fire',
            { fireFrame: 0, frameTick: 0, dmgTick: 0, curSprite: 'fire' },
        ]);
        fire.onUpdate(() => {
            fire.frameTick += k.dt();
            if (fire.frameTick > 0.12) {
                fire.frameTick = 0;
                fire.fireFrame = 1 - fire.fireFrame;
                const name = fire.fireFrame === 0 ? 'fire' : 'fire2';
                if (name !== fire.curSprite) {
                    fire.curSprite = name;
                    fire.use(k.sprite(name));
                }
            }
            fire.dmgTick += k.dt();
            if (fire.dmgTick > 0.4) {
                fire.dmgTick = 0;
                for (const e of k.get('enemy')) {
                    if (Math.abs(e.pos.x - fire.pos.x) < 28) {
                        e.hurt(12);
                        if (e.state !== 'hostile' && e.kind !== 'child') e.state = 'hostile';
                        spreadAggro(e.pos.x);
                    }
                }
                if (Math.abs(p.pos.x - fire.pos.x) < 28) {
                    hurtPlayer(8, fire);
                }
            }
        });
        spawnPoof(x, y - 16);
        return fire;
    }

    // ----- Shared hurt / death ---------------------------------------------
    function hurtPlayer(amount, src) {
        if (invincible) return;
        if (k.time() < player.invulnUntil) return;
        player.health -= amount;
        player.invulnUntil = k.time() + 0.4;
        if (src?.pos) {
            const dir = p.pos.x < src.pos.x ? -1 : 1;
            player.knockVx = dir * 200;
            player.stunUntil = k.time() + 0.15;
            p.vel.y = -240;
        }
        if (player.health <= 0) {
            player.health = 0;
            playerDeath();
        }
    }

    function playerDeath() {
        if (calmMode) return;
        k.wait(0.3, () => {
            k.go('death', {
                stats,
                runTimeMs: Math.floor((k.time() - run.startTime) * 1000),
            });
        });
    }

    // ----- Shared collision handlers ---------------------------------------
    // Enemy↔player contact is handled by a manual overlap check inside
    // `p.onUpdate` above — the `collisionIgnore` on both areas (which keeps
    // enemies from physics-pushing the player) also suppresses
    // `k.onCollide('enemy', 'player')` events.

    k.onCollide('playerMelee', 'enemy', (m, e) => {
        e.hurt(m.damage);
        if (e.state !== 'hostile' && e.kind !== 'child') aggro(e);
        spreadAggro(e.pos.x);
    });

    k.onCollide('bullet', 'enemy', (b, e) => {
        e.hurt(b.damage);
        if (e.state !== 'hostile' && e.kind !== 'child') aggro(e);
        spreadAggro(e.pos.x);
        spawnPoof(b.pos.x, b.pos.y);
        k.destroy(b);
    });

    k.onCollide('enemyBullet', 'player', (/** @type {any} */ b) => {
        hurtPlayer(b.damage, b);
        k.destroy(b);
    });

    // Taser dart — low damage, long stun. First enemy hit is paralysed; the
    // dart is consumed on impact so it can't chain-stun a group.
    k.onCollide('taserDart', 'enemy', (/** @type {any} */ d, /** @type {any} */ e) => {
        e.hurt(d.damage);
        e.stunUntil = k.time() + 3;
        if (e.state !== 'hostile' && e.kind !== 'child') aggro(e);
        spreadAggro(e.pos.x);
        spawnBloodSplatter(d.pos.x, d.pos.y, Math.sign(d.vx) || 1, 0.35);
        k.destroy(d);
    });

    // Flame bolt — small damage per particle, ignites the enemy (ground fire
    // handles the DoT so we don't have to track per-enemy burn timers here).
    k.onCollide('flameBolt', 'enemy', (/** @type {any} */ f, /** @type {any} */ e) => {
        e.hurt(f.damage);
        if (e.state !== 'hostile' && e.kind !== 'child') aggro(e);
        spreadAggro(e.pos.x);
        if (Math.random() < 0.5) spawnFire(e.pos.x, WORLD.groundY);
        k.destroy(f);
    });

    // Grenade — direct contact with enemy triggers the explosion immediately.
    k.onCollide('grenade', 'enemy', (/** @type {any} */ g) => {
        explode(g.pos.x, g.pos.y - 4);
        k.destroy(g);
    });
    k.onCollide('grenade', 'door', (/** @type {any} */ g, /** @type {any} */ d) => {
        explode(g.pos.x, g.pos.y - 4);
        d.hurt(80);
        k.destroy(g);
    });

    function aggro(enemy) {
        if (calmMode) return;
        if (enemy.kind === 'child') return;
        enemy.state = 'hostile';
    }

    function spreadAggro(x) {
        if (calmMode) return;
        k.get('enemy').forEach((e) => {
            if (Math.abs(e.pos.x - x) < 360 && e.kind !== 'child') {
                e.state = 'hostile';
            }
        });
    }

    /** Every surviving non-child enemy turns hostile, regardless of distance. */
    function globalAggroAll() {
        if (calmMode) return;
        run.globalAggro = true;
        k.get('enemy').forEach((/** @type {any} */ e) => {
            if (e.kind !== 'child') e.state = 'hostile';
        });
    }

    // ----- Factories --------------------------------------------------------
    function spawnPoof(x, y) {
        k.add([
            k.sprite('poof'),
            k.pos(x, y),
            k.anchor('center'),
            k.opacity(1),
            k.lifespan(0.25),
        ]);
    }

    const enemyDefs = {
        dog:     { hp: 20, spd: 160, dmg: 6,  range: 20,  swingCd: 0.8,  spriteBase: 'dog',     h: 24, w: 32, killsKey: 'dog' },
        child:   { hp: 10, spd: 140, dmg: 0,  range: 0,   swingCd: null, spriteBase: 'child',   h: 34, w: 24, killsKey: 'child' },
        father:  { hp: 45, spd: 100, dmg: 15, range: 28,  swingCd: 1.2,  spriteBase: 'father',  h: 48, w: 32, killsKey: 'civilian' },
        mother:  { hp: 35, spd: 100, dmg: 12, range: 28,  swingCd: 1.4,  spriteBase: 'mother',  h: 48, w: 32, killsKey: 'civilian' },
        scout:   { hp: 35, spd: 110, dmg: 10, range: 28,  swingCd: 1.1,  spriteBase: 'scout',   h: 48, w: 32, killsKey: 'civilian' },
        cop:     { hp: 70, spd: 120, dmg: 20, range: 140, swingCd: null, spriteBase: 'cop',     h: 48, w: 32, killsKey: 'cop' },
        mallCop: { hp: 55, spd: 100, dmg: 14, range: 28,  swingCd: 1.3,  spriteBase: 'mallCop', h: 48, w: 32, killsKey: 'cop' },
        boss:    { hp: 140,spd: 110, dmg: 25, range: 32,  swingCd: 1.0,  spriteBase: 'boss',    h: 48, w: 32, killsKey: 'boss' },
        choir:   { hp: 30, spd: 90,  dmg: 10, range: 28,  swingCd: 1.5,  spriteBase: 'choir',   h: 48, w: 32, killsKey: 'choir' },
        // SWAT response unit — spawns in reply to a slain cop. Tougher, burst-
        // fires an SMG, always drops the SMG on death.
        swat:    { hp: 110,spd: 120, dmg: 16, range: 140, swingCd: null, spriteBase: 'swat',    h: 48, w: 32, killsKey: 'cop' },
        // Bank security — shoots on sight, thick vest, drops handgun ammo.
        securityGuard: { hp: 85, spd: 110, dmg: 18, range: 150, swingCd: null, spriteBase: 'mallCop', h: 48, w: 32, killsKey: 'cop' },
        // Gun shop owner — mini-boss with a shotgun.
        gunShopOwner:  { hp: 180, spd: 90, dmg: 30, range: 150, swingCd: null, spriteBase: 'boss',    h: 48, w: 32, killsKey: 'civilian' },
        // Armored patrons — tanky melee with high damage.
        gunShopPatron: { hp: 140, spd: 100, dmg: 22, range: 32, swingCd: 1.0,  spriteBase: 'swat',    h: 48, w: 32, killsKey: 'civilian' },
        // Towel woman — unarmed, melee claws, no loot.
        towelWoman:    { hp: 28, spd: 130, dmg: 9, range: 24,  swingCd: 0.9,  spriteBase: 'towelWoman', h: 48, w: 32, killsKey: 'towelWoman' },
        // Priest — the final boss. Much tankier, hits harder, moves faster.
        priest:  { hp: 320, spd: 120, dmg: 30, range: 34,  swingCd: 0.8,  spriteBase: 'boss',    h: 48, w: 32, killsKey: 'boss' },
    };

    const LOOT_TABLE = {
        dog:     [],
        child:   [['bat', 0.25]],
        father:  [['beer', 0.30]],
        mother:  [['beer', 0.25], ['syringe', 0.15]],
        scout:   [['bat', 0.20], ['beer', 0.15]],
        cop:     [['ammo', 0.65]],
        mallCop: [['ammo', 0.45], ['beer', 0.15]],
        boss:    [['ammo', 0.90], ['beer', 0.50]],
        choir:   [['beer', 0.20]],
        swat:    [['smg', 1.0], ['ammo', 0.40]],
        securityGuard: [['ammo', 0.85]],
        gunShopOwner:  [['shotgun', 1.0], ['ammo', 1.0]],
        gunShopPatron: [['smg', 0.7], ['ammo', 0.6]],
        towelWoman:    [],   // unarmed; drops nothing
        priest:        [['ammo', 0.9], ['syringe', 0.4]],
    };

    /** Civilian kinds — murdering any of these triggers global aggro. */
    const HUMAN_KINDS = new Set([
        'father', 'mother', 'scout', 'cop', 'mallCop', 'boss', 'choir', 'swat',
        'securityGuard', 'gunShopOwner', 'gunShopPatron', 'towelWoman', 'priest',
    ]);

    /** @param {string} kind @param {number} x @param {'peaceful'|'wander'|'hostile'} mode @param {string} [id] */
    function spawnEnemy(kind, x, mode, id) {
        if (id && run.killedEnemies.has(id)) return null;
        const def = /** @type {any} */ (enemyDefs)[kind];
        // Honour the persistent global aggro flag — any enemy spawned after a
        // human has been murdered starts hostile, even if we re-enter the
        // scene from the house interior.
        if (run.globalAggro && kind !== 'child' && mode !== 'hostile') mode = 'hostile';
        // Calm debug mode overrides everything: every NPC stays peaceful so the
        // player can walk around and inspect art without triggering fights.
        if (calmMode) mode = kind === 'child' ? 'wander' : 'peaceful';
        const e = k.add([
            k.sprite(def.spriteBase + 'Idle'),
            k.pos(x, WORLD.groundY - def.h),
            k.area({ collisionIgnore: ['player', 'enemy'] }),
            k.body(),
            k.health(def.hp),
            k.anchor('top'),
            'enemy',
            {
                kind,
                state: mode,
                damage: def.dmg,
                range: def.range,
                speed: def.spd,
                killsKey: def.killsKey,
                spriteBase: def.spriteBase,
                walkTick: 0,
                walkFrame: 0,
                facing: -1,
                lastSwing: 0,
                lastShot: 0,
                stunUntil: 0,  // set by taser dart
                swingCd: def.swingCd,
                wanderTarget: x + (Math.random() * 160 - 80),
                curSprite: def.spriteBase + 'Idle',
                // KAPLAY defines `get id()` on every GameObj (returns an
                // engine-internal numeric uuid), so we can't use `id` as a
                // custom property. `persistId` is our stable cross-scene key
                // that feeds run.killedEnemies / run.consumedPickups.
                persistId: id || null,
            },
        ]);

        // Floating health bar — only visible while the world is in insane mode.
        // Follows the enemy's head; cleans itself up when the enemy is gone.
        const barW = 36;
        const barH = 4;
        const barYOffset = 10;
        const hpBarBg = k.add([
            k.rect(barW, barH),
            k.pos(e.pos.x - barW / 2, e.pos.y - barYOffset),
            k.color(20, 20, 20),
            k.opacity(0),
            k.z(50),
        ]);
        const hpBarFill = k.add([
            k.rect(barW, barH),
            k.pos(e.pos.x - barW / 2, e.pos.y - barYOffset),
            k.color(211, 47, 47),
            k.opacity(0),
            k.z(51),
        ]);
        hpBarBg.onUpdate(() => {
            if (!e.exists()) {
                k.destroy(hpBarBg);
                k.destroy(hpBarFill);
                return;
            }
            const vis = isInsane() ? 1 : 0;
            hpBarBg.opacity = vis;
            hpBarFill.opacity = vis;
            const bx = e.pos.x - barW / 2;
            const by = e.pos.y - barYOffset;
            hpBarBg.pos.x = bx;
            hpBarBg.pos.y = by;
            hpBarFill.pos.x = bx;
            hpBarFill.pos.y = by;
            hpBarFill.width = barW * Math.max(0, e.hp() / def.hp);
        });

        e.onUpdate(() => {
            // Taser stun — frozen, zero input, visible yellow crackle. State
            // is preserved so the enemy resumes its attack when the stun ends.
            if (k.time() < e.stunUntil) {
                e.vel.x = 0;
                if (Math.floor(k.time() * 16) % 2 === 0) {
                    e.color = k.rgb(255, 240, 80);
                } else {
                    e.color = k.rgb(255, 255, 255);
                }
                return;
            }

            // Skip physics updates when offscreen to save perf
            const dist = Math.abs(e.pos.x - p.pos.x);
            if (dist > enemyActiveDistance) { e.vel.x = 0; return; }

            let vx = 0;
            if (e.state === 'hostile') {
                const dir = e.pos.x < p.pos.x ? 1 : -1;
                e.facing = dir;
                if (Math.abs(e.pos.x - p.pos.x) > e.range) vx = dir * e.speed;
            } else if (e.kind === 'child' && dist < 180) {
                const dir = e.pos.x < p.pos.x ? -1 : 1;
                e.facing = dir;
                vx = dir * e.speed;
            } else if (e.state === 'wander') {
                const dir = e.pos.x < e.wanderTarget ? 1 : -1;
                e.facing = dir;
                vx = dir * e.speed * 0.5;
                if (Math.abs(e.pos.x - e.wanderTarget) < 8) {
                    e.wanderTarget = e.pos.x + (Math.random() * 160 - 80);
                }
            }
            e.move(vx, 0);

            // Melee attack — short, sharp jab. 0.12 s window-up feels like
            // being decked, not shoved. Fist flies in, hit-check fires at
            // contact, then the fist is torn down.
            if (e.state === 'hostile' && e.swingCd && k.time() - e.lastSwing >= e.swingCd) {
                const atkDy = Math.abs(e.pos.y - p.pos.y);
                if (dist <= e.range && atkDy <= 48) {
                    e.lastSwing = k.time();
                    e.color = k.rgb(255, 160, 40);
                    const atkDir = e.pos.x < p.pos.x ? 1 : -1;
                    const SWING = 0.12;
                    const punch = k.add([
                        k.sprite('fist', { flipX: atkDir < 0 }),
                        k.pos(e.pos.x + atkDir * 16, e.pos.y + 24),
                        k.anchor('center'),
                        k.z(50),
                        { punchAge: 0, punchVx: ((p.pos.x - atkDir * 8) - (e.pos.x + atkDir * 16)) / SWING },
                    ]);
                    punch.onUpdate(() => {
                        punch.punchAge += k.dt();
                        punch.pos.x += punch.punchVx * k.dt();
                        if (punch.punchAge >= SWING) k.destroy(punch);
                    });
                    k.wait(SWING, () => {
                        if (!e.exists()) return;
                        e.color = k.rgb(255, 255, 255);
                        if (Math.abs(e.pos.x - p.pos.x) <= e.range + 8 && Math.abs(e.pos.y - p.pos.y) <= 48) {
                            hurtPlayer(e.damage, e);
                        }
                    });
                }
            }

            // Ranged attack — cops, SWAT, security guards, gun-shop owner.
            // Different cadence / burst sizes tune how terrifying each is.
            const isRanged = e.kind === 'cop' || e.kind === 'swat'
                || e.kind === 'securityGuard' || e.kind === 'gunShopOwner';
            if (isRanged && e.state === 'hostile' && dist < 440) {
                const fireCd = e.kind === 'swat' ? 1.8
                    : e.kind === 'securityGuard' ? 1.0
                    : e.kind === 'gunShopOwner' ? 1.3
                    : 1.2;
                if (k.time() - e.lastShot >= fireCd) {
                    e.lastShot = k.time();
                    const bDir = e.pos.x < p.pos.x ? 1 : -1;
                    // Shotgun owner fires a cone of 5 pellets; SWAT fires 3
                    // bullets in quick burst; guards and cops fire singles.
                    const burst = e.kind === 'swat' ? 3
                        : e.kind === 'gunShopOwner' ? 5
                        : 1;
                    const perBulletDmg = e.kind === 'swat' ? Math.floor(e.damage / 2)
                        : e.kind === 'gunShopOwner' ? Math.floor(e.damage / 3)
                        : e.damage;
                    // Shotgun cone fires all pellets at once with wide spread;
                    // SMG burst is staggered 0.08 s between rounds.
                    const staggered = e.kind !== 'gunShopOwner';
                    for (let i = 0; i < burst; i++) {
                        const delay = staggered ? i * 0.08 : 0;
                        const vySpread = e.kind === 'gunShopOwner'
                            ? (i - (burst - 1) / 2) * 90
                            : (Math.random() - 0.5) * 8;
                        k.wait(delay, () => {
                            if (!e.exists() || k.time() < e.stunUntil) return;
                            const b = k.add([
                                k.sprite('bullet', { flipX: bDir < 0 }),
                                k.pos(e.pos.x + bDir * 20, e.pos.y + 16 + (Math.random() - 0.5) * 4),
                                k.anchor('center'),
                                k.offscreen({ destroy: true, distance: 400 }),
                                k.area({ collisionIgnore: ['enemy'] }),
                                k.opacity(1),
                                k.lifespan(e.kind === 'gunShopOwner' ? 0.4 : 1.2),
                                'enemyBullet',
                                { damage: perBulletDmg, vx: bDir * WORLD.bulletSpeed * 0.85, vy: vySpread },
                            ]);
                            b.onUpdate(() => {
                                b.pos.x += b.vx * k.dt();
                                b.pos.y += (b.vy || 0) * k.dt();
                            });
                        });
                    }
                }
            }

            const moving = Math.abs(vx) > 10;
            let spriteName = moving
                ? e.spriteBase + (e.walkFrame === 0 ? 'Walk1' : 'Walk2')
                : e.spriteBase + 'Idle';
            if (moving) {
                e.walkTick += k.dt();
                if (e.walkTick > 0.18) { e.walkTick = 0; e.walkFrame = 1 - e.walkFrame; }
            }
            // Warped "insane" look whenever the player is drunk, high, or bleeding.
            // Aggression is handled separately via e.state — this only changes visuals.
            if (isInsane()) spriteName = e.spriteBase + 'Evil';
            if (!SPR[spriteName]) {
                spriteName = e.spriteBase + (SPR[e.spriteBase + 'Walk1'] ? 'Walk1' : 'Idle');
            }
            if (spriteName !== e.curSprite) {
                e.curSprite = spriteName;
                e.use(k.sprite(spriteName));
            }
            e.flipX = e.facing > 0;
        });

        e.onDeath(() => {
            if (e.persistId) run.killedEnemies.add(e.persistId);
            stats.kills[def.killsKey]++;
            spawnPoof(e.pos.x + 16, e.pos.y + def.h / 2);
            // Dramatic splatter on death — more droplets than a regular hit,
            // biased in the direction the killing blow came from.
            const deathDir = (p.pos.x < e.pos.x) ? 1 : -1;
            spawnBloodSplatter(e.pos.x + 16, e.pos.y + def.h / 2, deathDir, 2.2);
            let dropOff = 0;
            for (const [item, chance] of (/** @type {any} */ (LOOT_TABLE)[kind] || [])) {
                if (Math.random() < chance) {
                    spawnPickup(item, e.pos.x + dropOff, WORLD.groundY - 12);
                    dropOff += 28;
                }
            }
            // Murdering any human wakes up the entire town — permanently and
            // regardless of distance. Future-spawned enemies inherit hostility
            // via run.globalAggro (honoured in spawnEnemy above).
            if (HUMAN_KINDS.has(kind)) globalAggroAll();
            // Killing a cop summons a SWAT response unit from just off the
            // near edge of the screen; it drops an SMG when downed.
            if (!calmMode && kind === 'cop' && !run.killedEnemies.has('swat-response-' + (e.persistId || k.time()))) {
                const spawnDir = p.pos.x < e.pos.x ? 1 : -1;
                const swatX = p.pos.x + spawnDir * 400;
                k.wait(1.4, () => {
                    if (!p.exists()) return;
                    spawnEnemy('swat', swatX, 'hostile');
                });
            }
            k.destroy(e);
            spreadAggro(e.pos.x);
        });

        e.onHurt(() => {
            e.color = k.rgb(255, 80, 80);
            k.wait(0.08, () => { if (e.exists()) e.color = k.rgb(255, 255, 255); });
            // Small spray on every hit — positioned at torso, pushed away
            // from the player so the droplets arc naturally away from contact.
            const hitDir = (p.pos.x < e.pos.x) ? 1 : -1;
            spawnBloodSplatter(e.pos.x + 16, e.pos.y + def.h / 2, hitDir, 0.55);
        });

        return e;
    }

    // Pickup sprite + hint are both mode-sensitive: beer looks like an energy
    // drink and syringes look like medkits when the world is insane. The
    // mechanics don't change — the player is still drinking beer / jabbing
    // narcotics, they just don't see it that way.
    /** @param {string} kind */
    function pickupSpriteName(kind) {
        if (kind === 'beer')    return isInsane() ? 'beerInsane' : 'beer';
        if (kind === 'syringe') return isInsane() ? 'healthPack' : 'syringe';
        if (kind === 'ownHandgun') return 'handgun';
        return kind;
    }
    /** @param {string} kind */
    function pickupHintText(kind) {
        if (isInsane()) {
            if (kind === 'beer')    return '↓ GRAB ENERGY';
            if (kind === 'syringe') return '↓ GRAB HEALTH';
        }
        return (/** @type {Record<string, string>} */ ({
            beer: '↓ GRAB BEER',
            ammo: '↓ GRAB AMMO',
            cap: '↓ GRAB CAP',
            syringe: '↓ GRAB SYRINGE',
            bat: '↓ GRAB BAT',
            molotov: '↓ GRAB BOTTLE',
            shotgun: '↓ GRAB SHOTGUN',
            smg: '↓ GRAB SMG',
            taser: '↓ GRAB TASER',
            flamethrower: '↓ GRAB FLAMETHROWER',
            grenade: '↓ GRAB BATTERY',
            ownHandgun: '↓ GRAB YOUR GUN',
        }))[kind] || '↓ GRAB';
    }

    /** @param {string} kind @param {number} x @param {number} y @param {string} [id] */
    function spawnPickup(kind, x, y, id) {
        if (id && run.consumedPickups.has(id)) return null;
        const initialSprite = pickupSpriteName(kind);
        // Enemy drops (no id) decay after 10 s so corpses don't leave a
        // permanent trail of loot. Level-placed pickups (with ids) stay put.
        const ttl = id ? null : 10;
        const item = k.add([
            k.sprite(initialSprite),
            k.pos(x, y),
            k.area(),
            k.anchor('bot'),
            k.opacity(1),
            'pickup',
            // persistId (not id) because KAPLAY's `get id()` would shadow us.
            { kind, baseY: y, persistId: id || null, curPickupSprite: initialSprite, age: 0, ttl },
        ]);
        item.onUpdate(() => {
            item.pos.y = item.baseY + Math.sin(k.time() * 3 + x) * 3;
            const spr = pickupSpriteName(kind);
            if (spr !== item.curPickupSprite) {
                item.curPickupSprite = spr;
                item.use(k.sprite(spr));
            }
            if (item.ttl !== null) {
                item.age += k.dt();
                if (item.age >= item.ttl) { k.destroy(item); return; }
                const remaining = item.ttl - item.age;
                if (remaining < 2) {
                    const rate = remaining < 0.8 ? 24 : 12;
                    item.opacity = 0.35 + Math.abs(Math.sin(item.age * rate)) * 0.65;
                }
            }
        });
        const hint = k.add([
            k.text(pickupHintText(kind), { size: 18 }),
            k.pos(x, y - 40),
            k.anchor('center'),
            k.color(255, 240, 80),
            k.opacity(0),
            k.z(50),
        ]);
        hint.onUpdate(() => {
            if (!item.exists()) { k.destroy(hint); return; }
            const nextText = pickupHintText(kind);
            if (hint.text !== nextText) hint.text = nextText;
            const dx = Math.abs(item.pos.x - (p.pos.x + 16));
            hint.pos.y = item.pos.y - 40 + Math.sin(k.time() * 5) * 3;
            hint.opacity = dx < 44 ? 1 : 0;
        });
        return item;
    }

    function consumePickup(item) {
        switch (item.kind) {
            case 'beer':
                stats.drankBeer = true;
                stats.stoleItems++;
                player.maxHealth = 80;
                player.health = Math.min(player.health, 80);
                // Each beer extends (or refreshes) the drunk window by 30 s.
                player.intoxicatedUntil = Math.max(k.time(), player.intoxicatedUntil) + 30;
                break;
            case 'syringe':
                stats.tookDrugs = true;
                player.rageUntil = k.time() + 25;
                player.maxHealth = 120;
                player.health = 120;
                break;
            case 'cap':
                stats.stoleItems++;
                player.invulnUntil = k.time() + 10;
                break;
            case 'ammo':
                stats.stoleItems++;
                if (!player.weapons.includes('handgun')) player.weapons.push('handgun');
                player.ammo.handgun += 12;
                break;
            case 'ownHandgun':
                // BAM's own gun, fallen from the truck cab — not theft.
                // Bank guards still read this as "armed" on entry, though.
                if (!player.weapons.includes('handgun')) player.weapons.push('handgun');
                player.weaponIdx = player.weapons.indexOf('handgun');
                player.ammo.handgun = Math.max(player.ammo.handgun, 6);
                break;
            case 'bat':
                stats.stoleItems++;
                if (!player.weapons.includes('bat')) player.weapons.push('bat');
                break;
            case 'molotov':
                stats.stoleItems++;
                if (!player.weapons.includes('molotov')) player.weapons.push('molotov');
                player.ammo.molotov = (player.ammo.molotov || 0) + 1;
                break;
            case 'shotgun':
                stats.stoleItems++;
                if (!player.weapons.includes('shotgun')) player.weapons.push('shotgun');
                player.ammo.shotgun = (player.ammo.shotgun || 0) + 6;
                break;
            case 'smg':
                stats.stoleItems++;
                if (!player.weapons.includes('smg')) player.weapons.push('smg');
                player.ammo.smg = (player.ammo.smg || 0) + 30;
                break;
            case 'taser':
                stats.stoleItems++;
                if (!player.weapons.includes('taser')) player.weapons.push('taser');
                player.ammo.taser = (player.ammo.taser || 0) + 5;
                break;
            case 'flamethrower':
                stats.stoleItems++;
                if (!player.weapons.includes('flamethrower')) player.weapons.push('flamethrower');
                player.ammo.flamethrower = (player.ammo.flamethrower || 0) + 24;
                break;
            case 'grenade':
                stats.stoleItems++;
                if (!player.weapons.includes('grenade')) player.weapons.push('grenade');
                player.ammo.grenade = (player.ammo.grenade || 0) + 2;
                break;
        }
        if (item.persistId) run.consumedPickups.add(item.persistId);
        spawnPoof(item.pos.x, item.pos.y);
        k.destroy(item);
    }

    function nearestInteractable(maxDx, maxDy) {
        let best = null;
        let bestDist = Infinity;
        for (const item of k.get('pickup')) {
            const dx = Math.abs(item.pos.x - (p.pos.x + 16));
            const dy = Math.abs(item.pos.y - (p.pos.y + 32));
            if (dx < maxDx && dy < maxDy && dx < bestDist) {
                best = item;
                bestDist = dx;
            }
        }
        return best;
    }

    // ----- HUD (fixed overlay) ---------------------------------------------
    k.add([k.rect(120, 16), k.pos(12, 12), k.color(20, 20, 20), k.fixed(), k.z(100)]);
    const hpFill = k.add([k.rect(116, 12), k.pos(14, 14), k.color(211, 47, 47), k.fixed(), k.z(101)]);
    hpFill.onUpdate(() => {
        hpFill.width = 116 * Math.max(0, player.health / player.maxHealth);
        if (k.time() < player.invulnUntil && Math.floor(k.time() * 8) % 2 === 0) {
            hpFill.color = k.rgb(255, 255, 255);
        } else {
            hpFill.color = k.rgb(211, 47, 47);
        }
    });
    k.add([k.text('HP', { size: 20 }), k.pos(136, 14), k.fixed(), k.color(255, 255, 255), k.z(101)]);

    // Intoxication bar — tracks the drunk / high window. Label lies in insane
    // mode: the player thinks it's an "ENERGY" meter, the truth shows through
    // as "INTOX" when serene. Syringe high bumps the bar to full (purple tint).
    const INTOX_BAR_X = k.width() - 12 - 120;
    k.add([k.rect(120, 16), k.pos(INTOX_BAR_X, 12), k.color(20, 20, 20), k.fixed(), k.z(100)]);
    const intoxFill = k.add([k.rect(116, 12), k.pos(INTOX_BAR_X + 2, 14), k.color(230, 120, 20), k.fixed(), k.z(101)]);
    intoxFill.onUpdate(() => {
        intoxFill.width = 116 * intoxLevel();
        intoxFill.color = k.time() < player.rageUntil
            ? k.rgb(160, 60, 220)
            : k.rgb(230, 120, 20);
    });
    const intoxLabel = k.add([k.text('INTOX', { size: 20 }), k.pos(INTOX_BAR_X - 8, 14), k.anchor('topright'), k.fixed(), k.color(255, 255, 255), k.z(101)]);
    intoxLabel.onUpdate(() => {
        intoxLabel.text = isInsane() ? 'ENERGY' : 'INTOX';
    });

    // White flash on every transition between serene ↔ insane. Tracked here
    // (inside the shared context) so it also fires in the house interior.
    let lastInsane = isInsane();
    k.onUpdate(() => {
        const nowInsane = isInsane();
        if (nowInsane !== lastInsane) {
            lastInsane = nowInsane;
            const flash = k.add([
                k.rect(k.width(), k.height()),
                k.pos(0, 0),
                k.color(255, 255, 255),
                k.opacity(1),
                k.fixed(),
                k.z(200),
            ]);
            flash.onUpdate(() => {
                flash.opacity -= k.dt() * 4;
                if (flash.opacity <= 0) k.destroy(flash);
            });
        }
    });

    // Weapon row — one slot per owned weapon, yellow border on the active one,
    // ammo count in the bottom-right corner of each slot (blank for melee).
    // Rebuilt on inventory change; the per-frame selection/ammo updates live
    // on each slot's own onUpdate so we don't rebuild every frame.
    /** @type {Record<string, string>} */
    const weaponIconMap = {
        fists: 'fist',
        bat: 'bat',
        handgun: 'handgun',
        shotgun: 'shotgun',
        smg: 'smg',
        taser: 'taser',
        flamethrower: 'flamethrower',
        grenade: 'grenade',
        molotov: 'molotov',
    };
    const SLOT_SIZE = 44;
    const SLOT_GAP = 4;
    const SLOT_BASE_X = 12;
    const SLOT_BASE_Y = 210;
    /** @type {any[]} */
    let weaponHudEntities = [];

    function rebuildWeaponHud() {
        weaponHudEntities.forEach((e) => k.destroy(e));
        weaponHudEntities = [];
        player.weapons.forEach((wpn, i) => {
            const x = SLOT_BASE_X + i * (SLOT_SIZE + SLOT_GAP);
            const y = SLOT_BASE_Y;
            const border = k.add([
                k.rect(SLOT_SIZE, SLOT_SIZE),
                k.pos(x, y),
                k.color(60, 60, 60),
                k.opacity(1),
                k.fixed(),
                k.z(100),
            ]);
            border.onUpdate(() => {
                border.color = player.weaponIdx === i
                    ? k.rgb(240, 200, 80)
                    : k.rgb(60, 60, 60);
            });
            const inner = k.add([
                k.rect(SLOT_SIZE - 4, SLOT_SIZE - 4),
                k.pos(x + 2, y + 2),
                k.color(24, 24, 24),
                k.opacity(1),
                k.fixed(),
                k.z(101),
            ]);
            const icon = k.add([
                k.sprite(weaponIconMap[wpn]),
                k.pos(x + SLOT_SIZE / 2, y + SLOT_SIZE / 2),
                k.anchor('center'),
                k.opacity(1),
                k.fixed(),
                k.z(102),
            ]);
            const ammoLabel = k.add([
                k.text('', { size: 16 }),
                k.pos(x + SLOT_SIZE - 4, y + SLOT_SIZE - 2),
                k.anchor('botright'),
                k.color(255, 255, 255),
                k.fixed(),
                k.z(103),
            ]);
            ammoLabel.onUpdate(() => {
                const v = player.ammo[wpn];
                const empty = v === 0;
                ammoLabel.text = v != null && !empty ? String(v) : '';
                const o = empty ? 0.35 : 1;
                border.opacity = o;
                inner.opacity = o;
                icon.opacity = o;
            });
            weaponHudEntities.push(border, inner, icon, ammoLabel);
        });
    }
    rebuildWeaponHud();

    // Watch for inventory changes (picking up a bat / first molotov) and
    // rebuild. Signature-based so we only re-render when the list actually
    // changes, not every frame.
    let lastWeaponSig = player.weapons.join(',');
    k.onUpdate(() => {
        const sig = player.weapons.join(',');
        if (sig !== lastWeaponSig) {
            lastWeaponSig = sig;
            rebuildWeaponHud();
        }
    });

    // Active weapon name, just below the slot row.
    /** @type {Record<string, string>} */
    const weaponNameMap = {
        fists: 'FISTS',
        bat: 'BAT',
        handgun: 'HANDGUN',
        shotgun: 'SHOTGUN',
        smg: 'SMG',
        taser: 'TASER',
        flamethrower: 'FLAMETHROWER',
        grenade: 'GRENADE',
        molotov: 'MOLOTOV',
    };
    const weaponNameLabel = k.add([
        k.text('', { size: 18 }),
        k.pos(SLOT_BASE_X, SLOT_BASE_Y + SLOT_SIZE + 4),
        k.anchor('topleft'),
        k.color(240, 200, 80),
        k.fixed(),
        k.z(101),
    ]);
    weaponNameLabel.onUpdate(() => {
        const wpn = player.weapons[player.weaponIdx];
        weaponNameLabel.text = weaponNameMap[wpn] || wpn.toUpperCase();
    });

    const timer = k.add([k.text('0:00', { size: 20 }), k.pos(k.width() / 2, 14), k.anchor('top'), k.fixed(), k.color(255, 255, 255), k.z(101)]);
    timer.onUpdate(() => {
        const elapsed = k.time() - run.startTime;
        const m = Math.floor(elapsed / 60);
        const s = Math.floor(elapsed % 60);
        timer.text = `${m}:${String(s).padStart(2, '0')}`;
    });

    // Centered below the HP/INTOX bars so it doesn't collide with them.
    const usaFlash = k.add([k.text('', { size: 22 }), k.pos(k.width() / 2, 130), k.anchor('top'), k.fixed(), k.color(255, 255, 255), k.z(101)]);
    usaFlash.onUpdate(() => {
        if (k.time() < player.invulnUntil) {
            const blink = Math.floor(k.time() * 6) % 2;
            usaFlash.text = blink ? 'U-S-A !' : 'U-S-A ?';
            usaFlash.color = blink ? k.rgb(255, 60, 60) : k.rgb(60, 80, 220);
        } else {
            usaFlash.text = '';
        }
    });

    // ESC to bail
    k.onKeyPress('escape', () => k.go('splash'));

    // Calm-mode art toggle: press I to flip between serene and insane visuals.
    // We push intoxicatedUntil forward (or clear it) so the existing mode-swap
    // machinery runs — no separate code path.
    k.onKeyPress('i', () => {
        if (!calmMode) return;
        const nowInsane = isInsane();
        if (nowInsane) {
            player.intoxicatedUntil = 0;
            player.rageUntil = 0;
            player.health = player.maxHealth;
        } else {
            player.intoxicatedUntil = k.time() + 3600;
        }
    });

    // Calm-mode HUD hint so the tester knows the hotkey exists.
    if (calmMode) {
        k.add([
            k.text('CALM MODE — I: toggle insane — ESC: splash', { size: 10 }),
            k.pos(k.width() / 2, k.height() - 10),
            k.anchor('bot'),
            k.fixed(),
            k.color(255, 240, 80),
            k.z(105),
        ]);
    }

    return {
        p, player, stats,
        hurtPlayer, playerDeath,
        spawnPoof, spawnFire, spawnEnemy, spawnPickup,
        consumePickup, nearestInteractable,
    };
}

// ===========================================================================
// SPLASH
// ===========================================================================

function splashScene() {
    // Fresh run on every splash — anything the player did last time is gone.
    run = null;

    // Background
    k.add([k.rect(k.width(), k.height()), k.color(10, 15, 25), k.fixed(), k.z(-100)]);

    // Decorative stars / flag pattern behind title
    for (let i = 0; i < 40; i++) {
        const x = (i * 73) % k.width();
        const y = (i * 37) % 60;
        k.add([
            k.rect(1, 1),
            k.pos(x, y),
            k.color(255, 255, 255),
            k.opacity(0.4 + (i % 3) * 0.2),
            k.fixed(),
        ]);
    }

    // Flag bars at top
    k.add([k.rect(k.width(), 12), k.pos(0, 12), k.color(211, 47, 47), k.fixed()]);
    k.add([k.rect(k.width(), 12), k.pos(0, 36), k.color(255, 255, 255), k.fixed()]);
    k.add([k.rect(k.width(), 12), k.pos(0, 60), k.color(42, 79, 184), k.fixed()]);

    // Title block — centered above the two-column body.
    k.add([
        k.text('B.A.M.', { size: 40 }),
        k.pos(k.width() / 2, 92),
        k.anchor('center'),
        k.color(255, 255, 255),
    ]);
    k.add([
        k.text('BRAVE AMERICA MAN', { size: 12 }),
        k.pos(k.width() / 2, 118),
        k.anchor('center'),
        k.color(220, 220, 220),
    ]);

    // --- Left column: opening quote / middle: BAM --------------------------
    const lines = [
        'Your pickup truck',
        'broke down in a',
        'strange place.',
        'Something ain\'t',
        'right around here.',
        'Lock \'n\' load,',
        'soldier!',
    ];
    lines.forEach((ln, i) => {
        k.add([
            k.text(ln, { size: 10 }),
            k.pos(80, 142 + i * 12),
            k.anchor('topleft'),
            k.color(200, 200, 200),
        ]);
    });
    // BAM front and centre.
    k.add([k.sprite('playerIdle'), k.pos(k.width() / 2, 150), k.anchor('top')]);

    // --- Right column: controls --------------------------------------------
    const ctrlCenterX = 360;
    k.add([
        k.text('CONTROLS', { size: 14 }),
        k.pos(ctrlCenterX, 140),
        k.anchor('top'),
        k.color(230, 160, 40),
    ]);
    const controls = [
        ['← →', 'MOVE'],
        ['↑',   'JUMP'],
        ['↓',   'GRAB / INTERACT'],
        ['X',   'USE WEAPON'],
        ['Z',   'CYCLE WEAPON'],
    ];
    controls.forEach(([key, action], i) => {
        const y = 162 + i * 13;
        k.add([k.text(key,    { size: 10 }), k.pos(ctrlCenterX - 6,  y), k.anchor('topright'), k.color(240, 200, 80)]);
        k.add([k.text(action, { size: 10 }), k.pos(ctrlCenterX + 6,  y), k.anchor('topleft'),  k.color(200, 200, 200)]);
    });

    // Challenge banner — when the user arrived via a share link.
    const challenge = readChallenge();
    if (challenge) {
        const safeName = challenge.name.replace(/[^A-Za-z0-9 _\-\.!?']/g, '').slice(0, 16) || 'CHAMPION';
        const msg = challenge.ending === 'win'
            ? `${safeName} ran this in ${challenge.score} — beat that, soldier.`
            : `${safeName} scored ${challenge.score}. You soldier enough to top it?`;
        // Yellow strip across the stage
        k.add([k.rect(k.width(), 22), k.pos(0, 78), k.color(230, 160, 40), k.fixed(), k.z(10)]);
        k.add([
            k.text(msg, { size: 11, width: k.width() - 40, align: 'center' }),
            k.pos(k.width() / 2, 89),
            k.anchor('center'),
            k.color(20, 20, 20),
            k.z(11),
        ]);
    }

    // Blinking prompt
    const prompt = k.add([
        k.text('PRESS SPACE TO START    —    TAB FOR SCOREBOARD', { size: 11 }),
        k.pos(k.width() / 2, k.height() - 14),
        k.anchor('center'),
        k.color(255, 255, 255),
    ]);
    prompt.onUpdate(() => {
        prompt.opacity = 0.6 + 0.4 * Math.sin(k.time() * 4);
    });

    k.onKeyPress('space', () => k.go('game'));
    k.onKeyPress('enter', () => k.go('game'));
    k.onKeyPress('tab', () => k.go('scoreboard'));
    k.onClick(() => k.go('game'));
}

// ===========================================================================
// GAME
// ===========================================================================

/** @param {{ from?: string }} [opts] */
function gameScene(opts = {}) {
    // World physics — per-scene because KAPLAY resets it on scene change.
    k.setGravity(WORLD.gravity);

    // The `run` object is persistent across scene changes so the player can
    // duck into any building and come back out with their HP, ammo, kills, and
    // consumed pickups intact. But the game scene is also how we *restart*
    // after death or the ending — any entry that isn't a building↔game hop has
    // to start with a brand-new run, otherwise the restarted game inherits
    // `player.knockVx` / `player.stunUntil` from the killing blow (causing
    // the player to be shoved in that direction for the first frames), along
    // with 0 HP, used-up pickups, killed enemies, and a pre-broken door.
    const INTERIOR_ORIGINS = new Set([
        'house', 'bank', 'gunShop', 'poolMens', 'poolWomens', 'church',
    ]);
    if (!INTERIOR_ORIGINS.has(opts.from)) run = null;
    if (!run) run = createRun();
    if (run.startTime === null) {
        run.startTime = k.time();
        if (!calmMode) {
            run.player.intoxicatedUntil = k.time() + 20; // player starts drunk from the crash
        }
    }
    const player = run.player;
    const stats = run.stats;

    // In calm mode, give the player the full arsenal on first entry so every
    // weapon's art and projectiles can be tested without scavenging.
    if (calmMode && !run.calmLoadoutDone) {
        run.calmLoadoutDone = true;
        player.weapons = ['fists', 'bat', 'handgun', 'shotgun', 'smg', 'taser', 'flamethrower', 'grenade', 'molotov'];
        player.weaponIdx = 2;
        player.ammo = {
            fists: null, bat: null,
            handgun: 999, shotgun: 999, smg: 999, taser: 999,
            flamethrower: 999, grenade: 999, molotov: 999,
        };
    }

    // Where does the player drop in? Each interior exits back to one tile away
    // from the entrance trigger so the player doesn't immediately re-enter.
    // All values sit ~60 px left of the corresponding door so the player
    // doesn't immediately re-enter and can see the building they just exited.
    // The pool uses a single return point well clear of the entire 200-wide
    // sprite because both doors exit to the same outside spot.
    const SPAWN_RETURN_X = {
        house:      1860,
        bank:       3440,   // BANK_DOOR_X (3500) − 60
        poolMens:   4100,   // POOL_X − 100, clear of both doors
        poolWomens: 4100,
        gunShop:    4658,   // GUN_DOOR_X (4718) − 60
        church:     7840,   // CHURCH_DOOR_X (7900) − 60 (calm mode only)
    };
    const spawnX = SPAWN_RETURN_X[opts.from] ?? 120;
    player.facing = 1;

    // ----- Sky and scenery (fixed / parallax) -------------------------------
    // These entities are stored so updateWorldMode() can swap their colours /
    // sprites when the insane-mode condition changes.
    const skyBg = k.add([k.rect(k.width(), k.height()), k.color(142, 200, 238), k.fixed(), k.z(-100)]);
    // Sun (sprite is already 2× native; no extra k.scale needed)
    const sunEnt = k.add([k.sprite('sun'), k.pos(360, 30), k.fixed(), k.z(-90)]);
    // Distant mountains (single rect stylized)
    const mtn1 = k.add([k.rect(k.width(), 60), k.pos(0, 120), k.color(90, 110, 140), k.fixed(), k.z(-80)]);
    const mtn2 = k.add([k.rect(k.width(), 40), k.pos(0, 140), k.color(70, 90, 120), k.fixed(), k.z(-79)]);

    // Parallax clouds that scroll slowly with camera. Y positions sit in the
    // upper sky area of the viewport (camera top ≈ groundY−222 so clouds need
    // world-y in that range to be visible).
    /** @type {any[]} */
    const cloudEntities = [];
    const CLOUD_SKY_TOP = WORLD.groundY - 200;
    for (let i = 0; i < 8; i++) {
        const cloud = k.add([
            k.sprite('cloud'),
            k.pos(200 + i * 360, CLOUD_SKY_TOP + (i % 3) * 44),
            k.z(-70),
            { parallax: 0.3 },
        ]);
        cloud.onUpdate(() => {
            const cx = k.getCamPos().x;
            cloud.pos.x = 200 + i * 360 + cx * cloud.parallax;
        });
        cloudEntities.push(cloud);
    }

    // ----- Ground — segmented around holes ---------------------------------
    // Each run of ground between holes is its own static body + tile strip.
    // The gaps are where the player falls through; `fall-off-world` inside
    // buildPlayingContext handles death on contact with oblivion.
    // Calm mode fills the gaps so the art-tester can walk unobstructed.
    const activeHoles = calmMode ? [] : HOLES;
    const groundSegments = [];
    let segStart = -400;
    for (const [hx1, hx2] of activeHoles) {
        if (hx1 > segStart) groundSegments.push([segStart, hx1]);
        segStart = hx2;
    }
    if (segStart < WORLD.width + 400) groundSegments.push([segStart, WORLD.width + 400]);

    for (const [gx1, gx2] of groundSegments) {
        k.add([
            k.rect(gx2 - gx1, 160),
            k.pos(gx1, WORLD.groundY),
            k.color(110, 74, 40),
            k.area(),
            k.body({ isStatic: true }),
            'ground',
            k.z(-20),
        ]);
        for (let x = gx1; x < gx2; x += 32) {
            const inRoad = (x > 120 && x < 520) || (x > 3400 && x < 4000);
            k.add([
                k.sprite(inRoad ? 'road' : 'ground'),
                k.pos(x, WORLD.groundY),
                k.z(-19),
            ]);
        }
    }

    // Painted pit graphic inside each hole so players can see where not to step.
    for (const [hx1, hx2] of activeHoles) {
        const w = hx2 - hx1;
        k.add([
            k.sprite('hole'),
            k.pos(hx1, WORLD.groundY - 2),
            k.z(-18),
            k.scale(w / 96, 1),   // hole sprite is 96px wide (48 native × 2)
        ]);
    }

    // Trees + bushes — spread across the longer level.
    for (const [x, y] of [[80, 380], [2500, 380], [4500, 380], [6600, 380], [7900, 380]]) {
        k.add([k.sprite('tree'), k.pos(x, y), k.anchor('bot'), k.z(-10)]);
    }
    for (const x of [360, 680, 1440, 2840, 3240, 4000, 4360, 5400, 6400, 7000, 7400]) {
        k.add([k.sprite('bush'), k.pos(x, WORLD.groundY + 4), k.anchor('bot'), k.z(-5)]);
    }

    // Broken pickup truck (spawn area context)
    k.add([k.sprite('truck'), k.pos(20, WORLD.groundY + 4), k.anchor('bot'), k.z(-6)]);

    // ----- Obstacles (spiked fences + thorny brambles) ----------------------
    // Both sit in the plane of the ground and hurt the player on contact.
    // Jumping cleanly over them is the intended way past.
    /**
     * @param {number} x world x of the obstacle's left edge
     * @param {'fence' | 'bramble'} kind
     * @param {number} dmg per-tick damage when the player is touching it
     */
    function spawnObstacle(x, kind, dmg) {
        const isFence = kind === 'fence';
        // Sprite native dims × 2 upscale: fence 24×30 → 48×60; bramble 30×26 → 60×52.
        const w = isFence ? 48 : 60;
        const h = isFence ? 60 : 52;
        const sereneSpr = isFence ? 'fence' : 'bramble';
        const insaneSpr = isFence ? 'fenceInsane' : 'brambleInsane';
        const o = k.add([
            k.sprite(isInsane() ? insaneSpr : sereneSpr),
            k.pos(x, WORLD.groundY + 4),
            k.anchor('bot'),
            k.z(-3),
            'obstacle',
            { kind, dmg, obstX: x, obstW: w, obstH: h, curSpr: isInsane() ? insaneSpr : sereneSpr },
        ]);
        o.onUpdate(() => {
            const want = isInsane() ? insaneSpr : sereneSpr;
            if (want !== o.curSpr) {
                o.curSpr = want;
                o.use(k.sprite(want));
            }
        });
    }

    // Dmg=0 in calm mode so the art is still on-screen but can't hurt the tester.
    const fenceDmg   = calmMode ? 0 : 14;
    const brambleDmg = calmMode ? 0 : 10;
    spawnObstacle(1580, 'fence',   fenceDmg);
    spawnObstacle(3250, 'bramble', brambleDmg);
    spawnObstacle(4460, 'bramble', brambleDmg);
    spawnObstacle(6680, 'fence',   fenceDmg);
    spawnObstacle(7220, 'bramble', brambleDmg);

    // ----- House (midlevel) -------------------------------------------------
    // House sprite (64×48) is anchored bottom-center at (900, groundY+2).
    // The painted door inside that sprite occupies local pixels x=27–37,
    // y=28–46 — i.e. world coords x=895–905, y=204–222. We place the
    // collision rect there so the invisible hitbox lines up with the paint.
    const house = k.add([
        k.sprite('house'),
        k.pos(1800, WORLD.groundY + 4),
        k.anchor('bot'),
        k.z(-4),
        { broken: false },
    ]);
    const DOOR_X = 1790;
    const DOOR_Y = 408;
    const DOOR_W = 20;
    const DOOR_H = 36;
    const DOOR_CENTER_X = DOOR_X + DOOR_W / 2;  // 1800
    // If the run has already broken the door (we came back from the interior),
    // start in the broken state and skip the door collider entirely.
    if (run.doorBroken) {
        house.broken = true;
        // Correct sprite chosen in updateWorldMode() after scene setup completes.
        house.use(k.sprite('houseBroken'));
    }

    /** @type {any} */
    let door = null;
    if (!run.doorBroken) {
        door = k.add([
            k.rect(DOOR_W, DOOR_H),
            k.pos(DOOR_X, DOOR_Y),
            k.opacity(0),                // invisible — painted door is the visual
            // Non-solid: the player can freely walk in front of it. Only bullets
            // and melee hits count toward breaking the door.
            k.area(),
            k.health(30),
            'door',
        ]);
        door.onHurt(() => {
            spawnPoof(DOOR_CENTER_X, DOOR_Y + DOOR_H / 2);
        });
        door.onDeath(() => {
            stats.brokeDoor = true;
            run.doorBroken = true;
            house.broken = true;
            // Respect whichever world mode is currently active.
            if (isInsane()) {
                house.use(k.sprite('houseBroken'));
                house.color = k.rgb(80, 40, 40);
            } else {
                house.use(k.sprite('houseBroken'));
            }
            k.destroy(door);
            door = null;
            spawnPoof(DOOR_CENTER_X, DOOR_Y + DOOR_H / 2);
        });
    }

    // Contextual hint above the door:
    //   - intact: "X BREAK"  (tells the player how to get inside)
    //   - broken: "↓ ENTER"    (prompt to step into the house)
    const doorHint = k.add([
        k.text('X BREAK', { size: 20 }),
        k.pos(DOOR_CENTER_X, DOOR_Y - 20),
        k.anchor('center'),
        k.color(255, 240, 80),
        k.opacity(0),
        k.z(50),
    ]);
    doorHint.onUpdate(() => {
        const dx = Math.abs(DOOR_CENTER_X - (p.pos.x + 16));
        if (dx >= 80) { doorHint.opacity = 0; return; }
        const label = house.broken ? '↓ ENTER' : 'X BREAK';
        if (doorHint.text !== label) doorHint.text = label;
        doorHint.opacity = 1;
    });

    // ----- Bank (mid-level) -------------------------------------------------
    // All building sprites use anchor('bot') which is bottom-CENTER in kaplay,
    // so `pos.x` is the horizontal centre of the sprite. Door coords below are
    // derived from the painted-pixel positions in sprites.js and kept here so
    // the invisible trigger, door hint, and ↓-key picker all align with the art.
    const BANK_X = 3500;
    const BANK_DOOR_X = BANK_X;   // door sits at sprite centre (paintBank.x=40)
    const bank = k.add([
        k.sprite('bank'),
        k.pos(BANK_X, WORLD.groundY + 4),
        k.anchor('bot'),
        k.z(-4),
    ]);
    k.add([
        k.rect(40, 88),
        k.pos(BANK_DOOR_X - 20, WORLD.groundY - 88),
        k.opacity(0),
        k.area(),
        'bankEntrance',
    ]);
    const bankHint = k.add([
        k.text('↓ ENTER BANK', { size: 18 }),
        k.pos(BANK_DOOR_X, WORLD.groundY - 130),
        k.anchor('center'),
        k.color(255, 240, 80),
        k.opacity(0),
        k.z(50),
    ]);
    bankHint.onUpdate(() => {
        const dx = Math.abs(BANK_DOOR_X - (p.pos.x + 16));
        bankHint.opacity = dx < 60 ? 1 : 0;
        // In insane mode the bank reads as a demonic keep — the sign breaks
        // character. Switch to a hellscape-appropriate label.
        bankHint.text = isInsane() ? '↓ ENTER KEEP' : '↓ ENTER BANK';
    });

    // ----- Pool (two-door building) ----------------------------------------
    // Pool sprite is 200 wide (2× 100). In paintPool, door-frames sit at native
    // x=18 (men's) and x=60 (women's), each 22 wide so centres are at 29 / 71.
    // Sprite centre is at native 50; offsets are (29-50)*2 = -42 and +42.
    const POOL_X = 4200;
    const POOL_MENS_X = POOL_X - 42;
    const POOL_WOMENS_X = POOL_X + 42;
    const pool = k.add([
        k.sprite('pool'),
        k.pos(POOL_X, WORLD.groundY + 4),
        k.anchor('bot'),
        k.z(-4),
    ]);
    k.add([
        k.rect(40, 88),
        k.pos(POOL_MENS_X - 20, WORLD.groundY - 88),
        k.opacity(0),
        k.area(),
        'poolMensEntrance',
    ]);
    k.add([
        k.rect(40, 88),
        k.pos(POOL_WOMENS_X - 20, WORLD.groundY - 88),
        k.opacity(0),
        k.area(),
        'poolWomensEntrance',
    ]);
    // Small labels over each door (warped & both read "?" in insane mode).
    const poolMLabel = k.add([
        k.text('MEN', { size: 14 }),
        k.pos(POOL_MENS_X, WORLD.groundY - 98),
        k.anchor('center'),
        k.color(255, 255, 255),
        k.z(50),
    ]);
    const poolWLabel = k.add([
        k.text('LADIES', { size: 14 }),
        k.pos(POOL_WOMENS_X, WORLD.groundY - 98),
        k.anchor('center'),
        k.color(255, 255, 255),
        k.z(50),
    ]);
    const poolHint = k.add([
        k.text('↓ ENTER', { size: 16 }),
        k.pos(POOL_MENS_X, WORLD.groundY - 130),
        k.anchor('center'),
        k.color(255, 240, 80),
        k.opacity(0),
        k.z(50),
    ]);
    poolHint.onUpdate(() => {
        const px = p.pos.x + 16;
        const mDx = Math.abs(POOL_MENS_X - px);
        const wDx = Math.abs(POOL_WOMENS_X - px);
        const closest = Math.min(mDx, wDx);
        poolHint.opacity = closest < 50 ? 1 : 0;
        poolHint.pos.x = mDx < wDx ? POOL_MENS_X : POOL_WOMENS_X;
        poolHint.pos.y = WORLD.groundY - 130;
    });

    // ----- Gun Shop --------------------------------------------------------
    // Sprite native 72, scaled 144. Door in paintGunShop at native 38–52
    // (centre 45); sprite centre is native 36, so offset = (45-36)*2 = +18.
    const GUN_X = 4700;
    const GUN_DOOR_X = GUN_X + 18;
    const gunShop = k.add([
        k.sprite('gunShop'),
        k.pos(GUN_X, WORLD.groundY + 4),
        k.anchor('bot'),
        k.z(-4),
    ]);
    k.add([
        k.rect(40, 88),
        k.pos(GUN_DOOR_X - 20, WORLD.groundY - 88),
        k.opacity(0),
        k.area(),
        'gunShopEntrance',
    ]);
    const gunHint = k.add([
        k.text('↓ ENTER GUN SHOP', { size: 16 }),
        k.pos(GUN_DOOR_X, WORLD.groundY - 130),
        k.anchor('center'),
        k.color(255, 240, 80),
        k.opacity(0),
        k.z(50),
    ]);
    gunHint.onUpdate(() => {
        const dx = Math.abs(GUN_DOOR_X - (p.pos.x + 16));
        gunHint.opacity = dx < 60 ? 1 : 0;
        gunHint.text = isInsane() ? '↓ ENTER ARMORY' : '↓ ENTER GUN SHOP';
    });

    // ----- Church (end of level) --------------------------------------------
    // Sprite native 88, door at native 40–48 (centre 44); sprite centre is
    // native 44 so offset 0 — the doors sit exactly at CHURCH_X.
    const CHURCH_X = 7900;
    const CHURCH_DOOR_X = CHURCH_X;
    const church = k.add([
        k.sprite('church'),
        k.pos(CHURCH_X, WORLD.groundY + 4),
        k.anchor('bot'),
        k.z(-4),
    ]);

    // End trigger — walking into the church enters the boss fight interior.
    k.add([
        k.rect(40, 96),
        k.pos(CHURCH_DOOR_X - 20, WORLD.groundY - 92),
        k.opacity(0),
        k.area(),
        'end',
    ]);
    const churchHint = k.add([
        k.text('↓ ENTER CHURCH', { size: 18 }),
        k.pos(CHURCH_DOOR_X, WORLD.groundY - 160),
        k.anchor('center'),
        k.color(255, 240, 80),
        k.opacity(0),
        k.z(50),
    ]);
    churchHint.onUpdate(() => {
        const dx = Math.abs(CHURCH_DOOR_X - (p.pos.x + 16));
        churchHint.opacity = dx < 90 ? 1 : 0;
        churchHint.text = isInsane() ? '↓ ENTER CATHEDRAL' : '↓ ENTER CHURCH';
    });

    // ----- Player, input, HUD, factories -----------------------------------
    // Everything the player-control layer needs lives in the shared context.
    // `p` is the player entity; the four helpers spawn/interact with level
    // content in a way that respects cross-scene persistence (`run.*`).
    const { p, spawnFire, spawnEnemy, spawnPickup, spawnPoof, consumePickup, nearestInteractable, hurtPlayer } =
        buildPlayingContext({ spawnX, minX: 0, maxX: WORLD.width - 32,
            invincible: calmMode,
            spawnFireAt: (x) => spawnFire(x, WORLD.groundY) });

    // Camera follow — horizontal chase; fixed y that keeps groundY near the
    // bottom of the 288-tall viewport (ground would be off-screen at the
    // default camY=144 now that groundY has doubled to 444).
    p.onUpdate(() => {
        const camX = Math.max(k.width() / 2, Math.min(WORLD.width - k.width() / 2, p.pos.x));
        k.setCamPos(camX, WORLD.groundY - 52);
    });

    // ----- Pickups ----------------------------------------------------------
    // BAM's own handgun fell out of the wrecked truck and is on the ground
    // next to him — picking it up is not theft. Everything else on the map
    // is theft (or worse). Stable IDs let consumed pickups stay gone when
    // we re-enter the scene from the house interior.
    spawnPickup('ownHandgun',     80, WORLD.groundY - 6,  'ownHandgun-start');
    spawnPickup('beer',          440, WORLD.groundY - 12, 'beer-road');
    spawnPickup('shotgun',       760, WORLD.groundY - 12, 'shotgun-380');
    spawnPickup('ammo',          960, WORLD.groundY - 10, 'ammo-480');
    spawnPickup('bat',          1240, WORLD.groundY - 8,  'bat-620');
    spawnPickup('taser',        1640, WORLD.groundY - 12, 'taser-820');
    spawnPickup('ammo',         2240, WORLD.groundY - 10, 'ammo-1120');
    spawnPickup('grenade',      2500, WORLD.groundY - 12, 'grenade-1250');
    spawnPickup('cap',          3100, WORLD.groundY - 6,  'cap-1550');
    spawnPickup('flamethrower', 3800, WORLD.groundY - 12, 'flamethrower-1800');
    spawnPickup('ammo',         4000, WORLD.groundY - 10, 'ammo-2000');
    // Middle stretch — more support for the harder back half of the level.
    spawnPickup('ammo',         5400, WORLD.groundY - 10, 'ammo-2700');
    spawnPickup('beer',         6400, WORLD.groundY - 12, 'beer-3200');
    spawnPickup('ammo',         6800, WORLD.groundY - 10, 'ammo-3400');
    spawnPickup('grenade',      7100, WORLD.groundY - 12, 'grenade-3550');
    spawnPickup('cap',          7700, WORLD.groundY - 6,  'cap-3850');

    // ----- Enemies (peaceful by default; IDs persist kills across scenes) ---
    // Every outdoor NPC is peaceful until BAM provokes them. The whole
    // game is built on "BAM is the aggressor" — nobody lays a hand on him
    // unless he shoots, stabs, steals, or murders first. A single kill of
    // any human trips run.globalAggro, and THEN every cop/mallCop on the
    // map wakes up with weapons drawn.
    spawnEnemy('dog',     840, 'wander',   'dog-420');
    spawnEnemy('child',  1400, 'wander',   'child-700');
    spawnEnemy('dog',    1500, 'wander',   'dog-750');
    spawnEnemy('father', 2400, 'peaceful', 'father-out');
    spawnEnemy('child',  2560, 'wander',   'child-1280');
    spawnEnemy('mother', 2760, 'peaceful', 'mother-1380');
    spawnEnemy('dog',    2900, 'wander',   'dog-1450');
    spawnEnemy('dog',    3000, 'wander',   'dog-1500');
    spawnEnemy('scout',  3400, 'peaceful', 'scout-1700');
    spawnEnemy('cop',    3720, 'peaceful', 'cop-out-1');
    spawnEnemy('mallCop',4100, 'peaceful', 'mallCop-pool');
    spawnEnemy('dog',    5400, 'wander',   'dog-2700');
    spawnEnemy('cop',    5200, 'peaceful', 'cop-out-2');
    spawnEnemy('mallCop',5600, 'peaceful', 'mallCop-out-2');
    spawnEnemy('scout',  5800, 'peaceful', 'scout-hostile-1');
    spawnEnemy('cop',    6200, 'peaceful', 'cop-out-3');
    spawnEnemy('dog',    6500, 'wander',   'dog-3250');
    spawnEnemy('cop',    7000, 'peaceful', 'cop-out-4');
    spawnEnemy('scout',  7400, 'peaceful', 'scout-hostile-2');
    spawnEnemy('dog',    7600, 'wander',   'dog-3800');

    // ----- Scene-specific interactions --------------------------------------
    // Down: grab a pickup if one is under foot, otherwise step into whatever
    // building the player is standing in front of. We pick the best candidate
    // by distance so overlapping trigger rects don't fight each other.
    k.onKeyPress(['down', 's'], () => {
        const item = nearestInteractable(44, 72);
        if (item) { consumePickup(item); return; }
        // Building doors, in priority order by proximity.
        const px = p.pos.x + 16;
        const doors = [
            ['house',      DOOR_CENTER_X,  house.broken],
            ['bank',       BANK_DOOR_X,    true],
            ['poolMens',   POOL_MENS_X,    true],
            ['poolWomens', POOL_WOMENS_X,  true],
            ['gunShop',    GUN_DOOR_X,     true],
            ['church',     CHURCH_DOOR_X,  true],
        ];
        let best = null, bestDx = 50;
        for (const [name, x, enabled] of doors) {
            if (!enabled) continue;
            const dx = Math.abs(x - px);
            if (dx < bestDx) { best = name; bestDx = dx; }
        }
        if (best === 'house') k.go('house');
        else if (best === 'bank') k.go('bank');
        else if (best === 'poolMens') k.go('poolMens');
        else if (best === 'poolWomens') k.go('poolWomens');
        else if (best === 'gunShop') k.go('gunShop');
        else if (best === 'church') enterChurch();
    });

    // Walking into the church trigger also enters (no need to press down).
    function enterChurch() {
        k.go('churchInterior');
    }

    // Door is damaged by melee swings and bullets (the house block removes
    // the collider + swaps to the broken sprite inside door.onDeath).
    k.onCollide('playerMelee', 'door', (m, d) => { d.hurt(m.damage); });
    k.onCollide('bullet',      'door', (b, d) => { d.hurt(b.damage); k.destroy(b); });

    // Reaching the church triggers the boss fight inside.
    p.onCollide('end', () => enterChurch());

    // ----- Obstacle contact: damage on overlap while player stands on it ---
    // We apply damage every 0.3 s while the player overlaps, so just brushing
    // against a fence isn't instant death — but standing in it is punishing.
    let lastObstacleTick = 0;
    p.onUpdate(() => {
        if (k.time() - lastObstacleTick < 0.3) return;
        for (const o of k.get('obstacle')) {
            const px = p.pos.x + 16;
            const py = p.pos.y + 24;
            const oLeft = o.obstX;
            const oRight = o.obstX + o.obstW;
            const oTop = WORLD.groundY + 4 - o.obstH;
            if (px > oLeft && px < oRight && py > oTop) {
                hurtPlayer(o.dmg, { pos: { x: o.pos.x + o.obstW / 2, y: WORLD.groundY - 20 } });
                lastObstacleTick = k.time();
                break;
            }
        }
    });

    // ----- World mode (serene ↔ insane) -------------------------------------
    // Swap sky colour, clouds, sun, house and church sprites whenever the
    // insane condition changes. The white flash is handled inside
    // buildPlayingContext so it also fires in the house interior.
    /** @param {boolean} insane */
    function updateWorldMode(insane) {
        if (!skyBg.exists()) return;
        if (insane) {
            skyBg.color = k.rgb(80, 10, 10);
            if (sunEnt.exists()) sunEnt.opacity = 0;
            mtn1.color = k.rgb(50, 15, 15);
            mtn2.color = k.rgb(40, 10, 10);
            for (const c of cloudEntities) { if (c.exists()) c.use(k.sprite('cloudStorm')); }
            if (house.exists()) {
                house.use(k.sprite(house.broken ? 'houseBroken' : 'houseInsane'));
                if (house.broken) house.color = k.rgb(80, 40, 40);
            }
            if (church.exists()) church.use(k.sprite('churchInsane'));
            if (bank.exists()) bank.use(k.sprite('bankInsane'));
            if (gunShop.exists()) gunShop.use(k.sprite('gunShopInsane'));
            if (pool.exists()) pool.use(k.sprite('poolInsane'));
            // Pool-door signs warp into identical red blobs — the player can
            // no longer tell which door leads where.
            poolMLabel.text = '???';
            poolWLabel.text = '???';
            poolMLabel.color = k.rgb(255, 80, 80);
            poolWLabel.color = k.rgb(255, 80, 80);
        } else {
            skyBg.color = k.rgb(142, 200, 238);
            if (sunEnt.exists()) sunEnt.opacity = 1;
            mtn1.color = k.rgb(90, 110, 140);
            mtn2.color = k.rgb(70, 90, 120);
            for (const c of cloudEntities) { if (c.exists()) c.use(k.sprite('cloud')); }
            if (house.exists()) {
                house.use(k.sprite(house.broken ? 'houseBroken' : 'house'));
                house.color = k.rgb(255, 255, 255);
            }
            if (church.exists()) church.use(k.sprite('church'));
            if (bank.exists()) bank.use(k.sprite('bank'));
            if (gunShop.exists()) gunShop.use(k.sprite('gunShop'));
            if (pool.exists()) pool.use(k.sprite('pool'));
            poolMLabel.text = 'MEN';
            poolWLabel.text = 'LADIES';
            poolMLabel.color = k.rgb(255, 255, 255);
            poolWLabel.color = k.rgb(255, 255, 255);
        }
    }

    // Apply immediately on scene load so the first frame shows the right mode.
    let worldIsInsane = isInsane();
    updateWorldMode(worldIsInsane);

    k.onUpdate(() => {
        const nowInsane = isInsane();
        if (nowInsane !== worldIsInsane) {
            worldIsInsane = nowInsane;
            updateWorldMode(nowInsane);
        }
    });
}

// ===========================================================================
// HOUSE (interior) — broken-in living room with the family + a syringe
// ===========================================================================

function houseScene() {
    k.setGravity(WORLD.gravity);
    // run is guaranteed non-null here: house is only reachable from game.

    const { exitX, exitHint } = buildInteriorShell({
        bgRgb: [56, 34, 22],
        bgRgbInsane: [24, 8, 8],
    });

    // Decor: cabinet on the right (next to the syringe), table center-left.
    k.add([k.sprite('cabinet'), k.pos(k.width() - 60, WORLD.groundY + 4), k.anchor('bot'), k.z(-10)]);
    k.add([k.sprite('table'),   k.pos(k.width() / 2 + 20, WORLD.groundY + 4), k.anchor('bot'), k.z(-10)]);

    // Shared player context — spawn well clear of the door so the prompt
    // doesn't pop up immediately on entry.
    const { p, spawnEnemy, spawnPickup, consumePickup, nearestInteractable } =
        buildPlayingContext({ spawnX: 140, minX: 40, maxX: k.width() - 40, invincible: calmMode });

    // Fixed interior camera — the room fits on one screen.
    k.setCamPos(k.width() / 2, WORLD.groundY - 52);

    // Proximity-based exit hint, wired now that `p` exists.
    exitHint.onUpdate(() => {
        const dx = Math.abs(exitX - (p.pos.x + 16));
        exitHint.opacity = dx < 40 ? 1 : 0;
    });

    // Inhabitants + the syringe next to the cabinet. Enemies spaced deep
    // in the room so the first hit doesn't knock BAM through the exit.
    spawnEnemy('father',  300, 'hostile', 'father-house');
    spawnEnemy('mother',  400, 'hostile', 'mother-house');
    spawnPickup('syringe', k.width() - 80, WORLD.groundY - 8, 'syringe-house');

    // Down: grab a pickup under foot, otherwise leave through the door.
    k.onKeyPress(['down', 's'], () => {
        const item = nearestInteractable(44, 72);
        if (item) { consumePickup(item); return; }
        const dx = Math.abs(exitX - (p.pos.x + 16));
        if (dx < 40) k.go('game', { from: 'house' });
    });
}

// ===========================================================================
// Shared interior builder — walls, floor, ground collider, exit trigger.
// The building-specific scenes below only have to describe their furniture
// and inhabitants; everything else (player, HUD, collision, exit) is wired
// in here so they stay short.
// ===========================================================================

/**
 * @param {object} opts
 * @param {[number, number, number]} opts.bgRgb  backdrop colour
 * @param {string} [opts.floorSprite='floorInt']
 * @param {string} [opts.wallSprite='wallInt']
 * @param {string} [opts.labelText]  optional large label printed above the room
 * @param {[number, number, number]} [opts.labelColor]
 */
function buildInteriorShell(opts) {
    const {
        bgRgb,
        bgRgbInsane = [30, 8, 8],     // blood-red default; interior scenes can override
        floorSprite = 'floorInt',
        wallSprite  = 'wallInt',
        floorSpriteInsane = 'floorIntInsane',
        wallSpriteInsane  = 'wallIntInsane',
        labelText,
        labelColor        = [180, 180, 180],
        labelTextInsane,
        labelColorInsane  = [220, 80, 80],
    } = opts;

    // Track all mode-reactive entities so we can flip their look when the
    // player's intoxication flickers on or off inside the room.
    const backdrop = k.add([k.rect(k.width(), k.height()), k.color(...bgRgb), k.fixed(), k.z(-100)]);
    const walls = [];
    for (let x = 0; x < k.width(); x += 32) {
        for (let y = WORLD.groundY - 224; y < WORLD.groundY; y += 32) {
            walls.push(k.add([k.sprite(wallSprite), k.pos(x, y), k.z(-50), { curSpr: wallSprite }]));
        }
    }
    const floors = [];
    for (let x = 0; x < k.width(); x += 32) {
        floors.push(k.add([k.sprite(floorSprite), k.pos(x, WORLD.groundY), k.z(-19), { curSpr: floorSprite }]));
    }

    k.add([
        k.rect(k.width() + 80, 160),
        k.pos(-40, WORLD.groundY),
        k.color(...bgRgb),
        k.opacity(0),
        k.area(),
        k.body({ isStatic: true }),
        'ground',
        k.z(-20),
    ]);

    // Exit door on the left wall — press ↓/s to use, so walking past it
    // can't kick the player out by accident. Scene code attaches a proximity
    // check to the returned hint and reads exitX to gate its own ↓ handler.
    const EXIT_X = 60;
    k.add([k.sprite('exitDoor'), k.pos(EXIT_X, WORLD.groundY + 4), k.anchor('bot'), k.z(-4)]);
    const exitHint = k.add([
        k.text('↓ EXIT', { size: 20 }),
        k.pos(EXIT_X, WORLD.groundY - 108),
        k.anchor('center'),
        k.color(255, 240, 80),
        k.opacity(0),
        k.z(50),
    ]);
    exitHint.onUpdate(() => {
        exitHint.pos.y = WORLD.groundY - 108 + Math.sin(k.time() * 5) * 3;
    });

    let label = null;
    if (labelText) {
        label = k.add([
            k.text(labelText, { size: 14 }),
            k.pos(k.width() / 2, WORLD.groundY - 210),
            k.anchor('center'),
            k.color(...labelColor),
            k.z(50),
        ]);
    }

    // Insane-mode swap: dark masonry walls, scorched flagstones, red tint.
    // Applied immediately so entering the room in insane state is correct on
    // the first frame, and re-applied whenever the flag flips during play.
    function applyMode(insane) {
        const bg = insane ? bgRgbInsane : bgRgb;
        backdrop.color = k.rgb(...bg);
        const wS = insane ? wallSpriteInsane : wallSprite;
        for (const w of walls) {
            if (w.curSpr !== wS) { w.curSpr = wS; w.use(k.sprite(wS)); }
        }
        const fS = insane ? floorSpriteInsane : floorSprite;
        for (const f of floors) {
            if (f.curSpr !== fS) { f.curSpr = fS; f.use(k.sprite(fS)); }
        }
        if (label) {
            label.text = insane ? (labelTextInsane ?? labelText) : labelText;
            label.color = k.rgb(...(insane ? labelColorInsane : labelColor));
        }
    }
    let lastInsane = isInsane();
    applyMode(lastInsane);
    k.onUpdate(() => {
        const now = isInsane();
        if (now !== lastInsane) {
            lastInsane = now;
            applyMode(now);
        }
    });

    return { exitX: EXIT_X, exitHint };
}

// ===========================================================================
// BANK — security guards open fire on entry (open carry inside a bank).
// ===========================================================================

function bankScene() {
    k.setGravity(WORLD.gravity);
    const { exitX, exitHint } = buildInteriorShell({
        bgRgb: [30, 30, 44],
        bgRgbInsane: [20, 8, 8],
        labelText: 'FIRST NATIONAL BANK',
        labelColor: [220, 200, 140],
        labelTextInsane: 'THE VAULT OF SOULS',
    });

    // Teller counter (decor). No medicine cabinet here — the cabinet sprite
    // reads as "there's a syringe/health pickup inside" and a bank wouldn't.
    k.add([k.sprite('table'), k.pos(k.width() / 2 - 20, WORLD.groundY + 4), k.anchor('bot'), k.z(-10)]);
    k.add([k.sprite('table'), k.pos(k.width() / 2 + 60, WORLD.groundY + 4), k.anchor('bot'), k.z(-10)]);

    const { p, spawnEnemy, spawnPickup, consumePickup, nearestInteractable } =
        buildPlayingContext({ spawnX: 140, minX: 40, maxX: k.width() - 40, invincible: calmMode });

    k.setCamPos(k.width() / 2, WORLD.groundY - 52);

    exitHint.onUpdate(() => {
        const dx = Math.abs(exitX - (p.pos.x + 16));
        exitHint.opacity = dx < 40 ? 1 : 0;
    });

    // Guards open fire only if BAM walks in carrying a firearm — open carry
    // inside a bank. Fists, bat, and molotovs are not firearms, so entering
    // empty-handed (or with melee/thrown) keeps them peaceful. globalAggro
    // still wakes them up inside spawnEnemy if BAM has already murdered.
    const equipped = run.player.weapons[run.player.weaponIdx];
    const FIREARMS = new Set(['handgun', 'shotgun', 'smg', 'taser', 'flamethrower', 'grenade']);
    const guardMode = FIREARMS.has(equipped) ? 'hostile' : 'peaceful';
    spawnEnemy('securityGuard', 300, guardMode, 'bankGuard-1');
    spawnEnemy('securityGuard', 430, guardMode, 'bankGuard-2');
    spawnPickup('ammo', k.width() - 90, WORLD.groundY - 10, 'ammo-bank');

    k.onKeyPress(['down', 's'], () => {
        const item = nearestInteractable(44, 72);
        if (item) { consumePickup(item); return; }
        const dx = Math.abs(exitX - (p.pos.x + 16));
        if (dx < 40) k.go('game', { from: 'bank' });
    });
}

// ===========================================================================
// GUN SHOP — mini-boss owner + two armored patrons. Great loot, hard fight.
// ===========================================================================

function gunShopScene() {
    k.setGravity(WORLD.gravity);
    const { exitX, exitHint } = buildInteriorShell({
        bgRgb: [40, 30, 20],
        bgRgbInsane: [30, 6, 6],
        floorSprite: 'floorInt',
        labelText: "EARL'S GUNS & AMMO",
        labelColor: [230, 160, 40],
        labelTextInsane: 'THE ARMORY OF BONES',
    });

    // Display cases — tables along the back wall. No medicine cabinet —
    // a gun shop wouldn't have one and it reads as a drug/health pickup.
    for (const x of [180, 300, 420, 540]) {
        k.add([k.sprite('table'), k.pos(x, WORLD.groundY + 4), k.anchor('bot'), k.z(-10)]);
    }

    const { p, spawnEnemy, spawnPickup, consumePickup, nearestInteractable } =
        buildPlayingContext({ spawnX: 140, minX: 40, maxX: k.width() - 40, invincible: calmMode });

    k.setCamPos(k.width() / 2, WORLD.groundY - 52);

    exitHint.onUpdate(() => {
        const dx = Math.abs(exitX - (p.pos.x + 16));
        exitHint.opacity = dx < 40 ? 1 : 0;
    });

    // Display-case loot: three different guns on the tables at 180/420/540.
    // Grabbing one is theft (like every other pickup), and any firearm leaves
    // BAM open-carrying for the bank scene. Skip the 300 table — that's the
    // owner's counter.
    spawnPickup('shotgun',      180, WORLD.groundY - 28, 'gunShop-shotgun');
    spawnPickup('smg',          420, WORLD.groundY - 28, 'gunShop-smg');
    spawnPickup('flamethrower', 540, WORLD.groundY - 28, 'gunShop-flamethrower');

    // Owner (mini-boss) centered behind the counter; patrons flank him.
    // All three are peaceful on entry — they're armed and tough, but BAM
    // has to fire first for a fight to start. Stealing a gun off a display
    // case does not wake them up — the shop is full of theft-bait.
    spawnEnemy('gunShopOwner',  k.width() / 2, 'peaceful', 'gunOwner-1');
    spawnEnemy('gunShopPatron', 260, 'peaceful', 'gunPatron-1');
    spawnEnemy('gunShopPatron', 400, 'peaceful', 'gunPatron-2');

    k.onKeyPress(['down', 's'], () => {
        const item = nearestInteractable(44, 72);
        if (item) { consumePickup(item); return; }
        const dx = Math.abs(exitX - (p.pos.x + 16));
        if (dx < 40) k.go('game', { from: 'gunShop' });
    });

    // Drop tag so the player knows what they walked into.
    k.add([
        k.text('"YOU AIN\'T FROM AROUND HERE."', { size: 10 }),
        k.pos(k.width() / 2, WORLD.groundY - 190),
        k.anchor('center'),
        k.color(200, 200, 200),
        k.z(50),
    ]);
}

// ===========================================================================
// POOL — men's changing room (empty, harmless) OR ladies' (sex offense).
// ===========================================================================

function poolMensScene() {
    k.setGravity(WORLD.gravity);
    const { exitX, exitHint } = buildInteriorShell({
        bgRgb: [30, 60, 80],
        bgRgbInsane: [20, 8, 16],
        floorSprite: 'floorInt',
        wallSprite: 'wallInt',
        labelText: "MEN'S CHANGING ROOM",
        labelColor: [180, 200, 220],
        labelTextInsane: 'THE FORGOTTEN CRYPT',
    });

    // Just decoration — benches (tables). No enemies and no medicine cabinet
    // since there's no pickup here, and the cabinet would falsely signal one.
    for (const x of [180, 300, 420, 540]) {
        k.add([k.sprite('table'), k.pos(x, WORLD.groundY + 4), k.anchor('bot'), k.z(-10)]);
    }

    const { p, consumePickup, nearestInteractable } =
        buildPlayingContext({ spawnX: 140, minX: 40, maxX: k.width() - 40, invincible: calmMode });

    k.setCamPos(k.width() / 2, WORLD.groundY - 52);

    exitHint.onUpdate(() => {
        const dx = Math.abs(exitX - (p.pos.x + 16));
        exitHint.opacity = dx < 40 ? 1 : 0;
    });

    k.add([
        k.text('Empty. Wet floor. Somebody\'s towel on a bench.', { size: 10 }),
        k.pos(k.width() / 2, WORLD.groundY - 190),
        k.anchor('center'),
        k.color(180, 200, 220),
        k.z(50),
    ]);

    k.onKeyPress(['down', 's'], () => {
        const item = nearestInteractable(44, 72);
        if (item) { consumePickup(item); return; }
        const dx = Math.abs(exitX - (p.pos.x + 16));
        if (dx < 40) k.go('game', { from: 'poolMens' });
    });
}

function poolWomensScene() {
    k.setGravity(WORLD.gravity);
    const { exitX, exitHint } = buildInteriorShell({
        bgRgb: [60, 40, 60],
        bgRgbInsane: [30, 8, 20],
        floorSprite: 'floorInt',
        wallSprite: 'wallInt',
        labelText: "LADIES' CHANGING ROOM",
        labelColor: [230, 180, 220],
        labelTextInsane: 'THE WRAITH CHAMBER',
    });

    for (const x of [180, 300, 420]) {
        k.add([k.sprite('table'), k.pos(x, WORLD.groundY + 4), k.anchor('bot'), k.z(-10)]);
    }

    const { p, spawnEnemy, consumePickup, nearestInteractable } =
        buildPlayingContext({ spawnX: 140, minX: 40, maxX: k.width() - 40, invincible: calmMode });

    k.setCamPos(k.width() / 2, WORLD.groundY - 52);

    exitHint.onUpdate(() => {
        const dx = Math.abs(exitX - (p.pos.x + 16));
        exitHint.opacity = dx < 40 ? 1 : 0;
    });

    // Sex offense tallied per woman visible in the room — even escaping without
    // harming them is already a crime. Only counted once per woman per run.
    // Calm (art-testing) mode skips the tally so the tester can browse freely.
    const WOMEN_IDS = ['towelLady-1', 'towelLady-2', 'towelLady-3'];
    const witnessed = WOMEN_IDS.filter((id) => !run.killedEnemies.has(id));
    if (!calmMode && !run.poolOffenseCommitted) {
        run.stats.sexOffenseCount += witnessed.length;
        run.poolOffenseCommitted = true;
    }

    // Hostile from the first frame; they drop nothing on death.
    spawnEnemy('towelWoman', 280, 'hostile', 'towelLady-1');
    spawnEnemy('towelWoman', 400, 'hostile', 'towelLady-2');
    spawnEnemy('towelWoman', 520, 'hostile', 'towelLady-3');

    k.add([
        k.text('They see you. All of them scream.', { size: 10 }),
        k.pos(k.width() / 2, WORLD.groundY - 190),
        k.anchor('center'),
        k.color(230, 180, 220),
        k.z(50),
    ]);

    k.onKeyPress(['down', 's'], () => {
        const item = nearestInteractable(44, 72);
        if (item) { consumePickup(item); return; }
        const dx = Math.abs(exitX - (p.pos.x + 16));
        if (dx < 40) k.go('game', { from: 'poolWomens' });
    });
}

// The "poolLobby" scene is registered for completeness; nothing currently
// routes through it (entries from the outside go straight to mens/womens).
function poolLobbyScene() { k.go('game', { from: 'poolMens' }); }

// ===========================================================================
// CHURCH INTERIOR — the final boss fight. Choir opens hostile, priest is a
// tanky menace. On the priest's death we play the cinematic ending.
// ===========================================================================

function churchInteriorScene() {
    k.setGravity(WORLD.gravity);
    // Run is guaranteed non-null (only reachable via the outdoor end trigger).
    const player = run.player;

    // Backdrop — warm cathedral glow when serene, oppressive dark when insane.
    const bg = k.add([k.rect(k.width() * 3, k.height()), k.color(36, 22, 14), k.fixed(), k.z(-100)]);
    bg.onUpdate(() => {
        bg.color = isInsane() ? k.rgb(16, 6, 6) : k.rgb(46, 30, 22);
    });

    // The interior is wider than the viewport so the boss has room to move.
    const INTERIOR_W = 1600;

    // Floor tiles — swap to scorched flagstones in insane mode.
    const churchFloorTiles = [];
    for (let x = 0; x < INTERIOR_W; x += 32) {
        churchFloorTiles.push(k.add([
            k.sprite('floorInt'), k.pos(x, WORLD.groundY), k.z(-19),
            { curSpr: 'floorInt' },
        ]));
    }
    // Ground collider
    k.add([
        k.rect(INTERIOR_W + 80, 160),
        k.pos(-40, WORLD.groundY),
        k.color(56, 34, 22),
        k.opacity(0),
        k.area(),
        k.body({ isStatic: true }),
        'ground',
        k.z(-20),
    ]);

    // Tall stained-glass windows — tinted blood-red when insane so the
    // cathedral reads as a demonic temple until the drugs wear off.
    const stainedEnts = [];
    for (const x of [180, 460, 740, 1020, 1300]) {
        stainedEnts.push(k.add([
            k.sprite('stainedGlass'),
            k.pos(x, WORLD.groundY - 130),
            k.anchor('bot'),
            k.z(-40),
        ]));
    }
    // Pews (two rows)
    const pewEnts = [];
    for (const x of [180, 380, 580, 780, 980, 1180]) {
        pewEnts.push(k.add([
            k.sprite('churchPew'), k.pos(x, WORLD.groundY + 4), k.anchor('bot'), k.z(-8),
        ]));
    }
    // Altar at the far end
    const altarEnt = k.add([
        k.sprite('churchAltar'),
        k.pos(INTERIOR_W - 120, WORLD.groundY + 4),
        k.anchor('bot'),
        k.z(-8),
    ]);

    // Mode reaction — floor sprite swap + colour tint on the fixed art.
    function applyChurchMode(insane) {
        const fS = insane ? 'floorIntInsane' : 'floorInt';
        for (const t of churchFloorTiles) {
            if (t.curSpr !== fS) { t.curSpr = fS; t.use(k.sprite(fS)); }
        }
        // Blood-red wash on pews, altar, and stained glass in insane mode.
        const tint = insane ? k.rgb(140, 40, 40) : k.rgb(255, 255, 255);
        for (const e of pewEnts) e.color = tint;
        altarEnt.color = tint;
        for (const s of stainedEnts) s.color = insane ? k.rgb(200, 60, 60) : k.rgb(255, 255, 255);
    }
    let churchLastInsane = isInsane();
    applyChurchMode(churchLastInsane);
    k.onUpdate(() => {
        const now = isInsane();
        if (now !== churchLastInsane) {
            churchLastInsane = now;
            applyChurchMode(now);
        }
    });
    // Entrance door — decorative by default, but in calm mode it's a working
    // exit so the art-tester can step back outside without killing the priest.
    const CHURCH_EXIT_X = 60;
    k.add([k.sprite('exitDoor'), k.pos(CHURCH_EXIT_X, WORLD.groundY + 4), k.anchor('bot'), k.z(-4)]);
    let churchExitHint = null;
    if (calmMode) {
        churchExitHint = k.add([
            k.text('↓ EXIT', { size: 20 }),
            k.pos(CHURCH_EXIT_X, WORLD.groundY - 108),
            k.anchor('center'),
            k.color(255, 240, 80),
            k.opacity(0),
            k.z(50),
        ]);
    }

    const { p, spawnEnemy } = buildPlayingContext({
        spawnX: 110, minX: 40, maxX: INTERIOR_W - 40,
        invincible: calmMode,
        enemyActiveDistance: 2000,
    });

    // Scrolling camera — follow the player through the nave.
    p.onUpdate(() => {
        const camX = Math.max(k.width() / 2, Math.min(INTERIOR_W - k.width() / 2, p.pos.x));
        k.setCamPos(camX, WORLD.groundY - 52);
    });

    // Choir arrayed before the altar, priest dead centre in front of it.
    // They're singing peacefully — even in insane mode where BAM sees them
    // as demons, they don't throw the first punch. If BAM fires, the
    // bullet onCollide handler flips them to hostile and the fight starts;
    // until then this is a choir practice, not an ambush. This is what
    // makes the ending land — BAM killed people who were praying.
    const choirIds = ['chI-1', 'chI-2', 'chI-3', 'chI-4', 'chI-5'];
    const choirX = [1020, 1080, 1140, 1200, 1260];
    choirX.forEach((x, i) => spawnEnemy('choir', x, 'peaceful', choirIds[i]));
    spawnEnemy('priest', INTERIOR_W - 200, 'peaceful', 'priest-boss');

    // Calm-mode exit — ↓ near the entrance drops back outside. The hint
    // fades in only when BAM is close enough to use the door.
    if (calmMode && churchExitHint) {
        churchExitHint.onUpdate(() => {
            churchExitHint.pos.y = WORLD.groundY - 108 + Math.sin(k.time() * 5) * 3;
            const dx = Math.abs(CHURCH_EXIT_X - (p.pos.x + 16));
            churchExitHint.opacity = dx < 40 ? 1 : 0;
        });
        k.onKeyPress(['down', 's'], () => {
            const dx = Math.abs(CHURCH_EXIT_X - (p.pos.x + 16));
            if (dx < 40) k.go('game', { from: 'church' });
        });
    }

    // Watch for the priest's death (crime cinematic) OR for BAM walking up
    // to a still-peaceful priest (pacifist win path). If BAM has murdered
    // anyone outside, globalAggro has already flipped the priest hostile via
    // spawnEnemy, so the peaceful branch only fires on a genuine no-kill run.
    let cinematicStarted = false;
    let peacefulEndStarted = false;
    k.onUpdate(() => {
        if (cinematicStarted || peacefulEndStarted) return;
        // Calm mode skips the narrative — the priest can still be killed so
        // the art tester can see corpse sprites, but we don't lock input or
        // transition to the verdict screen.
        if (calmMode) return;
        if (run.killedEnemies.has('priest-boss')) {
            cinematicStarted = true;
            startCinematic();
            return;
        }
        const priest = k.get('enemy').find((e) => e.persistId === 'priest-boss');
        if (priest && priest.state === 'peaceful') {
            const dx = Math.abs(priest.pos.x - (p.pos.x + 16));
            if (dx < 72) {
                peacefulEndStarted = true;
                startPeacefulEnding();
            }
        }
    });

    function startPeacefulEnding() {
        // Lock BAM in place so he can't wander back mid-fade.
        player.stunUntil = k.time() + 999;
        player.knockVx = 0;
        player.invulnUntil = 0;
        // Brief beat on the altar before the verdict lands.
        k.add([
            k.text('AMEN.', { size: 30 }),
            k.pos(k.width() / 2, 72),
            k.anchor('center'),
            k.color(255, 240, 180),
            k.fixed(),
            k.z(100),
        ]);
        k.wait(1.8, () => {
            k.go('ending', {
                stats: run.stats,
                player: run.player,
                runTimeMs: Math.floor((k.time() - run.startTime) * 1000),
            });
        });
    }

    function startCinematic() {
        // Lock BAM in place and kill any residual UI feedback from the fight
        // (invulnUntil still firing the U-S-A flash, knock-back momentum).
        player.stunUntil = k.time() + 999;
        player.knockVx = 0;
        player.invulnUntil = 0;

        // Camera pans to the altar.
        const camLockX = Math.min(INTERIOR_W - k.width() / 2, Math.max(k.width() / 2, p.pos.x));
        k.setCamPos(camLockX, WORLD.groundY - 52);

        // Remove remaining enemies — the choir dies at the priest's feet so we
        // can drop corpse sprites in their place.
        for (const e of k.get('enemy')) {
            k.add([
                k.sprite('corpse'),
                k.pos(e.pos.x + 8, WORLD.groundY - 2),
                k.anchor('bot'),
                k.z(-7),
            ]);
            k.destroy(e);
        }
        // Priest corpse explicitly near the altar
        k.add([
            k.sprite('corpse'),
            k.pos(INTERIOR_W - 200, WORLD.groundY - 2),
            k.anchor('bot'),
            k.z(-7),
        ]);

        // BAM: "You did it!" over the player's head (world-space).
        k.wait(0.8, () => {
            speechBubble({ x: p.pos.x + 24, y: p.pos.y - 6, text: 'You did it!',
                rgb: [255, 240, 100], fixed: false, ttl: 2.8 });
        });

        // Clear the insane condition (which was hiding the truth).
        k.wait(2.4, () => {
            player.intoxicatedUntil = k.time() - 1;
            player.rageUntil = k.time() - 1;
            player.health = player.maxHealth;
        });

        // Offscreen police voices, shown as screen-fixed bubbles in the
        // clear strip between the top HUD and the HUD-free middle of the
        // screen. Advance on space/enter/↓ instead of auto-timing so the
        // player can actually read each line.
        const policeLines = [
            'You, inside!',
            'We have the church surrounded!',
            'Put down your weapons and come out with your hands up!',
        ];
        k.wait(3.2, () => runPoliceDialog(policeLines, () => k.go('policeOutside')));
    }

    /**
     * Show each line one at a time as a screen-fixed bubble with a small
     * "▼ space" prompt; advance on space/enter/↓/click. Calls `onDone` after
     * the last line is acknowledged.
     * @param {string[]} lines
     * @param {() => void} onDone
     */
    function runPoliceDialog(lines, onDone) {
        let idx = 0;
        /** @type {any[]} */
        let current = [];
        const advance = () => {
            for (const e of current) if (e.exists()) k.destroy(e);
            current = [];
            if (idx >= lines.length) { onDone(); return; }
            current = speechBubble({
                x: k.width() / 2,
                y: 100,                 // below the top HUD, above mid-screen
                text: lines[idx],
                rgb: [120, 180, 255],
                fixed: true,
                ttl: null,              // persists until player advances
                promptText: idx < lines.length - 1 ? '▼ space' : '▼ continue',
            });
            idx++;
        };
        advance();
        k.onKeyPress(['space', 'enter', 'down', 's'], advance);
        k.onClick(advance);
    }
}

/**
 * Paint a speech bubble. Supports two modes:
 *   - world-space (fixed:false): tracks world coordinates, used for BAM's
 *     "You did it!" over his head.
 *   - screen-fixed (fixed:true): stays anchored to the viewport regardless
 *     of camera position — used for the police PA bubbles so they can't
 *     end up half-off-screen.
 * ttl=null means the bubble persists until the caller destroys it (for
 * press-to-advance dialog). Pass a number for auto-fade.
 *
 * @param {object} opts
 * @param {number} opts.x
 * @param {number} opts.y
 * @param {string} opts.text
 * @param {[number,number,number]} [opts.rgb]
 * @param {boolean} [opts.fixed]
 * @param {number | null} [opts.ttl]
 * @param {string} [opts.promptText]  small prompt drawn below the bubble
 * @returns {any[]} all entities the bubble owns (for manual cleanup)
 */
function speechBubble(opts) {
    const { x, y, text, rgb = [255, 255, 255], fixed = false, ttl = 2.8, promptText = null } = opts;
    const padding = 8;
    const size = 12;
    const width = Math.min(360, Math.max(60, text.length * 6 + padding * 2));
    const bgComponents = [
        k.rect(width, size + padding * 2),
        k.pos(x, y),
        k.anchor('center'),
        k.color(20, 20, 20),
        k.outline(1, k.rgb(...rgb)),
        k.opacity(0.92),
        k.z(90),
    ];
    if (fixed) bgComponents.push(k.fixed());
    if (ttl != null) bgComponents.push(k.lifespan(ttl));
    const bg = k.add(bgComponents);

    const labelComponents = [
        k.text(text, { size, width: width - padding * 2, align: 'center' }),
        k.pos(x, y),
        k.anchor('center'),
        k.color(...rgb),
        k.opacity(1),
        k.z(91),
    ];
    if (fixed) labelComponents.push(k.fixed());
    if (ttl != null) labelComponents.push(k.lifespan(ttl));
    const label = k.add(labelComponents);

    const out = [bg, label];
    if (promptText) {
        const promptComponents = [
            k.text(promptText, { size: 8 }),
            k.pos(x, y + size + padding * 2),
            k.anchor('top'),
            k.color(180, 200, 220),
            k.opacity(1),
            k.z(91),
        ];
        if (fixed) promptComponents.push(k.fixed());
        if (ttl != null) promptComponents.push(k.lifespan(ttl));
        const prompt = k.add(promptComponents);
        prompt.onUpdate(() => { prompt.opacity = 0.4 + 0.6 * Math.abs(Math.sin(k.time() * 4)); });
        out.push(prompt);
    }
    return out;
}

// ===========================================================================
// POLICE OUTSIDE — brief cinematic before the verdict screen.
// ===========================================================================

function policeOutsideScene() {
    k.setGravity(WORLD.gravity);

    // Crucial: the previous scene (churchInterior) left the camera parked
    // deep inside the nave at camLockX ≈ priest's position. World-space
    // sprites drawn below would all be offscreen unless we reset first.
    k.setCamPos(k.width() / 2, WORLD.groundY - 52);

    // Nighttime clean sky with police lights
    k.add([k.rect(k.width(), k.height()), k.color(14, 20, 50), k.fixed(), k.z(-100)]);
    // Faint stars
    for (let i = 0; i < 30; i++) {
        const sx = (i * 73) % k.width();
        const sy = (i * 41) % 120;
        k.add([k.rect(1, 1), k.pos(sx, sy), k.color(255, 255, 255), k.opacity(0.4 + (i % 3) * 0.2), k.fixed(), k.z(-99)]);
    }
    // Church silhouette dead centre, big and ominous — the scene of the crime.
    k.add([k.sprite('church'), k.pos(k.width() / 2, WORLD.groundY + 4), k.anchor('bot'), k.z(-5)]);
    // Ground
    k.add([k.rect(k.width() + 80, 160), k.pos(-40, WORLD.groundY), k.color(60, 60, 60), k.z(-20)]);
    for (let x = 0; x < k.width(); x += 32) {
        k.add([k.sprite('road'), k.pos(x, WORLD.groundY), k.z(-19)]);
    }

    // Police cars flanking BOTH sides of the church — two on the left, two
    // on the right — so visually the church is surrounded. Inner cars aim
    // toward the centre, outer ones face outward like a perimeter.
    const carPlacements = [
        { x: 40,                     flipped: false },   // far left, facing right toward the church
        { x: 140,                    flipped: false },   // near left
        { x: k.width() - 140 - 80,   flipped: true  },   // near right
        { x: k.width() - 40 - 80,    flipped: true  },   // far right
    ];
    for (const { x, flipped } of carPlacements) {
        const car = k.add([
            k.sprite('policeCar', { flipX: flipped }),
            k.pos(x, WORLD.groundY - 18),
            k.z(-1),
            k.opacity(1),
            { tick: Math.random() * 0.6, alt: false },
        ]);
        const glow = k.add([
            k.rect(80, 18),
            k.pos(x - 20, WORLD.groundY - 6),
            k.color(200, 40, 40),
            k.opacity(0.45),
            k.z(-4),
        ]);
        car.onUpdate(() => {
            car.tick += k.dt();
            if (car.tick > 0.25) {
                car.tick = 0;
                car.alt = !car.alt;
                car.use(k.sprite(car.alt ? 'policeCarAlt' : 'policeCar', { flipX: flipped }));
                glow.color = car.alt ? k.rgb(40, 80, 220) : k.rgb(220, 40, 40);
            }
        });
    }

    // Officers stand in the gaps between the cruisers (and one SWAT out front
    // centred on the church door) so nobody appears to be standing on a hood.
    // Cars span: [40-80], [140-180], [w-220 to w-180], [w-120 to w-80].
    const officerPlacements = [
        { x: 20,                kind: 'cop'  },   // far left, before car #1
        { x: 110,               kind: 'cop'  },   // gap between cars #1 and #2
        { x: k.width() / 2,     kind: 'swat' },   // dead centre, facing the door
        { x: k.width() - 150,   kind: 'cop'  },   // gap between cars #3 and #4
        { x: k.width() - 40,    kind: 'swat' },   // far right, after car #4
    ];
    for (const { x, kind } of officerPlacements) {
        k.add([
            k.sprite(kind + 'Idle'),
            k.pos(x, WORLD.groundY + 4),
            k.anchor('bot'),
            k.z(-2),
        ]);
    }

    // Crowd silhouettes way back (spectators)
    for (const x of [30, 90, 220, 330, 420, 460]) {
        k.add([
            k.rect(6, 16),
            k.pos(x, WORLD.groundY - 16),
            k.color(20, 20, 30),
            k.z(-10),
        ]);
    }

    // Tinted red/blue pulse overlay to sell the flashing-lights ambience.
    const pulse = k.add([
        k.rect(k.width(), k.height()),
        k.pos(0, 0),
        k.color(120, 40, 40),
        k.opacity(0.12),
        k.fixed(),
        k.z(-98),
        { tick: 0, alt: false },
    ]);
    pulse.onUpdate(() => {
        pulse.tick += k.dt();
        if (pulse.tick > 0.28) {
            pulse.tick = 0;
            pulse.alt = !pulse.alt;
            pulse.color = pulse.alt ? k.rgb(40, 80, 180) : k.rgb(180, 40, 40);
        }
    });

    k.add([
        k.text('MINUTES LATER...', { size: 18 }),
        k.pos(k.width() / 2, 36),
        k.anchor('center'),
        k.color(220, 220, 220),
        k.fixed(),
        k.z(100),
    ]);
    k.add([
        k.text('The whole town came out for you.', { size: 12 }),
        k.pos(k.width() / 2, 60),
        k.anchor('center'),
        k.color(180, 180, 180),
        k.fixed(),
        k.z(100),
    ]);
    // Advance prompt
    const go = () => k.go('ending', {
        stats: run.stats,
        player: run.player,
        runTimeMs: Math.floor((k.time() - run.startTime) * 1000),
    });
    const advancePrompt = k.add([
        k.text('▼ space', { size: 10 }),
        k.pos(k.width() / 2, k.height() - 16),
        k.anchor('center'),
        k.color(180, 200, 220),
        k.opacity(1),
        k.fixed(),
        k.z(100),
    ]);
    advancePrompt.onUpdate(() => {
        advancePrompt.opacity = 0.4 + 0.6 * Math.abs(Math.sin(k.time() * 4));
    });
    // Give the player a beat to look at the scene before letting them skip.
    k.wait(1.0, () => {
        k.onKeyPress(['space', 'enter', 'down', 's'], go);
        k.onClick(go);
    });
    // Safety: if they never press anything, advance after a long pause.
    k.wait(12, go);
}

// ===========================================================================
// DEBUG — standalone arena, reachable via ?debug in the URL.
// Infinite health, all weapons with 500 ammo each, random enemies enter from
// the right every 300–1500 ms. No splash, no death, no ending.
// ===========================================================================

function debugScene() {
    k.setGravity(WORLD.gravity);

    // Fresh run with the debug loadout: every weapon, stacked ammo.
    run = createRun();
    run.startTime = k.time();
    run.player.weapons = ['fists', 'bat', 'handgun', 'shotgun', 'smg', 'taser', 'flamethrower', 'grenade', 'molotov'];
    run.player.weaponIdx = 2;
    run.player.ammo = {
        fists: null, bat: null,
        handgun: 500, shotgun: 500, smg: 500, taser: 500,
        flamethrower: 500, grenade: 500, molotov: 500,
    };

    // ----- Scenery (single-screen fixed arena) -----------------------------
    k.add([k.rect(k.width(), k.height()), k.color(142, 200, 238), k.fixed(), k.z(-100)]);
    k.add([k.sprite('sun'), k.pos(360, 30), k.fixed(), k.z(-90)]);
    k.add([k.rect(k.width(), 60), k.pos(0, 120), k.color(90, 110, 140), k.fixed(), k.z(-80)]);
    k.add([k.rect(k.width(), 40), k.pos(0, 140), k.color(70, 90, 120), k.fixed(), k.z(-79)]);

    // Ground extends past the right edge so enemies have something to walk on
    // while still offscreen at spawn time.
    k.add([
        k.rect(k.width() + 800, 160),
        k.pos(-400, WORLD.groundY),
        k.color(110, 74, 40),
        k.area(),
        k.body({ isStatic: true }),
        'ground',
        k.z(-20),
    ]);
    for (let x = -400; x < k.width() + 400; x += 32) {
        k.add([k.sprite('ground'), k.pos(x, WORLD.groundY), k.z(-19)]);
    }

    k.add([
        k.text('DEBUG', { size: 22 }),
        k.pos(k.width() / 2, 96),
        k.anchor('top'),
        k.fixed(),
        k.color(240, 200, 80),
        k.z(100),
    ]);

    // Bump the active-distance window — enemies spawn just off the right edge,
    // which is ~400px from the player at screen-left, outside the default 600.
    const { spawnEnemy } = buildPlayingContext({
        spawnX: 240,
        minX: 0,
        maxX: k.width() - 32,
        invincible: true,
        enemyActiveDistance: 1000,
    });

    // Fixed camera — the debug arena fits on one screen.
    k.setCamPos(k.width() / 2, WORLD.groundY - 52);

    const debugKinds = [
        'dog', 'child', 'father', 'mother', 'scout', 'cop', 'mallCop', 'boss', 'choir', 'swat',
        'securityGuard', 'gunShopOwner', 'gunShopPatron', 'towelWoman', 'priest',
    ];
    const MAX_CONCURRENT = 40;

    function scheduleSpawn() {
        const delay = 0.3 + Math.random() * 1.2;
        k.wait(delay, () => {
            if (k.get('enemy').length < MAX_CONCURRENT) {
                const kind = debugKinds[Math.floor(Math.random() * debugKinds.length)];
                spawnEnemy(kind, k.width() + 40, 'hostile');
            }
            scheduleSpawn();
        });
    }
    scheduleSpawn();

    // Clean up enemies that wander far off the left so they don't pile up.
    k.onUpdate(() => {
        for (const e of k.get('enemy')) {
            if (e.pos.x < -160) k.destroy(e);
        }
    });
}

// ===========================================================================
// DEATH SCENE
// ===========================================================================

async function deathScene({ stats, runTimeMs }) {
    k.add([k.rect(k.width(), k.height()), k.color(20, 0, 0), k.fixed(), k.z(-100)]);
    k.add([
        k.text('YOU DIED', { size: 48 }),
        k.pos(k.width() / 2, 70),
        k.anchor('center'),
        k.color(255, 60, 60),
    ]);
    k.add([
        k.text('try again, snowflake', { size: 14 }),
        k.pos(k.width() / 2, 110),
        k.anchor('center'),
        k.color(200, 200, 200),
    ]);

    const totalKills = sumKills(stats.kills);
    const years = computeYears(stats);

    const info = [
        `time survived: ${formatMs(runTimeMs)}`,
    ];
    info.forEach((ln, i) => {
        k.add([
            k.text(ln, { size: 14 }),
            k.pos(k.width() / 2, 140 + i * 14),
            k.anchor('center'),
            k.color(220, 220, 220),
        ]);
    });

    k.add([
        k.text('SPACE = try again    B = scoreboard', { size: 13 }),
        k.pos(k.width() / 2, k.height() - 18),
        k.anchor('center'),
        k.color(180, 180, 180),
    ]);

    k.onKeyPress('space', () => k.go('game'));
    k.onKeyPress('b', () => k.go('scoreboard'));

    // Auto-prompt score submission if they killed anything
    if (totalKills > 0) {
        const name = await askForName();
        if (name) {
            try {
                const saved = await submitScore({
                    name,
                    ending: 'crime',
                    kills: totalKills,
                    time_ms: runTimeMs,
                    health: 0,
                    years,
                });
                k.add([
                    k.text('score saved — share it or press B for board', { size: 13 }),
                    k.pos(k.width() / 2, k.height() - 34),
                    k.anchor('center'),
                    k.color(100, 220, 120),
                ]);
                await openShare(saved);
            } catch (err) {
                console.error(err);
            }
        }
    }
}

// ===========================================================================
// ENDING SCENE (crimes vs. win)
// ===========================================================================

async function endingScene({ stats, player, runTimeMs }) {
    const totalKills = sumKills(stats.kills);
    const peaceful = isPeacefulRun(stats, totalKills);

    k.add([
        k.rect(k.width(), k.height()),
        k.color(peaceful ? 140 : 20, peaceful ? 200 : 0, peaceful ? 220 : 0),
        k.fixed(),
        k.z(-100),
    ]);

    if (peaceful) {
        // Win ending
        k.add([
            k.text('AMERICA', { size: 46 }),
            k.pos(k.width() / 2, 46),
            k.anchor('center'),
            k.color(255, 255, 255),
        ]);
        k.add([
            k.text('lives.', { size: 24 }),
            k.pos(k.width() / 2, 86),
            k.anchor('center'),
            k.color(255, 220, 80),
        ]);
        k.add([
            k.text('You walked through town. You hurt no one.\nThe church choir sings, just for you.', {
                size: 14, width: 380, align: 'center',
            }),
            k.pos(k.width() / 2, 120),
            k.anchor('center'),
            k.color(20, 30, 60),
        ]);
        // Little choir line of figures (sprites are already 2× native size)
        for (let i = 0; i < 5; i++) {
            k.add([
                k.sprite('choirIdle'),
                k.pos(k.width() / 2 - 100 + i * 42, 220),
                k.anchor('bot'),
            ]);
        }
        k.add([
            k.text(`time: ${formatMs(runTimeMs)}`, { size: 16 }),
            k.pos(k.width() / 2, 232),
            k.anchor('center'),
            k.color(20, 20, 20),
        ]);
    } else {
        // Crime ending
        k.add([
            k.text('UNITED STATES v.', { size: 14 }),
            k.pos(k.width() / 2, 20),
            k.anchor('center'),
            k.color(220, 220, 220),
        ]);
        k.add([
            k.text('YOU', { size: 44 }),
            k.pos(k.width() / 2, 52),
            k.anchor('center'),
            k.color(255, 60, 60),
        ]);
        // Crimes list — two columns so even a full rampage (13 lines) fits.
        const { petty, violent } = buildCrimesList(stats);
        const colW = 228;
        const gutter = 12;
        const colLeftX = 20;
        const colRightX = colLeftX + colW + gutter;
        const headerY = 90;
        const rowY = headerY + 18;

        // Stack rows by measured height so a line that wraps to two visual
        // lines pushes the next row down instead of overlapping it.
        const renderColumn = (lines, x) => {
            let cy = rowY;
            for (const ln of lines) {
                const t = k.add([
                    k.text(ln, { size: 11, width: colW, align: 'left' }),
                    k.pos(x, cy),
                    k.color(220, 220, 220),
                ]);
                cy += (t.height || 12) + 2;
            }
        };
        if (petty.length) {
            k.add([
                k.text('MISDEMEANORS / FELONIES', { size: 10 }),
                k.pos(colLeftX, headerY),
                k.color(255, 200, 80),
            ]);
            renderColumn(petty, colLeftX);
        }
        if (violent.length) {
            k.add([
                k.text('HOMICIDES', { size: 10 }),
                k.pos(colRightX, headerY),
                k.color(255, 120, 120),
            ]);
            renderColumn(violent, colRightX);
        }
        const years = computeYears(stats);
        const sentence = years > 150
            ? `SENTENCE: ${years} years — ${Math.floor(years / 75)} consecutive life terms`
            : `SENTENCE: ${years} years in federal prison`;
        k.add([
            k.text(sentence, { size: 15 }),
            k.pos(k.width() / 2, k.height() - 38),
            k.anchor('center'),
            k.color(255, 200, 80),
        ]);
        k.add([
            k.text(`kills: ${totalKills}   time: ${formatMs(runTimeMs)}`, { size: 13 }),
            k.pos(k.width() / 2, k.height() - 22),
            k.anchor('center'),
            k.color(180, 180, 180),
        ]);
    }

    k.add([
        k.text('SPACE = new run    B = scoreboard', { size: 13 }),
        k.pos(k.width() / 2, k.height() - 8),
        k.anchor('center'),
        k.color(200, 200, 200),
    ]);

    k.onKeyPress('space', () => k.go('game'));
    k.onKeyPress('b', () => k.go('scoreboard'));

    // Ask for name + submit
    const name = await askForName();
    if (name) {
        try {
            const saved = await submitScore({
                name,
                ending: peaceful ? 'win' : 'crime',
                kills: totalKills,
                time_ms: runTimeMs,
                health: player.health,
                years: peaceful ? 0 : computeYears(stats),
            });
            k.add([
                k.text('score saved — share it or press B for board', { size: 13 }),
                k.pos(k.width() / 2, peaceful ? k.height() - 28 : k.height() - 54),
                k.anchor('center'),
                k.color(100, 220, 120),
            ]);
            await openShare(saved);
        } catch (err) {
            console.error(err);
        }
    }
}

// ===========================================================================
// SCOREBOARD
// ===========================================================================

async function scoreboardScene() {
    k.add([k.rect(k.width(), k.height()), k.color(10, 15, 25), k.fixed(), k.z(-100)]);
    k.add([
        k.text('SCOREBOARD', { size: 24 }),
        k.pos(k.width() / 2, 18),
        k.anchor('center'),
        k.color(255, 255, 255),
    ]);

    const loading = k.add([
        k.text('loading…', { size: 14 }),
        k.pos(k.width() / 2, k.height() / 2),
        k.anchor('center'),
        k.color(200, 200, 200),
    ]);

    let scores = [];
    try {
        scores = await fetchTopScores();
    } catch (err) {
        loading.text = 'board offline';
        console.error(err);
    }
    k.destroy(loading);

    // Split into two lists — winners (peaceful runs, ranked by fastest time)
    // and the FBI most-wanted (criminal runs, ranked by prison sentence).
    const winners = scores
        .filter((s) => s.ending === 'win')
        .sort((a, b) => a.time_ms - b.time_ms);
    const wanted = scores
        .filter((s) => s.ending !== 'win')
        .sort((a, b) => (b.years || 0) - (a.years || 0));

    if (scores.length === 0) {
        k.add([
            k.text('no runs yet — be the first', { size: 14 }),
            k.pos(k.width() / 2, k.height() / 2),
            k.anchor('center'),
            k.color(180, 180, 180),
        ]);
        k.add([
            k.text('SPACE = play    ESC = splash', { size: 12 }),
            k.pos(k.width() / 2, k.height() - 14),
            k.anchor('center'),
            k.color(200, 200, 200),
        ]);
        k.onKeyPress('space', () => k.go('game'));
        k.onKeyPress('escape', () => k.go('splash'));
        return;
    }

    // Two-column layout on the 512-wide viewport.
    const GUTTER = 4;
    const COL_W = (k.width() - GUTTER * 3) / 2;   // ≈ 250
    const leftX = GUTTER;
    const rightX = leftX + COL_W + GUTTER;
    const headerY = 44;
    const rowSize = 10;
    const rowStep = 11;
    const rowTop = headerY + 22;
    const rowBottom = k.height() - 28;
    const perPage = Math.floor((rowBottom - rowTop) / rowStep);

    // Column headings
    k.add([
        k.text('WINNERS', { size: 14 }),
        k.pos(leftX + COL_W / 2, headerY - 4),
        k.anchor('top'),
        k.color(120, 230, 140),
    ]);
    k.add([
        k.text('fastest times', { size: 9 }),
        k.pos(leftX + COL_W / 2, headerY + 12),
        k.anchor('top'),
        k.color(140, 180, 150),
    ]);
    k.add([
        k.text("FBI'S MOST WANTED", { size: 14 }),
        k.pos(rightX + COL_W / 2, headerY - 4),
        k.anchor('top'),
        k.color(255, 120, 120),
    ]);
    k.add([
        k.text('longest sentences', { size: 9 }),
        k.pos(rightX + COL_W / 2, headerY + 12),
        k.anchor('top'),
        k.color(200, 140, 140),
    ]);

    // Sub-headers + divider lines, per column
    const drawColumnHead = (x, right) => {
        k.add([k.text('#',    { size: 9 }), k.pos(x + 4,       rowTop - 10), k.color(160, 160, 160)]);
        k.add([k.text('NAME', { size: 9 }), k.pos(x + 18,      rowTop - 10), k.color(160, 160, 160)]);
        k.add([
            k.text(right, { size: 9 }),
            k.pos(x + COL_W - 4, rowTop - 10),
            k.anchor('topright'),
            k.color(160, 160, 160),
        ]);
        k.add([k.rect(COL_W - 4, 1), k.pos(x + 2, rowTop - 2), k.color(70, 76, 92)]);
    };
    drawColumnHead(leftX,  'TIME');
    drawColumnHead(rightX, 'YEARS');

    // Vertical divider between the two columns
    k.add([
        k.rect(1, rowBottom - headerY + 16),
        k.pos(leftX + COL_W + GUTTER / 2, headerY - 4),
        k.color(50, 58, 72),
    ]);

    // Paginate both lists in lock-step so ← → scrolls them together.
    const totalPages = Math.max(
        1,
        Math.ceil(winners.length / perPage),
        Math.ceil(wanted.length  / perPage),
    );
    let page = 0;
    let rowEntities = [];

    const renderColumn = (list, x, rgb, rightField) => {
        const start = page * perPage;
        list.slice(start, start + perPage).forEach((s, i) => {
            const rank = start + i + 1;
            const y = rowTop + i * rowStep;
            rowEntities.push(k.add([
                k.text(`${rank}`, { size: rowSize }),
                k.pos(x + 4, y),
                k.color(...rgb),
            ]));
            rowEntities.push(k.add([
                k.text(s.name.slice(0, 16), { size: rowSize }),
                k.pos(x + 18, y),
                k.color(...rgb),
            ]));
            rowEntities.push(k.add([
                k.text(rightField(s), { size: rowSize }),
                k.pos(x + COL_W - 4, y),
                k.anchor('topright'),
                k.color(...rgb),
            ]));
        });
    };
    const renderPage = () => {
        rowEntities.forEach((e) => k.destroy(e));
        rowEntities = [];
        renderColumn(winners, leftX,  [120, 230, 140], (s) => formatMs(s.time_ms));
        renderColumn(wanted,  rightX, [255, 120, 120], (s) => `${s.years || 0}y`);
        // "empty column" hint if either side has nothing on this page
        const winStart = page * perPage;
        if (winStart >= winners.length) {
            rowEntities.push(k.add([
                k.text('— no winners yet —', { size: 10 }),
                k.pos(leftX + COL_W / 2, rowTop + 8),
                k.anchor('top'),
                k.color(90, 130, 100),
            ]));
        }
        if (winStart >= wanted.length) {
            rowEntities.push(k.add([
                k.text('— nobody wanted —', { size: 10 }),
                k.pos(rightX + COL_W / 2, rowTop + 8),
                k.anchor('top'),
                k.color(130, 90, 90),
            ]));
        }
    };
    renderPage();

    // Pagination indicator
    const pageLabel = k.add([
        k.text(`page 1 / ${totalPages}`, { size: 11 }),
        k.pos(k.width() - 16, k.height() - 32),
        k.anchor('topright'),
        k.color(180, 180, 180),
    ]);
    const refreshLabel = () => { pageLabel.text = `page ${page + 1} / ${totalPages}`; };

    k.onKeyPress(['right', 'd', 'pagedown'], () => {
        if (page < totalPages - 1) { page++; refreshLabel(); renderPage(); }
    });
    k.onKeyPress(['left', 'a', 'pageup'], () => {
        if (page > 0) { page--; refreshLabel(); renderPage(); }
    });

    const help = totalPages > 1
        ? '← → = page    SPACE = play    ESC = splash'
        : 'SPACE = play    ESC = splash';
    k.add([
        k.text(help, { size: 12 }),
        k.pos(k.width() / 2, k.height() - 14),
        k.anchor('center'),
        k.color(200, 200, 200),
    ]);
    k.onKeyPress('space', () => k.go('game'));
    k.onKeyPress('escape', () => k.go('splash'));
    k.onKeyPress('b', () => k.go('splash'));
}

// ===========================================================================
// Helpers
// ===========================================================================

function sumKills(kills) {
    return Object.values(kills).reduce((a, b) => a + b, 0);
}

function isPeacefulRun(stats, totalKills) {
    return totalKills === 0
        && !stats.drankBeer
        && !stats.tookDrugs
        && !stats.brokeDoor
        && stats.stoleItems === 0
        && !stats.arsonCount
        && !stats.sexOffenseCount;
}

function formatMs(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${String(rem).padStart(2, '0')}`;
}

function computeYears(stats) {
    let y = 0;
    if (stats.drankBeer)   y += SENTENCES.drankBeer;
    if (stats.tookDrugs)   y += SENTENCES.tookDrugs;
    if (stats.brokeDoor)   y += SENTENCES.brokeDoor;
    y += stats.stoleItems * SENTENCES.theft;
    y += (stats.arsonCount || 0) * SENTENCES.arson;
    y += (stats.sexOffenseCount || 0) * SENTENCES.sexOffense;
    y += stats.kills.dog        * SENTENCES.dog;
    y += stats.kills.child      * SENTENCES.child;
    y += stats.kills.civilian   * SENTENCES.civilian;
    y += stats.kills.cop        * SENTENCES.cop;
    y += stats.kills.choir      * SENTENCES.choir;
    y += stats.kills.boss       * SENTENCES.boss;
    y += (stats.kills.towelWoman || 0) * SENTENCES.towelWoman;
    return y;
}

/**
 * Returns the crimes committed, split into two thematic columns so the
 * verdict screen fits all lines even on full-rampage runs:
 *   - petty: non-murder offences (intox, theft, arson, sex offense, B&E)
 *   - violent: homicides, grouped by victim type
 * Empty runs get a single filler line in `petty`.
 */
function buildCrimesList(stats) {
    const petty = [];
    const violent = [];
    if (stats.drankBeer)  petty.push('- Public intoxication');
    if (stats.tookDrugs)  petty.push('- Possession of narcotics');
    if (stats.brokeDoor)  petty.push('- Breaking and entering');
    if (stats.stoleItems) petty.push(`- Theft of firearms (${stats.stoleItems} ct)`);
    if (stats.arsonCount) petty.push(`- Arson (${stats.arsonCount} ct)`);
    if (stats.sexOffenseCount) petty.push(`- Sex offense, locker room (${stats.sexOffenseCount} ct)`);

    if (stats.kills.dog)        violent.push(`- Killing a dog`);
    if (stats.kills.child)      violent.push(`- Murdering ${stats.kills.child} child${stats.kills.child > 1 ? 'ren' : ''}`);
    if (stats.kills.civilian)   violent.push(`- Murdering ${stats.kills.civilian} civilian${stats.kills.civilian > 1 ? 's' : ''}`);
    if (stats.kills.cop)        violent.push(`- Killing ${stats.kills.cop} police officer${stats.kills.cop > 1 ? 's' : ''}`);
    if (stats.kills.choir)      violent.push(`- Murdering ${stats.kills.choir} choir member${stats.kills.choir > 1 ? 's' : ''}`);
    if (stats.kills.boss)       violent.push(`- Murdering the local pastor`);
    if (stats.kills.towelWoman) violent.push(`- Murdering ${stats.kills.towelWoman} wom${stats.kills.towelWoman > 1 ? 'en' : 'an'} in a towel`);

    if (petty.length === 0 && violent.length === 0) {
        petty.push('- ...honestly, nothing. We just don\'t like your vibe.');
    }
    return { petty, violent };
}
