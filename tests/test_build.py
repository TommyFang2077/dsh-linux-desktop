import contextlib
import io
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from scripts import build


class BuildTests(unittest.TestCase):
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

    def test_missing_installer_never_reports_success(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(build, "DIST", Path(directory)):
            with self.assertRaisesRegex(RuntimeError, "Both non-empty"):
                build.verify()
            self.assertFalse((build.DIST / "SHA256SUMS").exists())

    def test_wrong_package_identity_never_writes_checksums(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(build, "DIST", Path(directory)):
            for extension in ("deb", "rpm"):
                (build.DIST / f"dsh-workbench-{build.DESKTOP['version']}-x64.{extension}").write_bytes(b"package")
            version = build.DESKTOP["version"].replace("-", "~")
            with patch.object(build.subprocess, "check_output", side_effect=["other-package", version, "amd64", f"dsh-workbench\n{version}\nx86_64"]):
                with self.assertRaisesRegex(RuntimeError, "Unexpected package identity"):
                    build.verify()
            self.assertFalse((build.DIST / "SHA256SUMS").exists())

    def test_world_writable_payload_never_writes_checksums(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(build, "DIST", Path(directory)):
            for extension in ("deb", "rpm"):
                (build.DIST / f"dsh-workbench-{build.DESKTOP['version']}-x64.{extension}").write_bytes(b"package")
            version = build.DESKTOP["version"].replace("-", "~")
            listing = "-rwxrwxrwx /opt/dsh-workbench/dsh-workbench\n-rw-r--r-- resources/app/package.json\n-rw-r--r-- applications/dsh-workbench.desktop\n"
            responses = ["dsh-workbench", version, "amd64", f"dsh-workbench\n{version}\nx86_64", listing]
            with patch.object(build.subprocess, "check_output", side_effect=responses):
                with self.assertRaisesRegex(RuntimeError, "unsafe writable permissions"):
                    build.verify()
            self.assertFalse((build.DIST / "SHA256SUMS").exists())

    def test_desktop_version_is_independent_of_the_pinned_kernel(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(build, "DIST", Path(directory)), patch.object(build, "DESKTOP", {"version": "9.0.0"}):
            for extension in ("deb", "rpm"):
                (build.DIST / f"dsh-workbench-9.0.0-x64.{extension}").write_bytes(b"package")
            listing = "-rwxr-xr-x /opt/dsh-workbench/dsh-workbench\n-rw-r--r-- resources/app/package.json\n-rw-r--r-- applications/dsh-workbench.desktop\n"
            replies = ["dsh-workbench", "9.0.0", "amd64", "dsh-workbench\n9.0.0\nx86_64", listing, listing]
            with patch.object(build.subprocess, "check_output", side_effect=replies), contextlib.redirect_stdout(io.StringIO()):
                build.verify()
            self.assertTrue((build.DIST / "SHA256SUMS").exists())

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

    def test_source_is_pinned_not_a_moving_branch(self):
        self.assertRegex(build.LOCK["commit"], r"^[0-9a-f]{40}$")
        self.assertEqual(build.LOCK["repository"], "https://github.com/deepseek-ai/deepseek-harness.git")


if __name__ == "__main__":
    unittest.main()
