"""Flask app — serves the static frontend and the scoreboard API.

Flask is native WSGI, so it runs directly under Passenger on cPanel
shared hosting without any ASGI bridge. Pydantic is still used for
request-body validation; everything else is stdlib + Flask.
"""
from __future__ import annotations

import html
import os
import re
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_from_directory
from pydantic import BaseModel, Field, ValidationError, field_validator

from .store import ScoreStore

ROOT = Path(__file__).resolve().parent.parent.parent
FRONTEND_DIR = ROOT / "frontend"
DB_PATH = Path(os.environ.get("BAM_DB", ROOT / "backend" / "data" / "scores.db"))

# When the app is served from a subpath (e.g. app.is/bam) Passenger strips the
# prefix before Flask sees the request, so the backend needs to know it
# explicitly. Used to build asset URLs, share links, and OG meta tags.
URL_PREFIX = os.environ.get("BAM_URL_PREFIX", "").rstrip("/")

NAME_RE = re.compile(r"^[A-Za-z0-9 _\-\.!?']{1,16}$")

DEFAULT_TITLE = "B.A.M. — Brave America Man"
DEFAULT_DESC = (
    "8-bit sidescroller. Pickup truck broke down in a strange town. "
    "Lock and load, soldier. Hoo-rah!"
)
OG_IMAGE_PATH = "/og.png"


def _render_index(
    *,
    base_url: str,
    score: str | None,
    name: str | None,
    ending: str | None,
) -> str:
    """Template frontend/index.html, injecting social-preview meta tags."""
    tpl = (FRONTEND_DIR / "index.html").read_text(encoding="utf-8")

    if score and name:
        clean_name = name[:16]
        clean_name = "".join(c for c in clean_name if c.isalnum() or c in " _-.!?'")
        clean_name = clean_name.strip() or "CHAMPION"
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

    og_url = base_url.rstrip("/") + URL_PREFIX + "/"
    og_image = og_url + OG_IMAGE_PATH.lstrip("/")

    return (
        tpl
        .replace("{{og_title}}", html.escape(title, quote=True))
        .replace("{{og_description}}", html.escape(desc, quote=True))
        .replace("{{og_url}}", html.escape(og_url, quote=True))
        .replace("{{og_image}}", html.escape(og_image, quote=True))
        .replace("{{prefix}}", html.escape(URL_PREFIX, quote=True))
    )


class ScoreSubmit(BaseModel):
    name: str = Field(min_length=1, max_length=16)
    ending: str
    kills: int = Field(ge=0, le=500)
    time_ms: int = Field(ge=0, le=60 * 60 * 1000)
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


def create_app() -> Flask:
    app = Flask(__name__)
    store = ScoreStore(DB_PATH)

    @app.get("/api/health")
    def health():
        return jsonify({"ok": True})

    @app.get("/api/scores/top")
    def top_scores():
        limit = max(1, min(50, request.args.get("limit", 50, type=int)))
        return jsonify({"scores": [s.to_dict() for s in store.top(limit)]})

    @app.post("/api/scores")
    def submit_score():
        try:
            payload = ScoreSubmit.model_validate(request.get_json(silent=True) or {})
        except ValidationError as e:
            return jsonify({"detail": e.errors()}), 422
        score = store.add(
            name=payload.name,
            ending=payload.ending,
            kills=payload.kills,
            time_ms=payload.time_ms,
            health=payload.health,
            years=payload.years,
        )
        return jsonify({"score": score.to_dict()})

    @app.get("/")
    def root():
        html_body = _render_index(
            base_url=request.url_root,
            score=request.args.get("s"),
            name=request.args.get("n"),
            ending=request.args.get("t"),
        )
        return html_body, 200, {"Content-Type": "text/html; charset=utf-8"}

    @app.get("/<path:path>")
    def spa(path: str):
        if not FRONTEND_DIR.exists():
            abort(404)
        target = FRONTEND_DIR / path
        if target.is_file():
            return send_from_directory(FRONTEND_DIR, path)
        # SPA fallback — deep links return the templated index.
        html_body = _render_index(
            base_url=request.url_root,
            score=None,
            name=None,
            ending=None,
        )
        return html_body, 200, {"Content-Type": "text/html; charset=utf-8"}

    return app


app = create_app()
