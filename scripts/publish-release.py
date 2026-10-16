#!/usr/bin/env python3
"""Resume an interrupted upload without replacing any published bytes."""
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import urllib.error

spec = importlib.util.spec_from_file_location("upstream_release", Path(__file__).with_name("upstream-release.py"))
upstream = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upstream)


def asset_files(directory):
    patterns = ("dsh-workbench-*-linux-x64.tar.gz", "dsh-workbench-*-linux-x64.deb", "dsh-workbench-*-linux-x64.rpm",
                "SHA256SUMS", "build-info.json", "kernel-release/*.tgz", "kernel-release/*-latest.json", "desktop-release/*-latest.json")
    files = {}
    for pattern in patterns:
        matches = list(directory.glob(pattern))
        if len(matches) != 1:
            raise ValueError("Expected exactly one release asset for " + pattern)
        file = matches[0]
        if file.is_symlink() or not file.is_file() or file.name in files:
            raise ValueError("Unsafe or duplicate release asset")
        with file.open("rb") as handle:
            digest = hashlib.file_digest(handle, "sha256").hexdigest()
        files[file.name] = (file, "sha256:" + digest, file.stat().st_size)
    return files


def missing_assets(files, assets):
    seen = set()
    for asset in assets:
        name = asset["name"]
        if name in seen or name not in files:
            raise ValueError("Unexpected or duplicate remote release asset")
        seen.add(name)
        _, digest, size = files[name]
        if asset.get("state") != "uploaded" or asset.get("digest") != digest or asset.get("size") != size:
            raise ValueError("Remote asset differs or has no verifiable digest; manual recovery required: " + name)
    return [file for name, (file, _, _) in files.items() if name not in seen]


def publish(api, repo, tag, sha, directory, upload):
    if not upstream.SHA.fullmatch(sha):
        raise ValueError("Release source must be an exact commit")
    ref = api.request(f"/repos/{repo}/git/ref/tags/{tag}")["object"]
    if ref.get("type") != "commit" or ref.get("sha") != sha:
        raise ValueError("Release tag does not identify the approved commit")
    files = asset_files(directory)
    try:
        release = api.request(f"/repos/{repo}/releases/tags/{tag}")
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
        release = api.request(f"/repos/{repo}/releases", "POST", {"tag_name": tag, "target_commitish": sha,
            "name": "dsh-linux-desktop " + tag, "draft": True, "prerelease": "-" in tag.removeprefix("workbench-v").rsplit("-r", 1)[0],
            "body": "Unofficial Linux adaptation of pinned official sources. Back up ~/.dsh and ~/.config/dsh-workbench before installation. Protocol and dataEpoch compatibility are explicit, never inferred from semver."})
    path = f"/repos/{repo}/releases/{release['id']}"
    assets = api.pages(path + "/assets")
    missing = missing_assets(files, assets)
    if missing and not release["draft"]:
        raise ValueError("Published release is incomplete; refusing to modify immutable release")
    for file in missing:
        upload(file)
    if missing_assets(files, api.pages(path + "/assets")):
        raise ValueError("Release upload incomplete")
    if release["draft"]:
        api.request(path, "PATCH", {"draft": False})


if __name__ == "__main__":
    repo, tag = os.environ["GITHUB_REPOSITORY"], os.environ["RELEASE_TAG"]
    publish(upstream.GitHub(os.environ["GH_TOKEN"]), repo, tag, os.environ["SOURCE_SHA"], Path("artifacts"),
            lambda file: subprocess.run(["gh", "release", "upload", tag, str(file), "--repo", repo], check=True))
