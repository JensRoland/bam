"""Entry point: `uv run python -m bam_backend` (or use the `bam-server` script)."""
from __future__ import annotations

import os

import uvicorn


def main() -> None:
    host = os.environ.get("BAM_HOST", "127.0.0.1")
    port = int(os.environ.get("BAM_PORT", "8000"))
    uvicorn.run("bam_backend.app:app", host=host, port=port, reload=False)


if __name__ == "__main__":
    main()
