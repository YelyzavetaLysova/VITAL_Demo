"""Prepare stable Safari Web Extension resources from the shared extension."""

import json
import shutil
from pathlib import Path


root = Path(__file__).resolve().parent
source = root / "extension"
target = root / "extension-safari"

shutil.copytree(source, target, dirs_exist_ok=True)

manifest_path = source / "manifest.json"
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

# Chrome's sidePanel API is not available in Safari. Safari uses the shared
# interface as its toolbar popup instead. This is narrower, but avoids injecting
# a large iframe into the article page, which can crash Safari's webpage process.
if "sidePanel" in manifest.get("permissions", []):
    manifest["permissions"].remove("sidePanel")
manifest.pop("side_panel", None)
manifest["action"]["default_popup"] = "sidepanel.html"

# Safari expects script-based background configuration and does not support the
# Chrome `persistent` option in this manifest version.
manifest["background"] = {"scripts": ["safari-background.js"]}

# Do not add safari-panel.js to content scripts. The stable version uses the
# toolbar popup and leaves the host webpage untouched.
manifest["web_accessible_resources"] = [
    {
        "resources": [
            "sidepanel.html",
            "sidepanel.js",
            "browser-api.js",
            "sidepanel.css",
            "assets/*",
        ],
        "matches": ["http://*/*", "https://*/*"],
    }
]

(target / "manifest.json").write_text(
    json.dumps(manifest, indent=2) + "\n",
    encoding="utf-8",
)

print(f"Prepared stable Safari resources: {target}")
