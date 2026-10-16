import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock
import urllib.error

spec = importlib.util.spec_from_file_location("publish_release", Path(__file__).parents[1] / "scripts/publish-release.py")
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class PublishTests(unittest.TestCase):
    def test_existing_assets_must_match_hash_size_and_state(self):
        files = {"a.tgz": (Path("a.tgz"), "sha256:abc", 10), "b.json": (Path("b.json"), "sha256:def", 5)}
        asset = {"name": "a.tgz", "digest": "sha256:abc", "size": 10, "state": "uploaded"}
        self.assertEqual(publisher.missing_assets(files, [asset]), [Path("b.json")])
        for change in ({"digest": "sha256:wrong"}, {"digest": None}, {"size": 11}, {"state": "starter"}, {"name": "extra"}):
            with self.assertRaises(ValueError):
                publisher.missing_assets(files, [{**asset, **change}])
        with self.assertRaises(ValueError):
            publisher.missing_assets(files, [asset, asset])

    def test_failed_upload_resumes_without_overwriting_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            names = ("dsh-workbench-1.0.1-r2-linux-x64.tar.gz", "dsh-workbench-1.0.1-r2-linux-x64.deb",
                "dsh-workbench-1.0.1-r2-linux-x64.rpm", "SHA256SUMS", "build-info.json",
                "kernel-release/kernel.tgz", "kernel-release/kernel-dsh-1.0.0-latest.json", "desktop-release/desktop-dsh-1.0.0-latest.json")
            for name in names:
                file = root / name
                file.parent.mkdir(exist_ok=True)
                file.write_bytes(name.encode())
            api = Mock()
            sha = "a" * 40
            remote = []
            state = {"draft": True, "id": 42}
            api.pages.side_effect = lambda _: list(remote)
            def request(path, method="GET", data=None):
                if "/git/ref/tags/" in path:
                    return {"object": {"type": "commit", "sha": sha, "url": "https://api.github.com/repos/owner/repo/git/commits/" + sha}}
                if "/releases/tags/" in path:
                    return state
                if method == "PATCH":
                    state.update(data)
                    return state
                raise AssertionError(path)
            api.request.side_effect = request
            uploaded = []
            def upload(file):
                if len(uploaded) == 2 and not recovered[0]:
                    raise RuntimeError("temporary network failure")
                self.assertNotIn(file.name, uploaded)
                uploaded.append(file.name)
                data = file.read_bytes()
                remote.append({"name": file.name, "state": "uploaded", "size": len(data), "digest": "sha256:" + hashlib.sha256(data).hexdigest()})
            recovered = [False]
            with self.assertRaisesRegex(RuntimeError, "network"):
                publisher.publish(api, "owner/repo", "workbench-v1.0.1-r2", sha, root, upload)
            self.assertTrue(state["draft"])
            recovered[0] = True
            publisher.publish(api, "owner/repo", "workbench-v1.0.1-r2", sha, root, upload)
            self.assertFalse(state["draft"])
            self.assertEqual(len(uploaded), 8)
            publisher.publish(api, "owner/repo", "workbench-v1.0.1-r2", sha, root, upload)
            self.assertEqual(len(uploaded), 8)
            remote.pop()
            with self.assertRaisesRegex(ValueError, "immutable release"):
                publisher.publish(api, "owner/repo", "workbench-v1.0.1-r2", sha, root, upload)


if __name__ == "__main__":
    unittest.main()
