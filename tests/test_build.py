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
            self.assertEqual(info["electronVersion"], build.DESKTOP["electronVersion"])
            self.assertEqual(build.ENV["DSH_DESKTOP_ELECTRON_VERSION"], build.DESKTOP["electronVersion"])

    def test_default_packaging_does_not_require_system_package_tools(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(build, "APP", Path(directory)), patch.object(build, "pnpm"), patch.object(build, "bundle") as bundle, patch.object(build.shutil, "which", return_value=None) as which:
            build.package()
            which.assert_not_called()
            bundle.assert_called_once()

    def test_native_packages_are_home_bootstraps_and_refuse_root_launch(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(build, "APP", Path(directory)), patch.object(build, "ROOT", Path(directory)):
            (build.ROOT / "build").mkdir()
            (build.ROOT / "build/icon.png").write_bytes(b"icon")
            (build.ROOT / "build/install-user.mjs").write_bytes(b"installer")
            node = build.APP / ".desktop-build/targets/linux-x64/runtime/primary-runtime/dependencies/node/bin/node"
            node.parent.mkdir(parents=True)
            node.write_bytes(b"node")
            archive = Path(directory) / "desktop.tar.gz"
            archive.write_bytes(b"authenticated package payload")
            output = Path(directory) / "out"
            (output / "linux-unpacked/resources").mkdir(parents=True)
            (output / "linux-unpacked/resources/icon.png").write_bytes(b"icon")

            def package_tool(args, **kwargs):
                if args[0] == "dpkg-deb":
                    tree = Path(args[-2])
                    launcher = (tree / "usr/bin/dsh-workbench").read_text()
                    self.assertIn("[ \"$(/usr/bin/id -u)\" -ne 0 ]", launcher)
                    self.assertIn("/usr/share/dsh-workbench", launcher)
                    self.assertIn("$home/Applications/dsh-linux-desktop", launcher)
                    self.assertIn('export HOME="$home"', launcher)
                    self.assertNotIn("/opt/dsh-workbench", launcher)
                    self.assertTrue((tree / "usr/share/dsh-workbench/desktop.tar.gz").is_file())
                    fake_home = Path(directory) / "home"
                    fake_home.mkdir()
                    fake_node = tree / "usr/share/dsh-workbench/node"
                    fake_node.write_text('#!/bin/sh\nset -eu\nprintf "install\\n" >> "$HOME/installs"\n'
                                         'mkdir -p "$HOME/Applications/dsh-linux-desktop/current"\n'
                                         'printf \'#!/bin/sh\\nprintf "home-app\\\\n"\\n\' > "$HOME/Applications/dsh-linux-desktop/current/dsh-workbench"\n'
                                         'chmod 755 "$HOME/Applications/dsh-linux-desktop/current/dsh-workbench"\n')
                    fake_node.chmod(0o755)
                    test_launcher = Path(directory) / "launch"
                    simulated = launcher.replace('/usr/bin/id -u', '/usr/bin/printf 1000').replace(
                        '/usr/bin/getent passwd "$uid"', f"/usr/bin/printf 'test:x:1000:1000::%s:/bin/sh\\n' '{fake_home}'"
                    ).replace('payload=/usr/share/dsh-workbench', f"payload='{tree}/usr/share/dsh-workbench'")
                    test_launcher.write_text(simulated)
                    for _ in range(2):
                        process = subprocess.Popen(["/bin/sh", test_launcher], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                        stdout, stderr = process.communicate(timeout=10)
                        self.assertEqual(process.returncode, 0, stderr)
                        self.assertEqual(stdout, b"home-app\n")
                    self.assertEqual((fake_home / "installs").read_text(), "install\n")
                    test_launcher.write_text(simulated.replace('/usr/bin/printf 1000', '/usr/bin/printf 0'))
                    process = subprocess.Popen(["/bin/sh", test_launcher], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    _, stderr = process.communicate(timeout=10)
                    self.assertEqual(process.returncode, 1)
                    self.assertIn(b"not root", stderr)
                    self.assertEqual((fake_home / "installs").read_text(), "install\n")
                    Path(args[-1]).write_bytes(b"deb")
                else:
                    top = Path(args[args.index("--define") + 1].split(" ", 1)[1])
                    rpm = top / "RPMS/x86_64/dsh-workbench.rpm"
                    rpm.parent.mkdir(parents=True, exist_ok=True)
                    rpm.write_bytes(b"rpm")

            with patch.object(build.subprocess, "run", side_effect=package_tool):
                build.package_bootstraps(output, archive)
            self.assertEqual(len(list(output.glob("*.deb"))), 1)
            self.assertEqual(len(list(output.glob("*.rpm"))), 1)

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

    def test_package_verifier_pins_bootstrap_identity_and_linux_revision(self):
        for format, result in [
            ("deb", ["dsh-workbench", f"{build.DESKTOP['version'].replace('-', '~')}-{build.DESKTOP['linuxRevision']}", "amd64"]),
            ("rpm", ["dsh-workbench", build.DESKTOP['version'].replace('-', '~'), str(build.DESKTOP['linuxRevision']), "x86_64"]),
        ]:
            with self.subTest(format=format), tempfile.TemporaryDirectory() as directory:
                package = Path(directory) / f"bootstrap.{format}"
                package.write_bytes(b"package")
                output = "\n".join(result) if format == "rpm" else None
                responses = ([output, "/usr/bin/dsh-workbench\n"] if format == "rpm"
                             else [*result, "/usr/bin/dsh-workbench\n"])
                with patch.object(build.subprocess, "check_output", side_effect=responses):
                    build.verify_package(package, format)

    def test_required_system_packages_cannot_be_silently_missing(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(build, "DIST", Path(directory)):
            self.archive(build.DIST)
            with self.assertRaisesRegex(RuntimeError, "installer"):
                build.verify(require_installers=True)
            self.assertFalse((build.DIST / "SHA256SUMS").exists())

    def test_native_package_verification_rejects_opt_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory) / "package"
            package.write_bytes(b"package")
            for format in ("deb", "rpm"):
                for listing, rejected in (("/usr/bin/dsh-workbench\n", False), ("./opt/dsh-workbench/app\n", True)):
                    version = build.DESKTOP['version'].replace('-', '~')
                    revision = build.DESKTOP['linuxRevision']
                    identity = (["dsh-workbench", f"{version}-{revision}", "amd64"] if format == "deb"
                                else f"dsh-workbench\n{version}\n{revision}\nx86_64")
                    outputs = ([*identity, listing] if format == "deb" else [identity, listing])
                    with self.subTest(format=format, listing=listing), patch.object(
                        build.subprocess, "check_output", side_effect=outputs
                    ):
                        if rejected:
                            with self.assertRaisesRegex(RuntimeError, "must not install"):
                                build.verify_package(package, format)
                        else:
                            build.verify_package(package, format)

    def test_source_is_pinned_not_a_moving_branch(self):
        self.assertRegex(build.LOCK["commit"], r"^[0-9a-f]{40}$")
        self.assertEqual(build.LOCK["repository"], "https://github.com/deepseek-ai/deepseek-harness.git")


if __name__ == "__main__":
    unittest.main()
