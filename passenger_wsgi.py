"""Passenger entry point for cPanel shared hosting.

Flask is native WSGI — no ASGI bridge needed.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "backend"))

from bam_backend.app import app as application  # noqa: E402
