#!/usr/bin/env python3
"""GitHub-only release discovery and fail-closed, exact-tree promotion."""
import base64
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from functools import cmp_to_key
from pathlib import Path

OFFICIAL = "deepseek-ai/deepseek-harness"
REPOSITORY = f"https://github.com/{OFFICIAL}.git"
SHA = re.compile(r"^[0-9a-f]{40}$")
VERSION = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$")
FILES = ("upstream.json", "desktop.json", "updates.json")


def version(value):
    match = VERSION.fullmatch(value)
    if not match:
        raise ValueError("Invalid official semver")
    pre = match[4].split(".") if match[4] else []
    if any(not item or (item.isdigit() and len(item) > 1 and item[0] == "0") for item in pre):
        raise ValueError("Invalid prerelease identifiers")
    return tuple(map(int, match.group(1, 2, 3))), pre


def compare(a, b):
    ac, ap = version(a); bc, bp = version(b)
    if ac != bc:
        return (ac > bc) - (ac < bc)
    if not ap or not bp:
        return (not ap) - (not bp)
    for x, y in zip(ap, bp):
        if x == y:
            continue
        if x.isdigit() and y.isdigit():
            return (int(x) > int(y)) - (int(x) < int(y))
        if x.isdigit() != y.isdigit():
            return -1 if x.isdigit() else 1
        return (x > y) - (x < y)
    return (len(ap) > len(bp)) - (len(ap) < len(bp))


def select_release(releases, current):
    candidates = {}
    for release in releases:
        tag = release.get("tag_name", "")
        if release.get("draft") or not tag.startswith("dsh-v"):
            continue
        value = tag[5:]
        try:
            parsed = version(value)
        except ValueError:
            continue
        if bool(parsed[1]) != bool(release.get("prerelease")):
            continue
        if compare(value, current) > 0:
            candidates[tag] = release
    return max(candidates.values(), key=cmp_to_key(lambda a, b: compare(a["tag_name"][5:], b["tag_name"][5:])), default=None)


