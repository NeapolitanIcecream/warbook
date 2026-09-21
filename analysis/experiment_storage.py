"""Lossless storage for completed experiment journals; never prune evidence.

Only decision journals listed in a completed batch are compacted. Models,
replays, manifests and outcomes stay in place. Old frozen readers can use restore.
"""
import argparse
import concurrent.futures
import gzip
import hashlib
import json
import os
import shutil
import time
from pathlib import Path


def open_text(path):
    path = Path(path)
    if path.exists():
        return path.open(encoding='utf-8')
    return gzip.open(str(path)+'.gz', 'rt', encoding='utf-8')


def digest(stream):
    sha = hashlib.sha256()
    size = 0
    for chunk in iter(lambda: stream.read(1024*1024), b''):
        sha.update(chunk)
        size += len(chunk)
    return sha.hexdigest(), size


def atomic_json(path, value):
    tmp = path.with_name(path.name+'.tmp')
    with tmp.open('w') as stream:
        stream.write(json.dumps(value, indent=2)+'\n')
        stream.flush()
        os.fsync(stream.fileno())
    tmp.replace(path)


def compact_file(path):
    path = Path(path)
    packed = Path(str(path)+'.gz')
    metadata = Path(str(path)+'.archive.json')
    if not path.exists():
        if packed.exists() and metadata.exists():
            return json.loads(metadata.read_text())
        raise FileNotFoundError(path)
    before = path.stat()
    tmp = Path(str(packed)+'.tmp')
    sha = hashlib.sha256()
    with path.open('rb') as src, tmp.open('wb') as target:
        with gzip.GzipFile(filename='', fileobj=target, mode='wb', compresslevel=3, mtime=0) as dst:
            for chunk in iter(lambda: src.read(1024*1024), b''):
                sha.update(chunk)
                dst.write(chunk)
        target.flush()
        os.fsync(target.fileno())
    with gzip.open(tmp, 'rb') as check:
        actual, size = digest(check)
    after = path.stat()
    if (actual, size) != (sha.hexdigest(), before.st_size) or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError(f'Journal changed or compressed verification failed: {path}')
    record = dict(sha256=actual, originalBytes=size, compressedBytes=tmp.stat().st_size,
                  codec='gzip', level=3)
    tmp.replace(packed)
    atomic_json(metadata, record)
    path.unlink()  # Verified lossless representation is durable before removing plaintext.
    return record


def restore_file(path):
    path = Path(path)
    packed = Path(str(path)+'.gz')
    record = json.loads(Path(str(path)+'.archive.json').read_text())
    if path.exists():
        with path.open('rb') as stream:
            if digest(stream) != (record['sha256'], record['originalBytes']):
                raise ValueError(f'Existing plaintext does not match archive: {path}')
        return record
    tmp = Path(str(path)+'.restore.tmp')
    with gzip.open(packed, 'rb') as src, tmp.open('wb') as dst:
        shutil.copyfileobj(src, dst)
        dst.flush()
        os.fsync(dst.fileno())
    with tmp.open('rb') as check:
        if digest(check) != (record['sha256'], record['originalBytes']):
            raise ValueError(f'Restore verification failed: {path}')
    tmp.replace(path)
    return record  # Keep the compressed copy; a later compact safely removes plaintext.


def completed_journals(root):
    root = Path(root).resolve()
    found = set()
    for summary_path in root.rglob('summary.json'):
        if not (summary_path.parent/'batch.json').exists():
            continue
        summary = json.loads(summary_path.read_text())
        if not isinstance(summary, dict):
            continue
        rows = summary.get('rows', [])
        if not summary.get('complete') or len(rows) != summary.get('planned'):
            continue
        for row in rows:
            directory = Path(row['dir']).resolve()
            if not directory.is_relative_to(root):
                raise ValueError(f'Completed batch points outside requested root: {directory}')
            if not (directory/'batch-row.json').exists():
                raise ValueError(f'Missing individual completion marker: {directory}')
            path = directory/'decisions.ndjson'
            if path.exists() or Path(str(path)+'.gz').exists():
                found.add(path)
    return sorted(found)


def compact_completed(root, workers=4, restore=False):
    started = time.monotonic()
    files = completed_journals(root)
    operation = restore_file if restore else compact_file
    if restore:
        files = [p for p in files if Path(str(p)+'.archive.json').exists()]
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        records = list(pool.map(operation, files))
    report = dict(operation='restore' if restore else 'compact', files=len(records),
                  originalBytes=sum(r['originalBytes'] for r in records),
                  compressedBytes=sum(r['compressedBytes'] for r in records),
                  seconds=time.monotonic()-started, completedAt=time.time())
    atomic_json(Path(root)/'storage-report.json', report)
    return report


def require_batch_space(root, remaining_games, trace='launch', estimate_mib=None):
    # R2 launch journals measured median 6.2 / p95 22.5 / max 52.1 MiB.
    # This is a capacity forecast, not a bound on arbitrary future policies.
    estimate_mib = estimate_mib if estimate_mib is not None else (64 if trace == 'launch' else 512)
    if estimate_mib <= 0:
        raise ValueError('Storage forecast must be positive')
    free = shutil.disk_usage(root).free
    required = 50*2**30 + remaining_games*estimate_mib*2**20
    if free < required:
        raise RuntimeError(f'Batch storage forecast needs {required/2**30:.1f} GiB including 50 GiB reserve; {free/2**30:.1f} GiB available. Compact completed batches or reduce the batch.')
    return dict(freeBytes=free, requiredBytes=required, remainingGames=remaining_games,
                estimateMiBPerGame=estimate_mib)


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('operation', choices=['compact', 'restore'])
    ap.add_argument('root', type=Path)
    ap.add_argument('--workers', type=int, default=4)
    args = ap.parse_args()
    if not 1 <= args.workers <= 32:
        ap.error('Use 1..32 storage workers')
    print(json.dumps(compact_completed(args.root, args.workers, args.operation == 'restore')))
