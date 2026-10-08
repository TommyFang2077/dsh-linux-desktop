#!/usr/bin/env python3
"""Build Linux deb/rpm packages and a user-owned desktop archive from pinned official sources."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
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
    "DSH_DESKTOP_ELECTRON_VERSION": DESKTOP["electronVersion"],
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
    official_version = json.loads((SOURCE / "package.json").read_text())["version"]
    if official_version != LOCK["version"]:
        raise RuntimeError("Upstream package version does not match the pinned version")
    if DESKTOP["version"] != official_version:
        raise RuntimeError("desktop.json version must match the pinned official shell version")
    if type(DESKTOP.get("linuxRevision")) is not int or DESKTOP["linuxRevision"] < 1:
        raise RuntimeError("desktop.json linuxRevision must be a positive integer")
    apply_patch(SOURCE, ROOT / "patches/linux.patch")
    pnpm("install", "--frozen-lockfile")


def build():
    pnpm("run", "build:official")
    run("node", ROOT / "scripts/build-updates.mjs", cwd=ROOT)


def package():
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


def desktop_archive(directory):
    return Path(directory) / f"dsh-workbench-{DESKTOP['version']}-r{DESKTOP['linuxRevision']}-linux-x64.tar.gz"


def archive_entry(info):
    if info.type not in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE) or info.sparse is not None:
        raise RuntimeError("Desktop archive cannot contain links or special files")
    if info.mode & 0o7022:
        raise RuntimeError("Desktop archive contains unsafe writable or privileged permissions")
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    info.mtime = 0
    return info


def package_bootstraps(directory, archive):
    """Build native packages whose root-owned files only bootstrap a HOME install."""
    directory = Path(directory)
    version = DESKTOP["version"]
    revision = DESKTOP["linuxRevision"]
    with archive.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    node = APP / ".desktop-build/targets/linux-x64/runtime/primary-runtime/dependencies/node/bin/node"
    installer = ROOT / "build/install-user.mjs"
    if not node.is_file() or not installer.is_file():
        raise RuntimeError("HOME bootstrap requires the bundled Node runtime and authenticated installer")
    with tempfile.TemporaryDirectory(prefix="dsh-native-package-", dir="/tmp") as temporary:
        stage = Path(temporary)
        tree = stage / "root"
        shared = tree / "usr/share/dsh-workbench"
        (tree / "usr/bin").mkdir(parents=True)
        shared.mkdir(parents=True)
        (tree / "usr/share/applications").mkdir(parents=True)
        icons = tree / "usr/share/icons/hicolor/512x512/apps"
        icons.mkdir(parents=True)
        shutil.copyfile(ROOT / "build/icon.png", icons / "dsh-workbench.png")
        shutil.copyfile(archive, shared / "desktop.tar.gz")
        shutil.copyfile(node, shared / "node")
        shutil.copyfile(installer, shared / "install-user.mjs")
        (shared / "node").chmod(0o755)
        (shared / "install-user.mjs").chmod(0o644)
        (shared / "desktop.tar.gz").chmod(0o644)
        launcher = tree / "usr/bin/dsh-workbench"
        launcher.write_text(f"""#!/bin/sh
