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
from urllib.parse import quote_plus

from flask import Flask, Response, abort, jsonify, request, send_from_directory
from pydantic import BaseModel, Field, ValidationError, field_validator

from . import og
from .store import ScoreStore

ROOT = Path(__file__).resolve().parent.parent.parent
FRONTEND_DIR = ROOT / "frontend"
DB_PATH = Path(os.environ.get("BAM_DB", ROOT / "backend" / "data" / "scores.db"))

# When the app is served from a subpath (e.g. app.is/bam) we need to inject
# the prefix into asset URLs in the templated HTML (CSS/JS hrefs etc.).
# Note: Passenger forwards the prefix as SCRIPT_NAME, so request.url_root
# *already* includes it — don't append URL_PREFIX to that.
URL_PREFIX = os.environ.get("BAM_URL_PREFIX", "").rstrip("/")

NAME_RE = re.compile(r"^[A-Za-z0-9 _\-\.!?']{1,16}$")

DEFAULT_TITLE = "B.A.M. — Brave America Man"
DEFAULT_DESC = (
    "8-bit sidescroller. Pickup truck broke down in a strange town. "
    "Lock and load, soldier. Hoo-rah!"
)
DEFAULT_OG_IMAGE_PATH = "/og-default"


def _clean_name(name: str) -> str:
    cleaned = "".join(c for c in name[:16] if c.isalnum() or c in " _-.!?'").strip()
    return cleaned or "CHAMPION"


def _clean_score(score: str) -> str:
    return re.sub(r"[^0-9:]", "", score)[:10] or "?"


def _render_index(
    *,
    base_url: str,
    score: str | None,
    name: str | None,
    ending: str | None,
) -> str:
    """Template frontend/index.html, injecting social-preview meta tags."""
    tpl = (FRONTEND_DIR / "index.html").read_text(encoding="utf-8")
    site_root = base_url if base_url.endswith("/") else base_url + "/"

    if score and name:
        clean_name = _clean_name(name)
        clean_score = _clean_score(score)
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
        # quote_plus matches browser URLSearchParams (space → "+"), so the
        # canonical og:url byte-matches the URL the share button actually
        # opens. Mixing "%20" (quote) with "+" (URLSearchParams) produced a
        # canonical URL that diverged from the shared URL, tripping a 403
        # on the Facebook scrape when names contained spaces.
        params = (
            f"s={quote_plus(clean_score, safe=':')}"
            f"&n={quote_plus(clean_name)}"
            f"&t={'win' if ending == 'win' else 'crime'}"
        )
        og_image = f"{site_root}og?{params}"
        # Unique canonical URL per share — Facebook dedupes its OG cache by
        # og:url, so if every share pointed to site_root the first scrape
        # would freeze the preview (title/image/description) for all later
        # shares of the same site.
        og_url = f"{site_root}?{params}"
    else:
        title = DEFAULT_TITLE
        desc = DEFAULT_DESC
        og_image = site_root + DEFAULT_OG_IMAGE_PATH.lstrip("/")
        og_url = site_root

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

    @app.get("/og-default")
    def og_default():
        return Response(
            og.render_default(),
            mimetype="image/png",
            headers={"Cache-Control": "public, max-age=86400, immutable"},
        )

    @app.get("/og")
    def og_image():
        name = _clean_name(request.args.get("n", ""))
        score = _clean_score(request.args.get("s", ""))
        ending = "win" if request.args.get("t") == "win" else "crime"
        # Score doubles as years for crime runs (the API's `years` value is
        # what the share URL puts in `s`); for wins the value is "m:ss" so
        # we treat it as 0 for base-image bucketing.
        try:
            years = int(score) if ending == "crime" else 0
        except ValueError:
            years = 0
        png = og.render(name=name, score=score, ending=ending, years=years)
        return Response(
            png,
            mimetype="image/png",
            headers={"Cache-Control": "public, max-age=86400, immutable"},
        )

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
