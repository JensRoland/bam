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
    width: 5600,
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

/** Crime sentencing (years of prison per act). Tuned for satire. */
const SENTENCES = {
    brokeDoor: 2,        // breaking and entering
    drankBeer: 0,        // not a crime on its own
    tookDrugs: 1,        // controlled substance
    theft: 1,            // handgun / ammo / cap / bat
    arson: 15,           // per molotov thrown
    dog: 1,
    child: 99,
    civilian: 25,
    cop: 50,
    choir: 25,
    boss: 50,
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

function createRun() {
    return {
        /** Set once on first entry into the game scene. */
        startTime: null,
        player: {
            health: 100, maxHealth: 100,
            // All weapon IDs — fists and bat are melee (ammo=null), handgun and
            // molotov use their own per-weapon counter. Unified so the HUD and
            // the single-button "use" handler just look up the current slot.
            weapons: ['fists', 'handgun', 'molotov'],
            weaponIdx: 1,
            ammo: {
                fists: null, bat: null,
                handgun: 6, shotgun: 0, smg: 0, taser: 0,
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
            kills: { dog: 0, child: 0, civilian: 0, cop: 0, choir: 0, boss: 0 },
            drankBeer: false,
            tookDrugs: false,
            brokeDoor: false,
            stoleItems: 0,
            arsonCount: 0,
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
            let targetVx = 0;
            if (leftHeld)  { targetVx -= WORLD.playerSpeed; player.facing = -1; }
            if (rightHeld) { targetVx += WORLD.playerSpeed; player.facing =  1; }
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

    // Use current weapon (X, with Z as alias). Fists, bat, handgun and
    // molotov are all "weapons" — a single key triggers whichever is equipped,
    // so the player only ever has to think about what they're holding, not
    // which button to press.
    k.onKeyPress('x', () => useWeapon());
    // SMG fires continuously while the key is held; other weapons stay
    // press-to-fire (their own cooldown guards block re-entry anyway).
    k.onKeyDown('x', () => {
        if (player.weapons[player.weaponIdx] === 'smg') useWeapon();
    });

    // Cycle weapon (C)
    k.onKeyPress('c', () => {
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
        if (enemy.kind === 'child') return;
        enemy.state = 'hostile';
    }

    function spreadAggro(x) {
        k.get('enemy').forEach((e) => {
            if (Math.abs(e.pos.x - x) < 360 && e.kind !== 'child') {
                e.state = 'hostile';
            }
        });
    }

    /** Every surviving non-child enemy turns hostile, regardless of distance. */
    function globalAggroAll() {
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
    };

    /** Civilian kinds — murdering any of these triggers global aggro. */
    const HUMAN_KINDS = new Set(['father', 'mother', 'scout', 'cop', 'mallCop', 'boss', 'choir', 'swat']);

    /** @param {string} kind @param {number} x @param {'peaceful'|'wander'|'hostile'} mode @param {string} [id] */
    function spawnEnemy(kind, x, mode, id) {
        if (id && run.killedEnemies.has(id)) return null;
        const def = /** @type {any} */ (enemyDefs)[kind];
        // Honour the persistent global aggro flag — any enemy spawned after a
        // human has been murdered starts hostile, even if we re-enter the
        // scene from the house interior.
        if (run.globalAggro && kind !== 'child' && mode !== 'hostile') mode = 'hostile';
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
                id: id || null,
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

            // Ranged attack — cops and SWAT. Cops snap off single rounds
            // ~every 1.2 s; SWAT fire a 3-round SMG burst ~every 1.8 s.
            if ((e.kind === 'cop' || e.kind === 'swat') && e.state === 'hostile' && dist < 440) {
                const fireCd = e.kind === 'swat' ? 1.8 : 1.2;
                if (k.time() - e.lastShot >= fireCd) {
                    e.lastShot = k.time();
                    const bDir = e.pos.x < p.pos.x ? 1 : -1;
                    const burst = e.kind === 'swat' ? 3 : 1;
                    const perBulletDmg = e.kind === 'swat' ? Math.floor(e.damage / 2) : e.damage;
                    for (let i = 0; i < burst; i++) {
                        k.wait(i * 0.08, () => {
                            if (!e.exists() || k.time() < e.stunUntil) return;
                            const b = k.add([
                                k.sprite('bullet', { flipX: bDir < 0 }),
                                k.pos(e.pos.x + bDir * 20, e.pos.y + 16 + (Math.random() - 0.5) * 4),
                                k.anchor('center'),
                                k.offscreen({ destroy: true, distance: 400 }),
                                k.area({ collisionIgnore: ['enemy'] }),
                                'enemyBullet',
                                { damage: perBulletDmg, vx: bDir * WORLD.bulletSpeed * 0.85 },
                            ]);
                            b.onUpdate(() => { b.pos.x += b.vx * k.dt(); });
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
            if (e.id) run.killedEnemies.add(e.id);
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
            if (kind === 'cop' && !run.killedEnemies.has('swat-response-' + (e.id || k.time()))) {
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
            { kind, baseY: y, id: id || null, curPickupSprite: initialSprite, age: 0, ttl },
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
        if (item.id) run.consumedPickups.add(item.id);
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
    k.add([k.rect(164, 20), k.pos(12, 12), k.color(20, 20, 20), k.fixed(), k.z(100)]);
    const hpFill = k.add([k.rect(160, 16), k.pos(14, 14), k.color(211, 47, 47), k.fixed(), k.z(101)]);
    hpFill.onUpdate(() => {
        hpFill.width = 160 * Math.max(0, player.health / player.maxHealth);
        if (k.time() < player.invulnUntil && Math.floor(k.time() * 8) % 2 === 0) {
            hpFill.color = k.rgb(255, 255, 255);
        } else {
            hpFill.color = k.rgb(211, 47, 47);
        }
    });
    k.add([k.text('HP', { size: 24 }), k.pos(184, 14), k.fixed(), k.color(255, 255, 255), k.z(101)]);

    // Intoxication bar — tracks the drunk / high window. Label lies in insane
    // mode: the player thinks it's an "ENERGY" meter, the truth shows through
    // as "INTOX" when serene. Syringe high bumps the bar to full (purple tint).
    k.add([k.rect(164, 16), k.pos(12, 36), k.color(20, 20, 20), k.fixed(), k.z(100)]);
    const intoxFill = k.add([k.rect(160, 12), k.pos(14, 38), k.color(230, 120, 20), k.fixed(), k.z(101)]);
    intoxFill.onUpdate(() => {
        const drunkLeft = Math.max(0, player.intoxicatedUntil - k.time());
        const highLeft  = Math.max(0, player.rageUntil - k.time());
        const level = Math.max(
            Math.min(1, drunkLeft / 20),
            highLeft > 0 ? Math.min(1, highLeft / 25) : 0,
        );
        intoxFill.width = 160 * level;
        intoxFill.color = highLeft > 0 ? k.rgb(160, 60, 220) : k.rgb(230, 120, 20);
    });
    const intoxLabel = k.add([k.text('INTOX', { size: 20 }), k.pos(184, 36), k.fixed(), k.color(255, 255, 255), k.z(101)]);
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
    const SLOT_BASE_Y = 60;
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

    const timer = k.add([k.text('0:00', { size: 24 }), k.pos(k.width() - 12, 14), k.anchor('topright'), k.fixed(), k.color(255, 255, 255), k.z(101)]);
    timer.onUpdate(() => {
        const elapsed = k.time() - run.startTime;
        const m = Math.floor(elapsed / 60);
        const s = Math.floor(elapsed % 60);
        timer.text = `${m}:${String(s).padStart(2, '0')}`;
    });

    // Centered below the HUD column so it doesn't collide with HP/INTOX/slots.
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
            k.pos(20, 142 + i * 12),
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
        ['C',   'CYCLE WEAPON'],
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
    // duck into the house and come back out with their HP, ammo, kills, and
    // consumed pickups intact. But the game scene is also how we *restart*
    // after death or the ending — any entry that isn't a house↔game hop has
    // to start with a brand-new run, otherwise the restarted game inherits
    // `player.knockVx` / `player.stunUntil` from the killing blow (causing
    // the player to be shoved in that direction for the first frames), along
    // with 0 HP, used-up pickups, killed enemies, and a pre-broken door.
    if (opts.from !== 'house') run = null;
    if (!run) run = createRun();
    if (run.startTime === null) {
        run.startTime = k.time();
        run.player.intoxicatedUntil = k.time() + 20; // player starts drunk from the crash
    }
    const player = run.player;
    const stats = run.stats;

    // Where does the player drop in? 'fromHouse' puts them back on the porch
    // so they don't immediately re-enter. Default is the start of the level.
    const spawnX = opts.from === 'house' ? 1860 : 120;
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

    // ----- Ground (single wide collision strip, decorated with tiles) -------
    k.add([
        k.rect(WORLD.width + 800, 160),
        k.pos(-400, WORLD.groundY),
        k.color(110, 74, 40),
        k.area(),
        k.body({ isStatic: true }),
        'ground',
        k.z(-20),
    ]);
    // Decorative grass/road tiles on top (tile sprite is now 32×32)
    for (let x = -400; x < WORLD.width + 400; x += 32) {
        const inRoad = (x > 120 && x < 520) || (x > 3400 && x < 4000);
        k.add([
            k.sprite(inRoad ? 'road' : 'ground'),
            k.pos(x, WORLD.groundY),
            k.z(-19),
        ]);
    }

    // Trees + bushes
    for (const [x, y] of [[80, 380], [2500, 380], [4500, 380]]) {
        k.add([k.sprite('tree'), k.pos(x, y), k.anchor('bot'), k.z(-10)]);
    }
    for (const x of [360, 680, 1440, 2840, 3240, 4000, 4360]) {
        k.add([k.sprite('bush'), k.pos(x, WORLD.groundY + 4), k.anchor('bot'), k.z(-5)]);
    }

    // Broken pickup truck (spawn area context)
    k.add([k.sprite('truck'), k.pos(20, WORLD.groundY + 4), k.anchor('bot'), k.z(-6)]);

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

    // ----- Church (end of level) --------------------------------------------
    const church = k.add([
        k.sprite('church'),
        k.pos(4840, WORLD.groundY + 4),
        k.anchor('bot'),
        k.z(-4),
    ]);

    // End trigger — walking into the church interior finishes the level.
    k.add([
        k.rect(40, 96),
        k.pos(4940, WORLD.groundY - 92),
        k.opacity(0),
        k.area(),
        'end',
    ]);

    // ----- Player, input, HUD, factories -----------------------------------
    // Everything the player-control layer needs lives in the shared context.
    // `p` is the player entity; the four helpers spawn/interact with level
    // content in a way that respects cross-scene persistence (`run.*`).
    const { p, spawnFire, spawnEnemy, spawnPickup, spawnPoof, consumePickup, nearestInteractable } =
        buildPlayingContext({ spawnX, minX: 0, maxX: WORLD.width - 32,
            spawnFireAt: (x) => spawnFire(x, WORLD.groundY) });

    // Camera follow — horizontal chase; fixed y that keeps groundY near the
    // bottom of the 288-tall viewport (ground would be off-screen at the
    // default camY=144 now that groundY has doubled to 444).
    p.onUpdate(() => {
        const camX = Math.max(k.width() / 2, Math.min(WORLD.width - k.width() / 2, p.pos.x));
        k.setCamPos(camX, WORLD.groundY - 78);
    });

    // ----- Pickups ----------------------------------------------------------
    // The starting handgun comes from the truck, so we don't drop one on the
    // ground. Everything else is theft (or worse). Stable IDs let consumed
    // pickups stay gone when we re-enter the scene from the house interior.
    spawnPickup('beer',          440, WORLD.groundY - 12, 'beer-road');
    spawnPickup('shotgun',       760, WORLD.groundY - 12, 'shotgun-380');
    spawnPickup('ammo',          960, WORLD.groundY - 10, 'ammo-480');
    spawnPickup('bat',          1240, WORLD.groundY - 8,  'bat-620');
    spawnPickup('taser',        1640, WORLD.groundY - 12, 'taser-820');
    spawnPickup('ammo',         2240, WORLD.groundY - 10, 'ammo-1120');
    spawnPickup('grenade',      2500, WORLD.groundY - 12, 'grenade-1250');
    spawnPickup('cap',          3100, WORLD.groundY - 6,  'cap-1550');
    spawnPickup('flamethrower', 3600, WORLD.groundY - 12, 'flamethrower-1800');
    spawnPickup('ammo',         4000, WORLD.groundY - 10, 'ammo-2000');

    // ----- Enemies (peaceful by default; IDs persist kills across scenes) ---
    spawnEnemy('dog',     840, 'wander',   'dog-420');
    spawnEnemy('child',  1400, 'wander',   'child-700');
    spawnEnemy('child',  2560, 'wander',   'child-1280');
    spawnEnemy('mother', 2760, 'peaceful', 'mother-1380');
    spawnEnemy('dog',    3000, 'wander',   'dog-1500');
    spawnEnemy('scout',  3400, 'peaceful', 'scout-1700');
    spawnEnemy('cop',    3720, 'peaceful', 'cop-1860');
    spawnEnemy('mallCop',4100, 'peaceful', 'mallCop-2050');
    spawnEnemy('choir',  5120, 'peaceful', 'choir-2560');
    spawnEnemy('choir',  5160, 'peaceful', 'choir-2580');
    spawnEnemy('choir',  5200, 'peaceful', 'choir-2600');
    spawnEnemy('boss',   5360, 'peaceful', 'boss-2680');

    // ----- Scene-specific interactions --------------------------------------
    // Down: grab a pickup if one is under foot, otherwise step into the house
    // if the front door is already broken.
    k.onKeyPress(['down', 's'], () => {
        const item = nearestInteractable(44, 72);
        if (item) { consumePickup(item); return; }
        if (house.broken) {
            const dx = Math.abs(DOOR_CENTER_X - (p.pos.x + 16));
            if (dx < 80) k.go('house');
        }
    });

    // Door is damaged by melee swings and bullets (the house block removes
    // the collider + swaps to the broken sprite inside door.onDeath).
    k.onCollide('playerMelee', 'door', (m, d) => { d.hurt(m.damage); });
    k.onCollide('bullet',      'door', (b, d) => { d.hurt(b.damage); k.destroy(b); });

    // Reaching the church ends the run.
    p.onCollide('end', () => k.go('ending', {
        stats,
        player: run.player,
        runTimeMs: Math.floor((k.time() - run.startTime) * 1000),
    }));

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
    const stats = run.stats;

    // Warm brown backdrop behind the tiled wall/floor.
    k.add([k.rect(k.width(), k.height()), k.color(56, 34, 22), k.fixed(), k.z(-100)]);

    // Back wall tiles (32×32 now, repeated across the playable width).
    // Start from the top of the viewport (camY − 144 = groundY − 222) so the
    // wall fills the visible room height without rendering tiles offscreen.
    for (let x = 0; x < k.width(); x += 32) {
        for (let y = WORLD.groundY - 224; y < WORLD.groundY; y += 32) {
            k.add([k.sprite('wallInt'), k.pos(x, y), k.z(-50)]);
        }
    }

    // Floor strip (decorative tiles sitting on top of the collision rect).
    for (let x = 0; x < k.width(); x += 32) {
        k.add([k.sprite('floorInt'), k.pos(x, WORLD.groundY), k.z(-19)]);
    }

    // Solid ground collider (same pattern as the outside scene).
    k.add([
        k.rect(k.width() + 80, 160),
        k.pos(-40, WORLD.groundY),
        k.color(56, 34, 22),
        k.opacity(0),
        k.area(),
        k.body({ isStatic: true }),
        'ground',
        k.z(-20),
    ]);

    // Decor: cabinet on the right (next to the syringe), table center-left.
    k.add([k.sprite('cabinet'), k.pos(k.width() - 60, WORLD.groundY + 4), k.anchor('bot'), k.z(-10)]);
    k.add([k.sprite('table'),   k.pos(k.width() / 2 + 20, WORLD.groundY + 4), k.anchor('bot'), k.z(-10)]);

    // Left-side exit door (painted) + invisible trigger in front of it.
    k.add([k.sprite('exitDoor'), k.pos(60, WORLD.groundY + 4), k.anchor('bot'), k.z(-4)]);
    k.add([
        k.rect(40, 88),
        k.pos(30, WORLD.groundY - 88),
        k.opacity(0),
        k.area(),
        'exit',
    ]);
    // Hovering prompt above the door.
    const exitHint = k.add([
        k.text('← EXIT', { size: 20 }),
        k.pos(60, WORLD.groundY - 108),
        k.anchor('center'),
        k.color(255, 240, 80),
        k.z(50),
    ]);
    exitHint.onUpdate(() => {
        exitHint.pos.y = WORLD.groundY - 108 + Math.sin(k.time() * 5) * 3;
    });

    // Shared player context — spawn just inside the door so the player
    // doesn't immediately cross the exit trigger on entry.
    const { p, spawnEnemy, spawnPickup, consumePickup, nearestInteractable } =
        buildPlayingContext({ spawnX: 110, minX: 40, maxX: k.width() - 40 });

    // Fixed interior camera — the room fits on one screen.
    k.setCamPos(k.width() / 2, WORLD.groundY - 78);

    // Inhabitants + the syringe next to the cabinet. Enemies spaced deep
    // in the room so the first hit doesn't knock BAM through the exit.
    spawnEnemy('father',  300, 'hostile', 'father-house');
    spawnEnemy('mother',  400, 'hostile', 'mother-house');
    spawnPickup('syringe', k.width() - 80, WORLD.groundY - 8, 'syringe-house');

    // Down grabs whatever pickup is under foot (no door logic in here — the
    // exit trigger uses onCollide instead).
    k.onKeyPress(['down', 's'], () => {
        const item = nearestInteractable(44, 72);
        if (item) consumePickup(item);
    });

    // Walking into the exit trigger drops the player back on the porch.
    p.onCollide('exit', () => k.go('game', { from: 'house' }));
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
    k.setCamPos(k.width() / 2, WORLD.groundY - 78);

    const debugKinds = ['dog', 'child', 'father', 'mother', 'scout', 'cop', 'mallCop', 'boss', 'choir', 'swat'];
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
        // Crimes list
        const crimes = buildCrimesList(stats);
        crimes.forEach((ln, i) => {
            k.add([
                k.text(ln, { size: 13 }),
                k.pos(40, 92 + i * 12),
                k.color(220, 220, 220),
            ]);
        });
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
                k.pos(k.width() / 2, k.height() - 54),
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
        && !stats.arsonCount;
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
    y += stats.kills.dog      * SENTENCES.dog;
    y += stats.kills.child    * SENTENCES.child;
    y += stats.kills.civilian * SENTENCES.civilian;
    y += stats.kills.cop      * SENTENCES.cop;
    y += stats.kills.choir    * SENTENCES.choir;
    y += stats.kills.boss     * SENTENCES.boss;
    return y;
}

function buildCrimesList(stats) {
    const lines = [];
    if (stats.drankBeer)  lines.push('- Public intoxication (theft of beer)');
    if (stats.tookDrugs)  lines.push('- Possession of controlled substance');
    if (stats.brokeDoor)  lines.push('- Breaking and entering a private home');
    if (stats.stoleItems) lines.push(`- Theft of firearms / ammunition (${stats.stoleItems} counts)`);
    if (stats.arsonCount) lines.push(`- Arson (${stats.arsonCount} count${stats.arsonCount > 1 ? 's' : ''})`);
    if (stats.kills.dog)      lines.push(`- Killing a dog`);
    if (stats.kills.child)    lines.push(`- Murdering ${stats.kills.child} child${stats.kills.child > 1 ? 'ren' : ''}`);
    if (stats.kills.civilian) lines.push(`- Murdering ${stats.kills.civilian} civilian${stats.kills.civilian > 1 ? 's' : ''}`);
    if (stats.kills.cop)      lines.push(`- Killing ${stats.kills.cop} law enforcement officer${stats.kills.cop > 1 ? 's' : ''}`);
    if (stats.kills.choir)    lines.push(`- Murdering ${stats.kills.choir} choir member${stats.kills.choir > 1 ? 's' : ''}`);
    if (stats.kills.boss)     lines.push(`- Murdering the local pastor`);
    if (lines.length === 0) lines.push('- ...honestly, nothing. We just don\'t like your vibe.');
    return lines;
}