set -eu
[ \"$(/usr/bin/id -u)\" -ne 0 ] || {{ echo 'Launch dsh-workbench as a normal user, not root.' >&2; exit 1; }}
uid=$(/usr/bin/id -u)
record=$(/usr/bin/getent passwd \"$uid\") || {{ echo 'Cannot resolve current user home.' >&2; exit 1; }}
home=$(printf '%s\\n' \"$record\" | /usr/bin/cut -d: -f6)
case \"$home\" in /*) ;; *) echo 'Invalid current user home.' >&2; exit 1;; esac
export HOME=\"$home\"
root=\"$home/Applications/dsh-linux-desktop\"
payload=/usr/share/dsh-workbench
if [ ! -x \"$root/current/dsh-workbench\" ]; then
  /usr/bin/env -i HOME=\"$home\" PATH=/usr/bin:/bin \"$payload/node\" \"$payload/install-user.mjs\" \\
    --archive \"$payload/desktop.tar.gz\" --sha256 {digest} --version {version} --root \"$root\"
fi
exec \"$root/current/dsh-workbench\" \"$@\"
""")
        launcher.chmod(0o755)
        desktop = tree / "usr/share/applications/dsh-workbench.desktop"
        desktop.write_text("[Desktop Entry]\nName=dsh-workbench\nExec=/usr/bin/dsh-workbench %U\nTerminal=false\nType=Application\nIcon=dsh-workbench\nStartupWMClass=dsh-workbench\nCategories=Development;\n")
        desktop.chmod(0o644)
        for path in (tree, *tree.rglob("*")):
            path.chmod(0o755 if path.is_dir() or path in (launcher, shared / "node") else 0o644)
        deb = stage / f"dsh-workbench-{version}-r{revision}-linux-x64.deb"
        control = tree / "DEBIAN"
        control.mkdir()
        depends = "libgtk-3-0 | libgtk-3-0t64, libnss3, libxss1, libxtst6, libgbm1, libasound2 | libasound2t64, libatspi2.0-0 | libatspi2.0-0t64, xdg-utils"
        (control / "control").write_text(f"Package: dsh-workbench\nVersion: {version.replace('-', '~')}-{revision}\nArchitecture: amd64\nMaintainer: dsh-workbench contributors\nDepends: {depends}\nDescription: HOME-installed DeepSeek Harness desktop bootstrap\n")
        subprocess.run(["dpkg-deb", "--build", "--root-owner-group", tree, deb], check=True)
        shutil.copyfile(deb, directory / deb.name)
        specroot = stage / "rpmbuild"
        for part in ("BUILD", "RPMS", "SOURCES", "SPECS", "SRPMS"):
            (specroot / part).mkdir(parents=True)
        spec = specroot / "SPECS/dsh-workbench.spec"
        spec.write_text(f"""Name: dsh-workbench
Version: {version.replace('-', '~')}
Release: {revision}
Summary: HOME-installed DeepSeek Harness desktop bootstrap
License: MIT
BuildArch: x86_64
Requires: gtk3, nss, libXScrnSaver, libXtst, libdrm, mesa-libgbm, alsa-lib, at-spi2-core, xdg-utils

%description
Installs a root-owned inert bootstrap; the Electron application runs from the user's HOME.

%install
mkdir -p %{{buildroot}}/usr/bin %{{buildroot}}/usr/share
cp -a {tree}/usr/bin/dsh-workbench %{{buildroot}}/usr/bin/
cp -a {tree}/usr/share/dsh-workbench %{{buildroot}}/usr/share/
cp -a {tree}/usr/share/applications %{{buildroot}}/usr/share/
cp -a {tree}/usr/share/icons %{{buildroot}}/usr/share/

%files
/usr/bin/dsh-workbench
/usr/share/dsh-workbench
/usr/share/applications/dsh-workbench.desktop
/usr/share/icons/hicolor/512x512/apps/dsh-workbench.png
""")
        subprocess.run(["rpmbuild", "-bb", "--define", f"_topdir {specroot}", spec], check=True)
        rpm = next((specroot / "RPMS/x86_64").glob("*.rpm"))
        target = directory / f"dsh-workbench-{version}-r{revision}-linux-x64.rpm"
        shutil.copyfile(rpm, target)


def bundle():
    run("node", ROOT / "scripts/build-icons.mjs", cwd=ROOT)
    prepared = APP / ".desktop-build/targets/linux-x64"
    release = json.loads((prepared / "dsh/desktop-runtime.json").read_text())["release"]
    runtime = json.loads((prepared / "runtime/primary-runtime/runtime.json").read_text())
    if release["hostProtocolVersion"] != DESKTOP["protocol"] or runtime["node"] != DESKTOP["nodeVersion"]:
        raise RuntimeError("desktop.json compatibility metadata differs from the prepared Host/Node runtime")
    run("node", ROOT / "scripts/build-updates.mjs", cwd=ROOT)
    # NTFS/exFAT cannot preserve Unix modes; archives are always staged on Linux /tmp.
    with tempfile.TemporaryDirectory(prefix="dsh-workbench-package-", dir="/tmp") as directory:
        output = Path(directory)
        env = {**ENV, "DSH_WORKBENCH_OUTPUT": directory, "TMPDIR": directory, "TMP": directory, "TEMP": directory,
               "OMP_NUM_THREADS": ENV.get("OMP_NUM_THREADS", "2")}
        shutil.copyfile(ROOT / "build/icon.png", output / "icon.png")
        (output / "icon.png").chmod(0o644)
        pnpm("exec", "electron-builder", "--config", ROOT / "electron-builder.config.mjs",
             "--linux", "dir", "--x64", "--publish", "never", cwd=APP, env=env)
        pnpm("exec", "tsx", ROOT / "scripts/smoke.mts", env=env)
        with tarfile.open(desktop_archive(output), "w:gz", compresslevel=1) as archive:
            archive.add(output / "linux-unpacked", arcname="app", filter=archive_entry)
        package_bootstraps(output, desktop_archive(output))
        verify(output, require_installers=True)
        DIST.mkdir(exist_ok=True)
        for file in (desktop_archive(output), *output.glob("*.deb"), *output.glob("*.rpm"),
                     output / "SHA256SUMS", output / "build-info.json"):
            target = DIST / file.name
            shutil.copyfile(file, target)
            target.chmod(0o644)


def verify_archive(file, destination=None):
    """Validate the user artifact before extraction or recording checksums."""
    if not file.is_file() or file.is_symlink() or not 0 < file.stat().st_size <= 1024 ** 3:
        raise RuntimeError("A non-empty, bounded desktop archive is required")
    executable = "app/dsh-workbench"
    node = "app/resources/runtime/primary-runtime/dependencies/node/bin/node"
    required = {executable, node, "app/resources/icon.png", "app/resources/app/package.json",
                "app/resources/app/workbench/desktop.json", "app/resources/app/workbench/updates.json",
                "app/resources/app/dsh/desktop-runtime.json", "app/resources/runtime/primary-runtime/runtime.json"}
    with tarfile.open(file, "r:gz") as archive:
        entries = {}
        total = 0
        for item in archive:
            name = item.name[:-1] if item.name.endswith("/") else item.name
            parts = name.split("/")
            if "\\" in name or "\0" in name or parts[0] != "app" or any(p in ("", ".", "..") for p in parts):
                raise RuntimeError("Desktop archive contains an unsafe path")
            if name in entries or item.type not in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE) or item.sparse is not None:
                raise RuntimeError("Desktop archive contains links, special or duplicate files")
            if item.mode & 0o7022 or (item.mode & (0o700 if item.isdir() else 0o600)) != (0o700 if item.isdir() else 0o600):
                raise RuntimeError("Desktop archive contains unsafe writable permissions or non-writable owner files")
            if item.size < 0 or (item.isdir() and item.size != 0):
                raise RuntimeError("Desktop archive entry size is invalid")
            entries[name] = item
            total += item.size
            if len(entries) > 100_000 or total > 4 * 1024 ** 3 or total > file.stat().st_size * 1000:
                raise RuntimeError("Desktop archive exceeds extraction limits")
        if "app" not in entries or not entries["app"].isdir() or not required.issubset(entries):
            raise RuntimeError("Desktop archive omits required application files")
        for name in required:
            if not entries[name].isfile() or entries[name].size <= 0:
                raise RuntimeError("Desktop archive application entries must be regular non-empty files")
        if any(not entries[name].mode & 0o100 for name in (executable, node)):
            raise RuntimeError("Desktop archive executable permissions are missing")

        def read_json(name):
            if entries[name].size > 32 * 1024 ** 2:
                raise RuntimeError("Desktop archive metadata is too large")
            return json.load(archive.extractfile(entries[name]))

        package = read_json("app/resources/app/package.json")
        metadata = read_json("app/resources/app/workbench/desktop.json")
        descriptor = read_json("app/resources/app/dsh/desktop-runtime.json")
        runtime = read_json("app/resources/runtime/primary-runtime/runtime.json")
        if not all(isinstance(value, dict) for value in (package, metadata, descriptor, runtime)) or not isinstance(descriptor.get("release"), dict):
            raise RuntimeError("Desktop archive metadata must be objects")
        if package.get("name") != "dsh-workbench" or package.get("productName") not in (None, "dsh-workbench") or package.get("version") != DESKTOP["version"] or metadata != DESKTOP:
            raise RuntimeError("Unexpected desktop archive identity, version or metadata")
        if descriptor.get("platform") != "linux" or descriptor.get("arch") != "x64" or descriptor.get("release", {}).get("version") != LOCK["version"]:
            raise RuntimeError("Unexpected desktop archive kernel identity or platform")
        if descriptor["release"].get("hostProtocolVersion") != DESKTOP["protocol"] or runtime.get("node") != DESKTOP["nodeVersion"]:
            raise RuntimeError("Desktop archive Host/Node metadata is incompatible")
        if not isinstance(read_json("app/resources/app/workbench/updates.json"), dict):
            raise RuntimeError("Desktop archive update configuration is invalid")
        if destination is not None:
            archive.extractall(destination, members=entries.values())


def launch():
    archive_path = desktop_archive(DIST)
    with tempfile.TemporaryDirectory(prefix="dsh-workbench-run-", dir="/tmp") as directory:
        verify_archive(archive_path, Path(directory))
        run(Path(directory) / "app/dsh-workbench", cwd=ROOT)


def verify_package(file, format):
    if file.is_symlink() or not file.is_file() or not 0 < file.stat().st_size <= 1024 ** 3:
        raise RuntimeError("A regular, bounded installer is required")
    version = DESKTOP["version"].replace("-", "~")
    if format == "deb":
        actual = [subprocess.check_output(["dpkg-deb", "--field", file, field], text=True).strip()
                  for field in ("Package", "Version", "Architecture")]
        expected = ["dsh-workbench", f"{version}-{DESKTOP['linuxRevision']}", "amd64"]
    elif format == "rpm":
        actual = subprocess.check_output(["rpm", "-qp", "--queryformat", "%{NAME}\\n%{VERSION}\\n%{RELEASE}\\n%{ARCH}", file], text=True).splitlines()
        expected = ["dsh-workbench", version, str(DESKTOP["linuxRevision"]), "x86_64"]
    else:
        raise RuntimeError("Unsupported desktop package format")
    if actual != expected:
        raise RuntimeError(f"Package identity/version/revision/architecture mismatch: {file.name}")
    command = ["dpkg-deb", "--contents", str(file)] if format == "deb" else ["rpm", "-qpl", str(file)]
    listing = subprocess.check_output(command, text=True)
    if "/opt/" in listing or "/opt\n" in listing:
        raise RuntimeError("Native packages must not install anything under /opt")


def verify(directory=None, require_installers=False):
    directory = DIST if directory is None else Path(directory)
    file = desktop_archive(directory)
    verify_archive(file)
    with file.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    print(f"Verified {file.name} ({file.stat().st_size:,} bytes)")
    checksums = [f"{digest}  {file.name}\n"]
    for format in ("deb", "rpm"):
        package = directory / f"dsh-workbench-{DESKTOP['version']}-r{DESKTOP['linuxRevision']}-linux-x64.{format}"
        if require_installers or package.exists():
            verify_package(package, format)
            with package.open("rb") as stream:
                checksums.append(f"{hashlib.file_digest(stream, 'sha256').hexdigest()}  {package.name}\n")
    for name, contents in (("SHA256SUMS", "".join(checksums)),
                           ("build-info.json", json.dumps({**LOCK, "desktopVersion": DESKTOP["version"],
                            "linuxRevision": DESKTOP["linuxRevision"], "electronVersion": DESKTOP["electronVersion"],
                            "target": "linux-x64", "distribution": "deb-rpm-and-user-archive", "official": False}, indent=2) + "\n")):
        path = directory / name
        path.write_text(contents)
        path.chmod(0o644)


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
