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
                (build.DIST / f"dsh-workbench-{build.LOCK['version']}-x64.{extension}").write_bytes(b"package")
            version = build.LOCK["version"].replace("-", "~")
            with patch.object(build.subprocess, "check_output", side_effect=["other-package", version, "amd64", f"dsh-workbench\n{version}\nx86_64"]):
                with self.assertRaisesRegex(RuntimeError, "Unexpected package identity"):
                    build.verify()
            self.assertFalse((build.DIST / "SHA256SUMS").exists())

    def test_world_writable_payload_never_writes_checksums(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(build, "DIST", Path(directory)):
            for extension in ("deb", "rpm"):
                (build.DIST / f"dsh-workbench-{build.LOCK['version']}-x64.{extension}").write_bytes(b"package")
            version = build.LOCK["version"].replace("-", "~")
            listing = "-rwxrwxrwx /opt/dsh-workbench/dsh-workbench\n-rw-r--r-- resources/app/package.json\n-rw-r--r-- applications/dsh-workbench.desktop\n"
            responses = ["dsh-workbench", version, "amd64", f"dsh-workbench\n{version}\nx86_64", listing]
            with patch.object(build.subprocess, "check_output", side_effect=responses):
                with self.assertRaisesRegex(RuntimeError, "unsafe writable permissions"):
                    build.verify()
            self.assertFalse((build.DIST / "SHA256SUMS").exists())

    def test_source_is_pinned_not_a_moving_branch(self):
        self.assertRegex(build.LOCK["commit"], r"^[0-9a-f]{40}$")
        self.assertEqual(build.LOCK["repository"], "https://github.com/deepseek-ai/deepseek-harness.git")


if __name__ == "__main__":
    unittest.main()
