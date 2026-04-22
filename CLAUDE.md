# bam / Arena

Browser game built on [KAPLAY](https://kaplayjs.com/) (maintained Kaboom.js fork), pinned to `kaplay@3001.0.19` (see [frontend/js/main.js](frontend/js/main.js)).

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
