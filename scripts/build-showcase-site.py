"""Assemble Pages from explicitly selected, checksum-pinned release assets."""

import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
from urllib.parse import quote, unquote, urlsplit
from urllib.request import Request, urlopen
import zipfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("_site"))
    parser.add_argument("--assets", type=Path, help="Local bundles for an offline publication check")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    manifest = json.loads((root / "showcase/publications.json").read_text())
    repository = manifest["repository"]
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repository):
        raise ValueError("Invalid release repository")
    if args.output.exists() and any(args.output.iterdir()):
        raise ValueError("Choose an empty output directory")
    args.output.mkdir(parents=True, exist_ok=True)
    versions = set()
    file_count = 0
    for entry in manifest["releases"]:
        version = entry["version"]
        if not re.fullmatch(r"\d+\.\d+\.\d+", version) or version in versions:
            raise ValueError("Invalid or duplicate showcase version")
        versions.add(version)
        for name in entry["files"]:
            path = PurePosixPath(name)
            if path.is_absolute() or ".." in path.parts or "\\" in name:
                raise ValueError("Public filenames must stay within the version directory")
        if args.assets:
            body = (args.assets / entry["asset"]).read_bytes()
        else:
            url = "https://github.com/{}/releases/download/{}/{}".format(
                repository, quote(entry["tag"], safe=""), quote(entry["asset"], safe="")
            )
            with urlopen(Request(url, headers={"User-Agent": "warbook-showcase"}), timeout=60) as response:
                body = response.read()
        if hashlib.sha256(body).hexdigest() != entry["sha256"]:
            raise ValueError("Release bundle checksum mismatch: " + version)
        expected = {version + "/" + name for name in entry["files"]}
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            names = {info.filename for info in archive.infolist() if not info.is_dir()}
            if names - {"index.html", ".nojekyll", "SHA256SUMS"} != expected:
                raise ValueError("Bundle contents differ from the publication list")
            for name in sorted(expected):
                target = args.output / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(name))
                file_count += 1
        html = (args.output / version / "index.html").read_text()
        for ref in re.findall(r'(?:href|src|poster)="([^"]+)"', html):
            url = urlsplit(ref)
            if url.scheme or url.netloc or unquote(url.path) not in entry["files"]:
                raise ValueError("Gallery depends on an unpublished resource: " + ref)
        print("Prepared {}: {} public files".format(version, len(expected)))
    latest = manifest["latest"]
    if latest not in versions:
        raise ValueError("Latest version is not published")
    (args.output / "index.html").write_text(
        '<!doctype html><meta charset="utf-8">'
        '<meta http-equiv="refresh" content="0;url={0}/">'
        '<a href="{0}/">Warbook {0}</a>'.format(latest)
    )
    (args.output / ".nojekyll").write_text("")
    print("Pages artifact: {} versions, {} selected files".format(len(versions), file_count))


if __name__ == "__main__":
    main()
