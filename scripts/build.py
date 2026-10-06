#!/usr/bin/env python3
"""Build an independently branded Linux package from a pinned official desktop."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "build/upstream"
APP = SOURCE / "apps/desktop"
DIST = ROOT / "dist"
LOCK = json.loads((ROOT / "upstream.json").read_text())
DESKTOP = json.loads((ROOT / "desktop.json").read_text())
ENV = {
    **os.environ,
    "LEFTHOOK": "0",
    "DSH_DESKTOP_APP_ID": "io.github.tommyfang.DshWorkbench",
    "DSH_DESKTOP_TARGET_PLATFORM": "linux",
    "DSH_DESKTOP_TARGET_ARCH": "x64",
}


def run(*args, cwd=SOURCE, env=ENV):
    print("+", " ".join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), cwd=cwd, env=env, check=True)


def pnpm(*args, cwd=SOURCE, env=ENV):
    entry = SOURCE / "node_modules/pnpm/bin/pnpm.mjs"
    if entry.is_file():
        run("node", entry, *args, cwd=cwd, env=env)
    else:
        run("npx", "--yes", f"pnpm@{LOCK['pnpm']}", *args, cwd=cwd, env=env)


def apply_patch(source, patch):
    """Apply once; reject an incompatible source tree rather than partially patch it."""
    if subprocess.run(["git", "apply", "--reverse", "--check", str(patch)],
                      cwd=source, capture_output=True).returncode == 0:
        return
    run("git", "apply", "--check", patch, cwd=source)
    run("git", "apply", patch, cwd=source)


def prepare():
    if not SOURCE.exists():
        SOURCE.parent.mkdir(parents=True, exist_ok=True)
        run("git", "init", "--initial-branch=upstream", SOURCE, cwd=ROOT)
        run("git", "remote", "add", "origin", LOCK["repository"])
        run("git", "fetch", "--depth=1", "origin", LOCK["commit"])
        run("git", "checkout", "--detach", "FETCH_HEAD")
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=SOURCE, text=True).strip()
    if commit != LOCK["commit"]:
        raise RuntimeError("Upstream checkout differs from upstream.json; refusing to overwrite it")
    if json.loads((SOURCE / "package.json").read_text())["version"] != LOCK["version"]:
        raise RuntimeError("Upstream package version does not match the pinned version")
    apply_patch(SOURCE, ROOT / "patches/linux.patch")
    pnpm("install", "--frozen-lockfile")


def build():
    pnpm("run", "build:official")
    run("node", ROOT / "scripts/build-updates.mjs", cwd=ROOT)


def package():
    for tool in ("rpmbuild", "rpm", "dpkg-deb"):
        if shutil.which(tool) is None:
            raise RuntimeError(f"Required packaging tool not found: {tool}")
    paths = APP / ".desktop-build/targets/linux-x64"
    pnpm("run", "release:pack", "--family", "dsh", "--out", paths / "packed/dsh")
    pnpm("--dir", "apps/desktop-host", "pack", "--pack-destination", paths / "packed/dsh")
    pnpm("run", "release:pack", "--family", "vendor", "--out", paths / "packed/vendor")
    landlock = paths / "packed/landlock"
    landlock.mkdir(parents=True, exist_ok=True)
    pnpm("--dir", "native/system", "run", "build:ts")
    pnpm("--dir", "native/system/packages/entry", "pack", "--pack-destination", landlock)
    for stage in ("prepare:runtime", "prepare:packages", "prepare:dsh"):
        pnpm("run", stage, cwd=APP)
    bundle()


def bundle():
    run("node", ROOT / "scripts/build-icons.mjs", cwd=ROOT)
    prepared = APP / ".desktop-build/targets/linux-x64"
    release = json.loads((prepared / "dsh/desktop-runtime.json").read_text())["release"]
    runtime = json.loads((prepared / "runtime/primary-runtime/runtime.json").read_text())
    if release["hostProtocolVersion"] != DESKTOP["protocol"] or runtime["node"] != DESKTOP["nodeVersion"]:
        raise RuntimeError("desktop.json compatibility metadata differs from the prepared Host/Node runtime")
    run("node", ROOT / "scripts/build-updates.mjs", cwd=ROOT)
    # NTFS/exFAT cannot preserve Unix modes; installers are always staged on Linux /tmp.
    with tempfile.TemporaryDirectory(prefix="dsh-workbench-package-", dir="/tmp") as directory:
        output = Path(directory)
        env = {**ENV, "DSH_WORKBENCH_OUTPUT": directory, "TMPDIR": directory, "TMP": directory, "TEMP": directory,
               "OMP_NUM_THREADS": ENV.get("OMP_NUM_THREADS", "2")}
        shutil.copyfile(ROOT / "build/icon.png", output / "icon.png")
        (output / "icon.png").chmod(0o644)
        pnpm("exec", "electron-builder", "--config", ROOT / "electron-builder.config.mjs",
             "--linux", "deb", "rpm", "--x64", "--publish", "never", cwd=APP, env=env)
        pnpm("exec", "tsx", ROOT / "scripts/smoke.mts", env=env)
        verify(output)
        DIST.mkdir(exist_ok=True)
        names = [f"dsh-workbench-{DESKTOP['version']}-x64.{extension}" for extension in ("deb", "rpm")]
        for name in [*names, "SHA256SUMS", "build-info.json"]:
            shutil.copyfile(output / name, DIST / name)


def launch():
    with tempfile.TemporaryDirectory(prefix="dsh-workbench-run-", dir="/tmp") as directory:
        run("dpkg-deb", "--extract", DIST / f"dsh-workbench-{DESKTOP['version']}-x64.deb", directory, cwd=ROOT)
        run(Path(directory) / "opt/dsh-workbench/dsh-workbench", cwd=ROOT)


def verify(directory=None):
    directory = DIST if directory is None else Path(directory)
    files = [directory / f"dsh-workbench-{DESKTOP['version']}-x64.{extension}" for extension in ("deb", "rpm")]
    if any(not file.is_file() or file.stat().st_size == 0 for file in files):
        raise RuntimeError("Both non-empty deb and rpm packages are required")
    deb, rpm = files
    deb_metadata = [subprocess.check_output(["dpkg-deb", "--field", str(deb), field], text=True).strip()
                    for field in ("Package", "Version", "Architecture")]
    rpm_metadata = subprocess.check_output(
        ["rpm", "-qp", "--queryformat", "%{NAME}\n%{VERSION}\n%{ARCH}", str(rpm)], text=True).splitlines()
    version = DESKTOP["version"].replace("-", "~")
    if deb_metadata != ["dsh-workbench", version, "amd64"] or rpm_metadata != ["dsh-workbench", version, "x86_64"]:
        raise RuntimeError("Unexpected package identity, version, or architecture")
    for command, file in ((["dpkg-deb", "--contents"], deb),
                          (["rpm", "-qp", "--queryformat", "[%{FILEMODES:perms} %{FILENAMES}\n]"], rpm)):
        listing = subprocess.check_output([*command, str(file)], text=True)
        for required in ("/opt/dsh-workbench/dsh-workbench", "resources/app/package.json", "applications/dsh-workbench.desktop"):
            if required not in listing:
                raise RuntimeError(f"{file.name} omits {required}")
        for line in listing.splitlines():
            permissions = line.split(maxsplit=1)[0]
            if permissions[0] != "l" and (permissions[5] == "w" or permissions[8] == "w"):
                raise RuntimeError(f"{file.name} contains unsafe writable permissions: {line}")
    sums = []
    for file in files:
        with file.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        sums.append(f"{digest}  {file.name}\n")
        print(f"Verified {file.name} ({file.stat().st_size:,} bytes)")
    (directory / "SHA256SUMS").write_text("".join(sums))
    (directory / "build-info.json").write_text(json.dumps({**LOCK, "desktopVersion": DESKTOP["version"], "target": "linux-x64", "official": False}, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("prepare", "build", "package", "bundle", "verify", "launch", "all"), default="all", nargs="?")
    stage = parser.parse_args().stage
    if platform.system() != "Linux" or platform.machine() not in ("x86_64", "amd64"):
        parser.error("This build supports Linux x86_64 hosts only")
    if stage == "all":
        prepare()
        build()
        package()
    else:
        globals()[stage]()


if __name__ == "__main__":
    main()
