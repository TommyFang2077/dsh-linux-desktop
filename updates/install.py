#!/usr/bin/env python3
"""Copy a verified deb/rpm into root-owned staging before invoking the system installer."""
import hashlib
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile


def stage_package(source, destination, expected_hash, expected_size):
    if not re.fullmatch(r"[0-9a-f]{64}", expected_hash) or not 0 < expected_size <= 1024 ** 3:
        raise ValueError("Invalid update hash or size")
    descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size != expected_size or info.st_nlink != 1:
            raise ValueError("Update must be a regular, non-linked file of the expected size")
        digest = hashlib.sha256()
        count = 0
        with open(destination, "xb") as output:
            os.chmod(destination, 0o600)
            while chunk := stream.read(1024 * 1024):
                count += len(chunk)
                if count > expected_size:
                    raise ValueError("Update grew while being read")
                digest.update(chunk)
                output.write(chunk)
        if count != expected_size or digest.hexdigest() != expected_hash:
            raise ValueError("Update bytes changed after download verification")


def installer_arguments(path, format):
    if format == "deb":
        return ["/usr/bin/apt-get", "install", "-y", "--", str(path)]
    if format == "rpm":
        return ["/usr/bin/dnf", "install", "-y", "--", str(path)]
    raise ValueError("Unsupported package format")


def verify_identity(path, format, version, revision, execute=subprocess.check_output):
    if type(revision) is not int or not 0 < revision < 2 ** 53:
        raise ValueError("Invalid Linux revision")
    expected = version.replace("-", "~")
    if format == "deb":
        metadata = [execute(["/usr/bin/dpkg-deb", "--field", str(path), field], text=True).strip()
                    for field in ("Package", "Version", "Architecture")]
        valid = ["dsh-workbench", f"{expected}-{revision}", "amd64"]
    elif format == "rpm":
        metadata = execute(["/usr/bin/rpm", "-qp", "--queryformat", "%{NAME}\n%{VERSION}\n%{RELEASE}\n%{ARCH}", str(path)], text=True).splitlines()
        valid = ["dsh-workbench", expected, str(revision), "x86_64"]
    else:
        raise ValueError("Unsupported package format")
    if metadata != valid:
        raise ValueError("Package identity, version or architecture mismatch")


def main():
    if os.geteuid() != 0:
        raise PermissionError("Launch through the desktop's graphical authorization dialog")
    if len(sys.argv) != 7:
        raise ValueError("Expected path, format, version, revision, sha256 and size")
    source, format, version, revision, checksum, size = sys.argv[1:]
    if not re.fullmatch(r"[0-9A-Za-z.+-]{1,100}", version):
        raise ValueError("Invalid version")
    installer_arguments(Path("unused"), format)
    os.environ.clear()
    os.environ.update(PATH="/usr/sbin:/usr/bin:/sbin:/bin", LANG="C.UTF-8", HOME="/root")
    with tempfile.TemporaryDirectory(prefix="dsh-workbench-update-", dir="/var/tmp") as directory:
        path = Path(directory) / f"dsh-workbench.{format}"
        stage_package(source, path, checksum, int(size))
        verify_identity(path, format, version, int(revision))
        subprocess.run(installer_arguments(path, format), check=True)


if __name__ == "__main__":
    main()
