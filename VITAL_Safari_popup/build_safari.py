"""Create a fresh Safari Xcode project from the extension resources."""

import re
import shutil
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parent
source = root / "extension-safari"
project_dir = root / "safari-app"
if not shutil.which("xcrun"):
    raise SystemExit("Run this script on a Mac with full Xcode installed.")
projects = list(project_dir.glob("**/*.xcodeproj")) if project_dir.exists() else []
if not projects:
    subprocess.run(
        [
            "xcrun",
            "safari-web-extension-converter",
            str(source),
            "--app-name",
            "VITAL",
            "--project-location",
            str(project_dir),
        ],
        check=True,
    )
    projects = list(project_dir.glob("**/*.xcodeproj"))
if not projects:
    raise SystemExit("The converter did not create an Xcode project.")
# Converter resource paths may depend on their group nesting. Resolve every
# web-resource reference to its actual source file, avoiding repeated ../ edits.
for project in projects:
    file = project / "project.pbxproj"
    text = file.read_text()

    def resource(match):
        line = match.group(0)
        path_match = re.search(r'path = ("[^"]+"|[^;]+);', line)
        if not path_match:
            return line
        value = path_match.group(1).strip('"')
        if "extension-safari/" not in value:
            return line
        relative = value.split("extension-safari/", 1)[1]
        actual = source / relative
        if not actual.exists():
            raise SystemExit(f"Missing resource: {actual}")
        quoted = str(actual).replace("\\", "\\\\").replace('"', '\\"')
        line = (
            line[: path_match.start()]
            + f'path = "{quoted}";'
            + line[path_match.end() :]
        )
        return re.sub(r"sourceTree = [^;]+;", 'sourceTree = "<absolute>";', line)

    text = re.sub(r"[^\n]*isa = PBXFileReference;[^\n]*", resource, text)
    file.write_text(text)
    print(f"Open: {project}")
subprocess.run(["open", "-a", "Xcode", str(projects[0])], check=True)
