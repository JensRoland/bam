# bam / Arena

Browser game built on [KAPLAY](https://kaplayjs.com/) (maintained Kaboom.js fork), pinned to `kaplay@3001.0.19` (see [frontend/js/main.js](frontend/js/main.js)).

## Core design invariant: BAM is the aggressor

**A pacifist playthrough must always be possible.** If the player walks from the crashed truck to the church without committing any crime, every single NPC stays friendly and nobody lays a hand on BAM. This is absolute — it's the whole point of the game. The shock of the crime ending only lands because the player chose to start the violence.

When spawning an NPC, the default mode is `peaceful` (or `wander` for ambient dogs/children). **Do not** set `mode: 'hostile'` on spawn just to make a section feel tense — that breaks the invariant. Tension should come from environmental hazards (holes, fences, brambles), the *threat* of armed NPCs waking up if BAM slips, and the player's own temptation to take weapons / drugs / shortcuts.

There are only three exceptions in the entire game where NPCs start hostile, and each one exists because **entering the area is itself the crime**:

1. **House interior** — entering requires smashing the front door (breaking and entering). The father and mother defend their home.
2. **Bank interior** — stepping inside with a **firearm** equipped is open carry in a bank (handgun, shotgun, smg, taser, flamethrower, grenade). Fists, bat, and molotovs don't trip this. Enter empty-handed and the guards stay peaceful; enter armed and they open fire. BAM's own handgun sits on the ground by the crashed truck at game start — picking it up is not theft, but it *does* arm him for this check.
3. **Pool ladies' changing room** — entering is a sex offense (one count per woman in the room, tallied even if BAM just turns around and leaves). The towel women attack on sight.

Everywhere else — outside, gun shop, church interior, pool men's room, scoreboard — NPCs are `peaceful` or `wander`. Cops and mallCops patrol with guns but **do not fire unless BAM has already killed someone**; a single human kill trips `run.globalAggro` and from that point on every surviving law-enforcement NPC on the map wakes up.

Aggro propagation that keeps this consistent:
- `aggro(enemy)` — taking a hit flips that enemy hostile
- `spreadAggro(x)` — other non-child enemies within 360 px wake up too
- `globalAggroAll()` — called from `e.onDeath` when `HUMAN_KINDS.has(kind)` is true; sets `run.globalAggro = true` and turns every surviving adult hostile forever

If you're adding a new NPC, new scene, or new interaction: start peaceful, and let the player's actions drive the violence. If you think you need hostile-on-spawn, the bar is "entering this area is a tracked crime in `stats`." If there's no crime, they stay peaceful.

## Kaplay gotchas

Read this before touching anything that spawns game objects — the same bugs keep cropping up.

### `lifespan` requires `opacity`

In kaplay 3001.x, `lifespan()` fades the object out before destroying it, so it **requires the `opacity` component on the same object**. Without it you get:

```
Error: Component "lifespan" requires component "opacity"
```

Rule: any `k.add([...])` that includes `k.lifespan(t)` must also include `k.opacity(N)` (typically `k.opacity(1)`, or `k.opacity(0)` for invisible hitboxes like the melee attack at [scenes.js:270](frontend/js/scenes.js#L270)).

This has regressed multiple times on bullet/pellet/dart/flame/droplet spawners. If you're adding a new projectile or particle, pair the two components together as a unit.

### Component order in `k.add([...])`

Components are applied in array order and some depend on others. Safe ordering used throughout [scenes.js](frontend/js/scenes.js):

1. Visual: `sprite` / `rect` / `text`
2. Transform: `pos`, `anchor`, `scale`, `z`
3. Physics / interaction: `area`, `body`
4. Lifecycle: `offscreen`, `opacity`, `lifespan`
5. Tags (strings) and data objects last

### Scene re-registration

`registerScenes(k)` is called once from [main.js:34](frontend/js/main.js#L34). Don't call `k.scene(...)` outside `registerScenes` — hot paths assume scenes exist at boot.

### Asset paths

Sprites are loaded by string key (e.g. `'flash'`, `'bullet'`, `'taserDart'`). When adding a new visual, confirm the sprite has been loaded in the asset-loading block before referencing it — kaplay won't warn, it just renders nothing.

## Run

See [README.md](README.md) for setup.
