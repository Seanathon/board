#!/usr/bin/env python3
"""Prepare a NEW private, nonexecutable preview input directory. Run with Python -I."""
import argparse, hashlib, json, os, pathlib, shutil, tarfile, tempfile

def digest_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''): h.update(block)
    return h.hexdigest()

def main():
    p = argparse.ArgumentParser(); p.add_argument('archive'); p.add_argument('selection'); p.add_argument('bundle'); a = p.parse_args()
    selection = json.loads(pathlib.Path(a.selection).read_text()); expected = selection['provenance']['archiveSha256']
    assert pathlib.Path(a.archive).stat().st_size <= 300 * 1024**2 and digest_file(a.archive) == expected, 'Archive hash/size mismatch'
    paths = {asset['path'] for asset in selection['assets']}
    asset_files = []
    root = pathlib.Path(tempfile.mkdtemp(prefix='board-radiator-preview-'))
    with tarfile.open(a.archive, 'r:') as archive:
        members = archive.getmembers(); assert len(members) <= 1000 and sum(m.size for m in members) <= 300 * 1024**2
        names = {}
        for member in members:
            path = pathlib.PurePosixPath(member.name); normalized = str(path)
            assert not path.is_absolute() and '..' not in path.parts and normalized not in names and (member.isfile() or member.isdir()) and member.size <= 32 * 1024**2, 'Unsafe archive member'
            names[normalized] = member
        for name in paths:
            path = pathlib.PurePosixPath(name)
            assert len(path.parts) == 2 and path.parts[0] == 'screenshots' and path.suffix.lower() in {'.png', '.jpg', '.jpeg', '.webp'}
            member = names[name]; assert member.isfile()
            target = root.joinpath(*path.parts); target.parent.mkdir(mode=0o700, exist_ok=True)
            with archive.extractfile(member) as source, open(target, 'xb') as dest: shutil.copyfileobj(source, dest, 1024 * 1024)
            target.chmod(0o600); assert target.stat().st_size == member.size
            asset_files.append({'path': name, 'bytes': member.size, 'sha256': digest_file(target)})
    for src, name in [(a.selection, 'selection.json'), (a.bundle, 'bundle.json')]:
        with open(src, 'rb') as source, open(root/name, 'xb') as dest: shutil.copyfileobj(source, dest)
        (root/name).chmod(0o600)
    asset_manifest = {'format': 'board-radiator-assets/1', 'archiveSha256': expected, 'files': sorted(asset_files, key=lambda x: x['path'])}
    (root/'asset-manifest.json').write_text(json.dumps(asset_manifest, sort_keys=True, separators=(',', ':')) + '\n'); (root/'asset-manifest.json').chmod(0o600)
    marker = {'assetManifestSha256': digest_file(root/'asset-manifest.json'), 'format': 'board-radiator-preview-input/1', 'archiveSha256': expected, 'selectionSha256': digest_file(root/'selection.json'), 'bundleSha256': digest_file(root/'bundle.json'), 'assets': len(paths)}
    (root/'preview-input.json').write_text(json.dumps(marker)); (root/'preview-input.json').chmod(0o600)
    print(json.dumps({'dataDir': str(root), **marker}))
if __name__ == '__main__': main()
