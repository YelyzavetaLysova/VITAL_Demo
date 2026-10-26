"""Install this release into an existing project while preserving local data."""

import shutil
import sys
from pathlib import Path

source = Path(__file__).resolve().parent
project_name = "VITAL_Widgets" if (source / "extension").exists() else "VITAL_Web_Demo"
target = (
    Path(sys.argv[1]).expanduser().resolve()
    if len(sys.argv) > 1
    else Path.home() / "Documents" / project_name
)
if source == target:
    print("This folder already contains the new release. Run python3 start_backend.py.")
    raise SystemExit(0)
if not (target / "backend/app").is_dir():
    raise SystemExit("Choose the existing project folder as the first argument.")
config_file = target / "backend/.env"
old_config = config_file.read_text() if config_file.exists() else ""
old_values = {}
for line in old_config.splitlines():
    if "=" in line and not line.lstrip().startswith("#"):
        key, value = line.split("=", 1)
        old_values[key.strip()] = value.strip()
for path in source.rglob("*"):
    relative = path.relative_to(source)
    if not path.is_file() or any(
        part
        in {
            ".venv",
            "data",
            "node_modules",
            "__pycache__",
            ".pytest_cache",
            ".git",
            "safari-app",
        }
        for part in relative.parts
    ):
        continue
    if relative.as_posix() == "backend/.env":
        continue
    destination = target / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(path, destination)
new_values = {}
for line in (source / "backend/.env").read_text().splitlines():
    if "=" in line and not line.lstrip().startswith("#"):
        key, value = line.split("=", 1)
        new_values[key.strip()] = value.strip()
# Keep every setting already used by the deployment, including its current API key.
new_values.update(old_values)
if old_config:
    config_file.with_name(".env.before-v1_11").write_text(old_config)
config_file.write_text(
    "\n".join(key + "=" + value for key, value in new_values.items()) + "\n"
)
config_file.chmod(0o600)
print(f"Updated {target}. Existing .venv and data preserved.")
print("Restart the backend, then reload the extension and article page.")
