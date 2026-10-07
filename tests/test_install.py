import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location("workbench_install", Path(__file__).resolve().parents[1] / "updates/install.py")
install = importlib.util.module_from_spec(spec)
spec.loader.exec_module(install)


class InstallTests(unittest.TestCase):
    def test_staged_copy_is_independent_and_matches_verified_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            source, destination = Path(directory) / "update.deb", Path(directory) / "staged.deb"
            source.write_bytes(b"verified archive")
            checksum = hashlib.sha256(source.read_bytes()).hexdigest()
            install.stage_package(source, destination, checksum, source.stat().st_size)
            source.write_bytes(b"changed after staging")
            self.assertEqual(destination.read_bytes(), b"verified archive")
            self.assertEqual(destination.stat().st_mode & 0o777, 0o600)

    def test_wrong_hash_and_symlink_never_reach_installer(self):
        with tempfile.TemporaryDirectory() as directory:
            source, destination = Path(directory) / "update.rpm", Path(directory) / "staged.rpm"
            source.write_bytes(b"untrusted")
            with self.assertRaisesRegex(ValueError, "bytes changed"):
                install.stage_package(source, destination, "0" * 64, source.stat().st_size)
            link = Path(directory) / "symlink"
            link.symlink_to(source)
            with self.assertRaises(OSError):
                install.stage_package(link, Path(directory) / "other", "0" * 64, 9)

    def test_identity_check_rejects_another_package(self):
        execute = Mock(side_effect=["unrelated-package", "1.2.0", "amd64"])
        with self.assertRaisesRegex(ValueError, "identity"):
            install.verify_identity(Path("/tmp/package.deb"), "deb", "1.2.0", 2, execute)
        rpm = Mock(return_value="dsh-workbench\n1.2.0~rc.1\n2\nx86_64")
        install.verify_identity(Path("/tmp/package.rpm"), "rpm", "1.2.0-rc.1", 2, rpm)

    def test_identity_includes_linux_revision_for_both_formats(self):
        deb = Mock(side_effect=["dsh-workbench", "1.2.0~rc.1-2", "amd64"])
        install.verify_identity(Path("/tmp/package.deb"), "deb", "1.2.0-rc.1", 2, deb)
        for format, fields in [("deb", ["dsh-workbench", "1.2.0~rc.1-1", "amd64"]),
                               ("rpm", "dsh-workbench\n1.2.0~rc.1\n1\nx86_64")]:
            execute = Mock(side_effect=fields) if format == "deb" else Mock(return_value=fields)
            with self.assertRaisesRegex(ValueError, "identity"):
                install.verify_identity(Path("/tmp/package"), format, "1.2.0-rc.1", 2, execute)

    def test_install_uses_absolute_system_tools_without_a_shell(self):
        path = Path("/var/tmp/private dir/package.deb")
        self.assertEqual(install.installer_arguments(path, "deb"), ["/usr/bin/apt-get", "install", "-y", "--", str(path)])
        self.assertEqual(install.installer_arguments(path, "rpm")[0], "/usr/bin/dnf")
        with self.assertRaises(ValueError):
            install.installer_arguments(path, "shell")


if __name__ == "__main__":
    unittest.main()
