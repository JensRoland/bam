"""Entry point: `uv run python -m bam_backend`."""
from __future__ import annotations

import os

from .app import app


def main() -> None:
    host = os.environ.get("BAM_HOST", "127.0.0.1")
    port = int(os.environ.get("BAM_PORT", "8000"))
    app.run(host=host, port=port, debug=False)


if __name__ == "__main__":
    main()
