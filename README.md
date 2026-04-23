# Brave America Man (B.A.M.)

Viral political-satire video game. 8-bit sidescroller that looks like a violent shooter — until you realize the "enemies" are civilians, children, cops and a church choir, and the "score" is your prison sentence.

> *"Man, what a night. Your pickup truck broke down in a strange town. I'll
> bet this place is crawling with liberal snowflakes and illegals. Good thing
> you brought your guns. Lock 'n' load, soldier! Hoo-rah!"*

If you play through without drinking, drugging, breaking into houses or hurting anyone, everyone stays peaceful, the choir sings, and you actually **win**. Shoot the dog? Break down the door? The state is waiting for you.

## Quick start

```bash
# 1. Install backend deps (uv handles the Python env)
cd backend
uv sync

# 2. Run the server — it serves both the API and the static frontend
uv run python -m bam_backend

# 3. Open the game
open http://127.0.0.1:8000
```

Default host/port is `127.0.0.1:8000`. Override with `BAM_HOST` / `BAM_PORT` env vars. The SQLite DB lives at `backend/data/scores.db` — delete it to wipe the scoreboard.

## Controls

| Key                 | Action                     |
|---------------------|----------------------------|
| `←` / `→` / `A` `D` | Move left / right          |
| `↑` / `Space` / `W` | Jump                       |
| `↓` / `S`           | Grab pickup / interact     |
| `X` (or `Z`)        | Use current weapon         |
| `C`                 | Cycle weapon               |
| `Tab` (splash)      | Scoreboard                 |
| `Esc`               | Back to splash             |

### The house

Midway through the level a house blocks the road. It's not part of the peaceful path — smash the front door with `X` and then press `↓` to step inside. The interior is a separate scene with the family and a
syringe on the cabinet; stand in front of the exit door on the left and press `↓` to return to the porch. Health, ammo, collected pickups and killed enemies
all persist across the trip.

### The arena (debug mode)

Open [http://127.0.0.1:8000/?debug](http://127.0.0.1:8000/?debug) to land in a single-screen sandbox for trying weapons, tuning feel, and stress-testing effects. It bypasses the splash, death and ending scenes entirely.

- **Invincible player** — you can't die, so you can sit in the middle of a crowd and test things.
- **Full arsenal** pre-equipped: fists, bat, handgun, shotgun, SMG, taser, flamethrower, grenade, molotov — 500 ammo each. Cycle with `C`, fire with `X`.
- **Enemies stream in** from the right every 0.3–1.5s and march left, hostile on sight. One of every kind rotates through, including SWAT. Cap is 40 concurrent; any that wander off the left edge are culled.
- **Fixed camera** — the arena is one screen wide, no parallax, no level geometry beyond the ground strip.
- **No scoring, no persistence** — runs here don't touch the scoreboard or `run` state. `Esc` returns to the splash.

## Architecture

```text
backend/                 Python 3.12+, FastAPI + SQLite, uv-managed
  bam_backend/
    app.py               API routes + static file serving
    store.py             ScoreStore facade over sqlite3
    __main__.py          uvicorn entry point
  data/scores.db         created on first run

frontend/                static assets, no build step
  index.html
  css/style.css
  js/
    main.js              KAPLAY bootstrap + scene registration
    scenes.js            splash / game / death / ending / scoreboard
    sprites.js           hand-painted pixel-art sprite factory
    api.js               scoreboard fetch/submit wrapper
```

### Sprites

All sprites are painted procedurally from colour rects onto tiny offscreen canvases, then handed to KAPLAY as textures. No external art files, no placeholders — see `frontend/js/sprites.js` for the painter.

### Game engine

[KAPLAY](https://kaplayjs.com/) (maintained fork of Kaboom.js), loaded from CDN pinned at `3001.0.19`. ~60 KB gzipped. Handles sprites, physics, scenes and input; everything else is plain ES modules.

### Scoreboard

- `POST /api/scores` with `{name, ending, kills, time_ms, health, years}` — `ending` must be `win` or `crime`.
- `GET /api/scores/top?limit=50` — wins ranked by fastest time, then crimes ranked by prison sentence (satirical ordering: worst criminals make the wall of shame).

### Viral share

After a run ends and the score is saved, the share overlay opens
automatically. Users can post to X / Facebook / Reddit, copy a share link,
or use the native Web Share sheet on mobile. The share payload is
deliberately **spoiler-free** — it reads "SCORE: 438 on B.A.M., your move
champion" and never mentions the words "prison", "years" or "crime". The
surprise only lands when the friend actually plays.

Share URLs look like `/?s=438&n=JENS&t=crime&ref=share`. When a visitor
arrives at such a URL:

- the backend serves `index.html` with personalized `og:title` /
  `og:description` / `twitter:*` meta tags, so unfurls on social media
  show the sharer's score;
- the splash shows a yellow challenge banner calling the friend out
  ("JENS scored 438. You soldier enough to top it?").

Query-param values are sanitized server-side (allow-list + HTML escape)
before being injected into meta tags to keep the unfurl path XSS-safe.

The share module lives at [frontend/js/share.js](frontend/js/share.js);
templating lives in `_render_index` in
[backend/bam_backend/app.py](backend/bam_backend/app.py).

## Smoke test

No unit tests yet — backend is ~120 lines and the game is visual. Manual round-trip:

```bash
curl -s http://127.0.0.1:8000/api/health
curl -sX POST http://127.0.0.1:8000/api/scores \
  -H 'Content-Type: application/json' \
  -d '{"name":"TEST","ending":"win","kills":0,"time_ms":90000,"health":100,"years":0}'
curl -s http://127.0.0.1:8000/api/scores/top
```

## Deployment notes

- Single process — Flask runs natively as WSGI, so it drops straight into cPanel shared hosting via Passenger, or behind gunicorn / Caddy / Nginx on a tiny VPS. See `passenger_wsgi.py` at the repo root for the cPanel entry point, and `requirements.txt` for the pip-installable deps (cPanel doesn't speak `uv`).
- SQLite is fine for expected load. For higher write volumes, swap `ScoreStore` for a Postgres implementation — that's the only thing that needs to change.
- The frontend is entirely static and can be pushed to a CDN separately if you ever want to split concerns.

## Next steps

- Generate a dynamic OG preview image (`frontend/og.png` is referenced in
  meta tags but not yet rendered). A 1200×630 PNG with the title + the
  sharer's score would lift unfurl CTR significantly.
- Track share events on the backend (`POST /api/scores/{id}/share` to
  increment a counter) so we can see which players drive the most traffic
  and measure the viral coefficient.
- Music + SFX. KAPLAY supports `loadSound` / `play`; a chiptune loop and
  shot/hit/pickup cues would pull weight.
- Mobile / touch controls (on-screen D-pad + action buttons).

## License / distribution

All characters fictional. Commentary, not endorsement.
