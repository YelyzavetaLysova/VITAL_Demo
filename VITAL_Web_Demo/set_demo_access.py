"""Manually enable or disable the published demo extensions."""
import argparse
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("state", choices=["on", "off"])
args = parser.parse_args()
config = Path(__file__).resolve().parent / "backend" / ".env"
if not config.is_file():
    raise SystemExit("backend/.env is missing. No configuration was changed.")
lines = config.read_text().splitlines()
lines = [line for line in lines if line.partition("=")[0].strip().lower() != "demo_extensions_enabled"]
lines.append("DEMO_EXTENSIONS_ENABLED=" + ("true" if args.state == "on" else "false"))
config.write_text("\n".join(lines) + "\n")
config.chmod(0o600)
print("Demo extension access: " + args.state)
print("Run: sudo systemctl restart vital-demo")