class GitHub:
    def __init__(self, token):
        self.token = token

    def request(self, path, method="GET", data=None):
        assert path.startswith("/") and not path.startswith("//")
        request = urllib.request.Request("https://api.github.com" + path,
            data=None if data is None else json.dumps(data).encode(), method=method,
            headers={"Authorization": f"Bearer {self.token}", "Accept": "application/vnd.github+json",
                     "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read(16 * 1024 * 1024 + 1)
            if len(raw) > 16 * 1024 * 1024:
                raise ValueError("GitHub response byte limit exceeded")
            return json.loads(raw)

    def pages(self, path, key=None):
        rows = []
        for page in range(1, 101):
            batch = self.request(path + ("&" if "?" in path else "?") + f"per_page=100&page={page}")
            if key is not None:
                batch = batch[key]
            if not isinstance(batch, list):
                raise ValueError("Expected paginated array")
            rows.extend(batch)
            if len(batch) < 100:
                return rows
        raise ValueError("Pagination limit reached; refusing incomplete discovery")

    def file(self, repo, path, ref):
        result = self.request(f"/repos/{repo}/contents/{path}?ref={urllib.parse.quote(ref, safe='')}")
        return json.loads(base64.b64decode(result["content"], validate=False))


def resolve_release(api, release):
    tag = release["tag_name"]
    obj = api.request(f"/repos/{OFFICIAL}/git/ref/tags/{urllib.parse.quote(tag, safe='')}")["object"]
    for _ in range(8):
        if obj["type"] == "commit" and SHA.fullmatch(obj["sha"]):
            package = api.file(OFFICIAL, "package.json", obj["sha"])
            if package["version"] != tag[5:]:
                raise ValueError("Release tag/package version mismatch")
            manager = re.fullmatch(r"pnpm@([0-9]+\.[0-9]+\.[0-9]+)(?:\+sha(?:224|512)\.[0-9a-f]+)?", package["packageManager"])
            if not manager:
                raise ValueError("Official package manager is not exactly pinned")
            return {"repository": REPOSITORY, "commit": obj["sha"], "version": package["version"], "pnpm": manager[1]}
        if obj["type"] != "tag":
            break
        obj = api.request(f"/repos/{OFFICIAL}/git/tags/{obj['sha']}")["object"]
    raise ValueError("Release tag does not resolve to a commit")


def compatibility(policy, old, target, desktop):
    if old["repository"] != REPOSITORY or target["repository"] != REPOSITORY:
        raise ValueError("Unofficial source")
    matches = [row for row in policy.get("transitions", []) if row.get("from") == old["commit"] and row.get("to") == target["commit"]]
    if len(matches) != 1:
        return None
    row = matches[0]
    if row.get("status") != "compatible" or not row.get("evidence"):
        return None
    if row.get("upstream") != target or row.get("fromDesktop") != desktop:
        return None
    result = row.get("desktop", {})
    if set(result) != set(desktop) or result.get("version") != target["version"]:
        return None
    if result.get("protocol") != desktop["protocol"] or result.get("dataEpoch") != desktop["dataEpoch"]:
        return None
    if result.get("linuxRevision") != desktop["linuxRevision"] + 1:
        return None
    return result


def proposed_files(current, target, approved):
    desktop = approved or {**current["desktop.json"], "version": target["version"],
        "linuxRevision": current["desktop.json"]["linuxRevision"] + 1, "dataEpoch": "dsh-" + target["version"]}
    updates = json.loads(json.dumps(current["updates.json"]))
    if not approved and not desktop.get("followOfficial"):
        for channel in ("kernel", "desktop"):
            old = updates[channel]["url"]
            updates[channel]["url"] = old.rsplit("/", 1)[0] + f"/{channel}-{desktop['dataEpoch']}-latest.json"
    return {"upstream.json": target, "desktop.json": desktop, "updates.json": updates}


def automatic_release(policy, current, target):
    """Eligibility schedules verification; it never certifies data compatibility."""
    enabled = policy.get("automaticRelease", {}).get("enabled") is True
    desktop = current["desktop.json"]
    if not enabled or desktop.get("followOfficial") is not True:
        return None
    if current["upstream.json"]["repository"] != REPOSITORY or target["repository"] != REPOSITORY:
        raise ValueError("Unofficial source")
    if compare(target["version"], current["upstream.json"]["version"]) <= 0:
        raise ValueError("Automatic releases must advance the official version")
    # New data identity is deliberate. The client snapshots before kernel migration.
    return {**desktop, "version": target["version"], "linuxRevision": desktop["linuxRevision"] + 1,
            "dataEpoch": "dsh-" + target["version"]}


def encode(value):
    return json.dumps(value, indent=2) + "\n"


def expected_tree(api, repo, base, files):
    tree = api.request(f"/repos/{repo}/git/commits/{base}")["tree"]["sha"]
    return api.request(f"/repos/{repo}/git/trees", "POST", {"base_tree": tree,
        "tree": [{"path": name, "mode": "100644", "type": "blob", "content": encode(value)} for name, value in files.items()]})["sha"]


def output(**values):
    with open(os.environ["GITHUB_OUTPUT"], "a") as handle:
        for key, value in values.items():
            handle.write(f"{key}={value}\n")


def plan(api, repo, base):
    current = {name: api.file(repo, name, base) for name in FILES}
    policy = api.file(repo, "scripts/upstream-policy.json", base)
    release = select_release(api.pages(f"/repos/{OFFICIAL}/releases"), current["upstream.json"]["version"])
    if not release:
        return None
    target = resolve_release(api, release)
    approved = automatic_release(policy, current, target) or compatibility(policy, current["upstream.json"], target, current["desktop.json"])
    return target, approved, proposed_files(current, target, approved)


def discover(api, repo, branch):
    base = api.request(f"/repos/{repo}/git/ref/heads/{branch}")["object"]["sha"]
    if base != os.environ["GITHUB_SHA"]:
        raise ValueError("Default branch advanced; rerun discovery")
    result = plan(api, repo, base)
    if result is None:
        output(candidate="false")
        return
    target, approved, files = result
    name = "automation/upstream-" + target["commit"]
    if files["desktop.json"].get("followOfficial"):
        # A fresh trusted base gets a fresh branch; never rewrite a tested candidate.
        name += "-" + base[:12]
    prs = api.pages(f"/repos/{repo}/pulls?state=all&head={repo.split('/')[0]}:{name}")
    if any(pr["state"] == "closed" for pr in prs):
        output(candidate="false")
        return
    tree = expected_tree(api, repo, base, files)
    if prs:
        pr = api.request(f"/repos/{repo}/pulls/{prs[0]['number']}")
        commit = api.request(f"/repos/{repo}/git/commits/{pr['head']['sha']}")
        if commit["tree"]["sha"] != tree or [p["sha"] for p in commit["parents"]] != [base]:
            raise ValueError("Existing PR differs from current trusted plan; manual review required")
    else:
        commit = api.request(f"/repos/{repo}/git/commits", "POST", {"message": f"Update official release to {target['version']}", "tree": tree, "parents": [base]})
        try:
            api.request(f"/repos/{repo}/git/refs", "POST", {"ref": "refs/heads/" + name, "sha": commit["sha"]})
        except urllib.error.HTTPError as error:
            if error.code != 422:
                raise
            existing = api.request(f"/repos/{repo}/git/ref/heads/{name}")["object"]["sha"]
            saved = api.request(f"/repos/{repo}/git/commits/{existing}")
            if saved["tree"]["sha"] != tree or [p["sha"] for p in saved["parents"]] != [base]:
                raise ValueError("Existing automation branch requires manual review") from error
        reason = "Eligible only after package tests and the real previous-shell/new-kernel smoke test. Data epochs remain explicit; kernel migration requires a verified backup." if approved else "MANUAL ADAPTATION: automatic following is not enabled for this client. Automatic merge and signing are disabled."
        pr = api.request(f"/repos/{repo}/pulls", "POST", {"head": name, "base": branch,
            "title": f"Update official DeepSeek Harness to {target['version']}",
            "body": f"Official Release only: https://github.com/{OFFICIAL}/releases/tag/dsh-v{target['version']}\nPinned commit: {target['commit']}\n\n{reason}\nChanges to this PR invalidate automatic promotion.", "draft": not bool(approved)})
        pr = api.request(f"/repos/{repo}/pulls/{pr['number']}")
    output(candidate="true", eligible=str(bool(approved)).lower(), head=pr["head"]["sha"], base=base, pr=pr["number"])


def promote(api, repo, branch, base, head, number):
    if not SHA.fullmatch(base) or not SHA.fullmatch(head) or not number.isdigit():
        raise ValueError("Invalid promotion identity")
    if api.request(f"/repos/{repo}/git/ref/heads/{branch}")["object"]["sha"] != base:
        raise ValueError("Base moved after testing")
    pr = api.request(f"/repos/{repo}/pulls/{number}")
    if pr["state"] != "open" or pr["draft"] or pr["head"]["sha"] != head or pr["head"]["repo"]["full_name"] != repo or pr["base"]["ref"] != branch:
        raise ValueError("PR identity/state changed")
    if pr["head"].get("ref", "").startswith("automation/ai-upstream-"):
        raise ValueError("AI candidates are never automatically promoted")
    result = plan(api, repo, base)
    if not result or not result[1]:
        raise ValueError("No trusted automatic-release policy or exact compatibility evidence")
    target, approved, files = result
    expected = expected_tree(api, repo, base, files)
    tested = api.request(f"/repos/{repo}/git/commits/{head}")
    if tested["tree"]["sha"] != expected or [p["sha"] for p in tested["parents"]] != [base]:
        raise ValueError("Tested tree includes unapproved changes")
    api.request(f"/repos/{repo}/statuses/{head}", "POST", {"state": "success",
        "context": "upstream-release/tested-head", "description": "Exact generated tree passed isolated build and tests",
        "target_url": f"https://github.com/{repo}/actions/runs/{os.environ['GITHUB_RUN_ID']}"})
    merged = api.request(f"/repos/{repo}/pulls/{number}/merge", "PUT", {"sha": head, "merge_method": "merge"})
    if not merged.get("merged"):
        raise ValueError("GitHub did not merge the tested head")
    commit = api.request(f"/repos/{repo}/git/commits/{merged['sha']}")
    if commit["tree"]["sha"] != expected or [p["sha"] for p in commit["parents"]] != [base, head]:
        raise ValueError("Merged tree/parents differ from tested source; no release")
    tag = f"workbench-v{target['version']}-r{approved['linuxRevision']}"
    api.request(f"/repos/{repo}/git/refs", "POST", {"ref": "refs/tags/" + tag, "sha": merged["sha"]})
    output(sha=merged["sha"], tag=tag)


if __name__ == "__main__":
    api = GitHub(os.environ["GH_TOKEN"])
    repo = os.environ["GITHUB_REPOSITORY"]
    branch = os.environ.get("DEFAULT_BRANCH", "main")
    if os.environ["MODE"] == "verify":
        current = json.loads(Path("upstream.json").read_text())
        release = api.request(f"/repos/{OFFICIAL}/releases/tags/dsh-v{current['version']}")
        if release.get("draft") or resolve_release(api, release) != current:
            raise ValueError("Pinned source differs from official published Release")
    elif os.environ["MODE"] == "discover":
        discover(api, repo, branch)
    elif os.environ["MODE"] == "promote":
        promote(api, repo, branch, os.environ["BASE_SHA"], os.environ["HEAD_SHA"], os.environ["PR_NUMBER"])
    else:
        raise ValueError("Unknown mode")
