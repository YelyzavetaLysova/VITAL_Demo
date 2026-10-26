"""Create a local virtual environment, install dependencies and start VITAL."""

import hashlib
import os
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parent
backend = root / "backend"
venv = backend / ".venv"
python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
if not python.exists():
    subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True)
requirements = backend / "requirements.txt"
fingerprint = hashlib.sha256(requirements.read_bytes()).hexdigest()
marker = venv / ".requirements-hash"
if not marker.exists() or marker.read_text() != fingerprint:
    subprocess.run(
        [str(python), "-m", "pip", "install", "-r", str(requirements)], check=True
    )
    marker.write_text(fingerprint)
if not (backend / ".env").exists():
    raise SystemExit("Restore backend/.env from the archive before starting.")
print("Backend: http://127.0.0.1:8765. Keep this terminal open.", flush=True)
subprocess.run(
    [
        str(python),
        "-m",
        "uvicorn",
        "app.demo_main:app",
        "--host",
        "127.0.0.1",
        "--port",
        "8765",
    ],
    cwd=backend,
    check=True,
)
