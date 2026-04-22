"""SQLite-backed scoreboard store.

Thin facade around sqlite3 so we can swap storage later if needed.
"""
from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Score:
    id: int
    name: str
    ending: str  # 'win' | 'crime'
    kills: int
    time_ms: int
    health: int
    years: int  # prison years; 0 for win endings
    created_at: int

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "ending": self.ending,
            "kills": self.kills,
            "time_ms": self.time_ms,
            "health": self.health,
            "years": self.years,
            "created_at": self.created_at,
        }


class ScoreStore:
    """Persistent high-score table.

    'win' endings rank by fastest time. 'crime' endings rank by most years
    in prison (we're satirical: the worse you did, the higher you 'score').
    The top-N list returns both, interleaved by ranking within each bucket.
    """

    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_schema(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS scores (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    name       TEXT    NOT NULL,
                    ending     TEXT    NOT NULL CHECK (ending IN ('win','crime')),
                    kills      INTEGER NOT NULL DEFAULT 0,
                    time_ms    INTEGER NOT NULL,
                    health     INTEGER NOT NULL,
                    years      INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_scores_win  ON scores(ending, time_ms)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_scores_crime ON scores(ending, years DESC)")

    def add(
        self,
        *,
        name: str,
        ending: str,
        kills: int,
        time_ms: int,
        health: int,
        years: int,
    ) -> Score:
        now = int(time.time())
        with self._connect() as conn:
            cur = conn.execute(
                """
                INSERT INTO scores (name, ending, kills, time_ms, health, years, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (name, ending, kills, time_ms, health, years, now),
            )
            row_id = cur.lastrowid
        return Score(
            id=row_id,
            name=name,
            ending=ending,
            kills=kills,
            time_ms=time_ms,
            health=health,
            years=years,
            created_at=now,
        )

    def top(self, limit: int = 50) -> list[Score]:
        """Return top entries: wins ranked by fastest time, crimes by most years.

        Output is a single merged list ordered so wins come first (they're the
        'real' goal of the game), followed by notable crime sprees.
        """
        half = max(1, limit // 2)
        with self._connect() as conn:
            wins = conn.execute(
                """
                SELECT * FROM scores
                WHERE ending = 'win'
                ORDER BY time_ms ASC, created_at ASC
                LIMIT ?
                """,
                (half,),
            ).fetchall()
            crimes = conn.execute(
                """
                SELECT * FROM scores
                WHERE ending = 'crime'
                ORDER BY years DESC, kills DESC, created_at ASC
                LIMIT ?
                """,
                (limit - len(wins),),
            ).fetchall()
        rows = list(wins) + list(crimes)
        return [
            Score(
                id=r["id"],
                name=r["name"],
                ending=r["ending"],
                kills=r["kills"],
                time_ms=r["time_ms"],
                health=r["health"],
                years=r["years"],
                created_at=r["created_at"],
            )
            for r in rows
        ]
