import contextlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from scripts import build


class BuildTests(unittest.TestCase):
    def archive(self, directory, changes=None, extra=()):
        metadata = build.DESKTOP
        files = {
            "app": (b"", 0o755, tarfile.DIRTYPE),
            "app/dsh-workbench": (b"desktop executable", 0o755, tarfile.REGTYPE),
            "app/resources/icon.png": (b"icon", 0o644, tarfile.REGTYPE),
            "app/resources/app/package.json": (json.dumps({"name": "dsh-workbench", "version": metadata["version"]}).encode(), 0o644, tarfile.REGTYPE),
            "app/resources/app/workbench/desktop.json": (json.dumps(metadata).encode(), 0o644, tarfile.REGTYPE),
            "app/resources/app/workbench/updates.json": (b'{"kernel":null,"desktop":null}', 0o644, tarfile.REGTYPE),
            "app/resources/app/dsh/desktop-runtime.json": (json.dumps({"platform": "linux", "arch": "x64", "release": {"version": build.LOCK["version"], "hostProtocolVersion": metadata["protocol"]}}).encode(), 0o644, tarfile.REGTYPE),
            "app/resources/runtime/primary-runtime/runtime.json": (json.dumps({"node": metadata["nodeVersion"]}).encode(), 0o644, tarfile.REGTYPE),
            "app/resources/runtime/primary-runtime/dependencies/node/bin/node": (b"bundled Node", 0o755, tarfile.REGTYPE),
        }
        files.update(changes or {})
        output = build.desktop_archive(directory)
        with tarfile.open(output, "w:gz") as archive:
            for name, (data, mode, kind) in files.items():
                item = tarfile.TarInfo(name)
                item.mode, item.type, item.size = mode, kind, len(data)
                archive.addfile(item, io.BytesIO(data) if item.isfile() else None)
            for item, data in extra:
                archive.addfile(item, io.BytesIO(data) if item.isfile() else None)
        return output

    def test_patch_is_idempotent_and_rejects_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "--quiet", str(root)], check=True)
            source = root / "example.txt"
            source.write_text("original\n")
            change = root / "linux.patch"
            change.write_text("--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-original\n+linux\n")
            with contextlib.redirect_stdout(io.StringIO()):
                build.apply_patch(root, change)
                build.apply_patch(root, change)
                self.assertEqual(source.read_text(), "linux\n")
                source.write_text("unexpected upstream change\n")
                with self.assertRaises(subprocess.CalledProcessError):
                    build.apply_patch(root, change)
            self.assertEqual(source.read_text(), "unexpected upstream change\n")

    def test_pnpm_reuses_the_locked_workspace_install(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(build, "SOURCE", Path(directory)), patch.object(build, "run") as run:
            entry = build.SOURCE / "node_modules/pnpm/bin/pnpm.mjs"
            build.pnpm("--version", cwd=build.SOURCE, env=build.ENV)
            run.assert_called_with("npx", "--yes", f"pnpm@{build.LOCK['pnpm']}", "--version", cwd=build.SOURCE, env=build.ENV)
            entry.parent.mkdir(parents=True)
            entry.touch()
            build.pnpm("--version", cwd=build.SOURCE, env=build.ENV)
            run.assert_called_with("node", entry, "--version", cwd=build.SOURCE, env=build.ENV)

    def test_missing_archive_never_reports_success(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(build, "DIST", Path(directory)):
            with self.assertRaisesRegex(RuntimeError, "non-empty"):
                build.verify()
            self.assertFalse((build.DIST / "SHA256SUMS").exists())

    def test_wrong_archive_identity_never_writes_checksums(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(build, "DIST", Path(directory)):
            self.archive(build.DIST, {"app/resources/app/package.json": (b'{"name":"other-package","version":"0.2.1-alpha.2"}', 0o644, tarfile.REGTYPE)})
            with self.assertRaisesRegex(RuntimeError, "identity"):
                build.verify()
            self.assertFalse((build.DIST / "SHA256SUMS").exists())

    def test_world_writable_and_privileged_payloads_never_write_checksums(self):
        for mode in (0o777, 0o4755, 0o444):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory, patch.object(build, "DIST", Path(directory)):
                self.archive(build.DIST, {"app/dsh-workbench": (b"desktop", mode, tarfile.REGTYPE)})
                with self.assertRaisesRegex(RuntimeError, "unsafe writable"):
                    build.verify()
                self.assertFalse((build.DIST / "SHA256SUMS").exists())

    def test_user_archive_rejects_traversal_links_special_files_and_duplicates(self):
        cases = [("../outside", tarfile.REGTYPE), ("app/../outside", tarfile.REGTYPE),
                 ("usr/bin/other", tarfile.REGTYPE), ("app/link", tarfile.SYMTYPE),
                 ("app/hardlink", tarfile.LNKTYPE), ("app/fifo", tarfile.FIFOTYPE),
                 ("app/dsh-workbench", tarfile.REGTYPE)]
        for name, kind in cases:
            with self.subTest(name=name, kind=kind), tempfile.TemporaryDirectory() as directory:
                item = tarfile.TarInfo(name)
                item.mode, item.type, item.size = 0o644, kind, 0
                if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                    item.linkname = "../../outside"
                archive = self.archive(Path(directory), extra=[(item, b"")])
                with self.assertRaisesRegex(RuntimeError, "unsafe path|links, special or duplicate"):
                    build.verify_archive(archive)
                self.assertFalse((Path(directory) / "SHA256SUMS").exists())

    def test_archive_rejects_empty_executable(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = self.archive(Path(directory), {"app/dsh-workbench": (b"", 0o755, tarfile.REGTYPE)})
            with self.assertRaisesRegex(RuntimeError, "non-empty files"):
                build.verify_archive(archive)

    def test_archive_metadata_must_be_objects_and_match_host_node(self):
        for path, data, message in [
            ("app/resources/app/package.json", b"[]", "must be objects"),
            ("app/resources/runtime/primary-runtime/runtime.json", b'{"node":"24.18.1"}', "incompatible"),
            ("app/resources/app/dsh/desktop-runtime.json", b'{"platform":"linux","arch":"arm64","release":{}}', "kernel identity"),
        ]:
            with self.subTest(path=path), tempfile.TemporaryDirectory() as directory:
                archive = self.archive(Path(directory), {path: (data, 0o644, tarfile.REGTYPE)})
                with self.assertRaisesRegex(RuntimeError, message):
                    build.verify_archive(archive)

    def test_archive_name_and_build_info_include_linux_revision(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(build, "DIST", Path(directory)):
            archive = self.archive(build.DIST)
            with contextlib.redirect_stdout(io.StringIO()):
                build.verify()
            self.assertEqual(archive.name, f"dsh-workbench-{build.LOCK['version']}-r{build.DESKTOP['linuxRevision']}-linux-x64.tar.gz")
            info = json.loads((build.DIST / "build-info.json").read_text())
            self.assertEqual(info["desktopVersion"], build.LOCK["version"])
            self.assertEqual(info["linuxRevision"], build.DESKTOP["linuxRevision"])

    def test_default_packaging_does_not_require_system_package_tools(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(build, "APP", Path(directory)), patch.object(build, "pnpm"), patch.object(build, "bundle") as bundle, patch.object(build.shutil, "which", return_value=None) as which:
            build.package()
            which.assert_not_called()
            bundle.assert_called_once()

    def test_bundle_checks_primary_host_node_instead_of_electron_node(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory)
            prepared = app / ".desktop-build/targets/linux-x64"
            (prepared / "dsh").mkdir(parents=True)
            (prepared / "runtime/primary-runtime").mkdir(parents=True)
            (prepared / "dsh/desktop-runtime.json").write_text('{"release":{"hostProtocolVersion":4}}')
            (prepared / "runtime/primary-runtime/runtime.json").write_text('{"node":"24.21.0"}')
            (prepared / "runtime/versions.json").write_text('{"node":"24.18.1"}')
            with patch.object(build, "APP", app), patch.object(build, "run"), patch.object(
                build.tempfile, "TemporaryDirectory", side_effect=RuntimeError("staging reached")
            ):
                with self.assertRaisesRegex(RuntimeError, "staging reached"):
                    build.bundle()
                (prepared / "runtime/primary-runtime/runtime.json").write_text('{"node":"24.18.1"}')
                with self.assertRaisesRegex(RuntimeError, "compatibility metadata differs"):
                    build.bundle()

    def test_required_system_packages_cannot_be_silently_missing(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(build, "DIST", Path(directory)):
            self.archive(build.DIST)
            with self.assertRaisesRegex(RuntimeError, "installer"):
                build.verify(require_installers=True)
            self.assertFalse((build.DIST / "SHA256SUMS").exists())

    def test_source_is_pinned_not_a_moving_branch(self):
        self.assertRegex(build.LOCK["commit"], r"^[0-9a-f]{40}$")
        self.assertEqual(build.LOCK["repository"], "https://github.com/deepseek-ai/deepseek-harness.git")


if __name__ == "__main__":
    unittest.main()
