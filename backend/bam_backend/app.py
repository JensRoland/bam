"""FastAPI app — serves the static frontend and the scoreboard API."""
from __future__ import annotations

import html
import os
import re
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from .store import ScoreStore

ROOT = Path(__file__).resolve().parent.parent.parent
FRONTEND_DIR = ROOT / "frontend"
DB_PATH = Path(os.environ.get("BAM_DB", ROOT / "backend" / "data" / "scores.db"))

NAME_RE = re.compile(r"^[A-Za-z0-9 _\-\.!?']{1,16}$")

DEFAULT_TITLE = "B.A.M. — Brave America Man"
DEFAULT_DESC = (
    "8-bit sidescroller. Pickup truck broke down in a strange town. "
    "Lock and load, soldier. Hoo-rah!"
)
# A static OG image lives at /og.png (generated separately). If missing,
# the social preview falls back to the title + description only.
OG_IMAGE_PATH = "/og.png"


def _render_index(
    *,
    base_url: str,
    score: str | None,
    name: str | None,
    ending: str | None,
) -> str:
    """Template frontend/index.html, injecting social-preview meta tags.

    Share links look like ``/?s=438&n=JENS&t=crime``. We inject a title like
    "JENS scored 438 on B.A.M." — deliberately free of the words 'years',
    'prison' or 'crime' so the surprise lands when the friend actually plays.
    """
    tpl = (FRONTEND_DIR / "index.html").read_text(encoding="utf-8")

    if score and name:
        # Sanitize name: same allow-list as score submission, truncated.
        clean_name = name[:16]
        clean_name = "".join(c for c in clean_name if c.isalnum() or c in " _-.!?'")
        clean_name = clean_name.strip() or "CHAMPION"
        # Keep score compact and numeric-ish
        clean_score = re.sub(r"[^0-9:]", "", score)[:10] or "?"
        if ending == "win":
            title = f"{clean_name} beat B.A.M. in {clean_score}"
            desc = (
                f"{clean_name} just ran BRAVE AMERICA MAN in {clean_score}. "
                "Think you can top that, soldier? Hoo-rah! 🇺🇸"
            )
        else:
            title = f"{clean_name} scored {clean_score} on B.A.M."
            desc = (
                f"{clean_name} just hit {clean_score} on BRAVE AMERICA MAN. "
                "Your turn, champion. 🇺🇸💪"
            )
    else:
        title = DEFAULT_TITLE
        desc = DEFAULT_DESC

    og_url = base_url.rstrip("/") + "/"
    og_image = og_url + OG_IMAGE_PATH.lstrip("/")

    return (
        tpl
        .replace("{{og_title}}", html.escape(title, quote=True))
        .replace("{{og_description}}", html.escape(desc, quote=True))
        .replace("{{og_url}}", html.escape(og_url, quote=True))
        .replace("{{og_image}}", html.escape(og_image, quote=True))
    )


class ScoreSubmit(BaseModel):
    name: str = Field(min_length=1, max_length=16)
    ending: str
    kills: int = Field(ge=0, le=500)
    time_ms: int = Field(ge=0, le=60 * 60 * 1000)  # cap at 1 hour
    health: int = Field(ge=0, le=100)
    years: int = Field(ge=0, le=100_000)

    @field_validator("name")
    @classmethod
    def _valid_name(cls, v: str) -> str:
        v = v.strip()
        if not NAME_RE.match(v):
            raise ValueError("name must be 1-16 chars, letters/numbers/space/_-.!?'")
        return v

    @field_validator("ending")
    @classmethod
    def _valid_ending(cls, v: str) -> str:
        if v not in ("win", "crime"):
            raise ValueError("ending must be 'win' or 'crime'")
        return v


def create_app() -> FastAPI:
    app = FastAPI(title="B.A.M. Scoreboard", version="0.1.0")
    store = ScoreStore(DB_PATH)

    @app.get("/api/health")
    def health() -> dict:
        return {"ok": True}

    @app.get("/api/scores/top")
    def top_scores(limit: int = 50) -> dict:
        limit = max(1, min(50, limit))
        return {"scores": [s.to_dict() for s in store.top(limit)]}

    @app.post("/api/scores")
    def submit_score(payload: ScoreSubmit) -> dict:
        try:
            score = store.add(
                name=payload.name,
                ending=payload.ending,
                kills=payload.kills,
                time_ms=payload.time_ms,
                health=payload.health,
                years=payload.years,
            )
        except Exception as e:  # pragma: no cover
            raise HTTPException(500, f"could not record score: {e}") from e
        return {"score": score.to_dict()}

    # Serve static frontend from '/'. Static mount must come last so /api/* wins.
    if FRONTEND_DIR.exists():
        app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

        @app.get("/", response_class=HTMLResponse)
        def root(request: Request, s: str | None = None, n: str | None = None, t: str | None = None) -> HTMLResponse:
            # base_url already ends with '/' per Starlette
            base = str(request.base_url)
            return HTMLResponse(_render_index(base_url=base, score=s, name=n, ending=t))

        @app.get("/{path:path}", response_model=None)
        def spa(path: str, request: Request):
            target = FRONTEND_DIR / path
            if target.is_file():
                return FileResponse(target)
            # SPA fallback — also render templated HTML so deep links work.
            base = str(request.base_url)
            return HTMLResponse(_render_index(base_url=base, score=None, name=None, ending=None))

    return app


app = create_app()
