import gzip
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from experiment_storage import compact_completed, compact_file, open_text, restore_file, require_batch_space


class StorageTests(unittest.TestCase):
    def test_roundtrip_and_frozen_reader_restore(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'decisions.ndjson'
            original = ('{"tick":75,"action":"保持"}\n'*100).encode()
            path.write_bytes(original)
            record = compact_file(path)
            self.assertFalse(path.exists())
            self.assertLess(record['compressedBytes'], record['originalBytes'])
            with open_text(path) as stream:
                self.assertEqual(stream.read().encode(), original)
            restore_file(path)
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(compact_file(path), record)
            self.assertEqual(compact_file(path), record)

    def test_corrupt_archive_is_not_restored(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'decisions.ndjson'
            path.write_text('original\n')
            compact_file(path)
            Path(str(path)+'.gz').write_bytes(gzip.compress(b'changed\n'))
            with self.assertRaises(ValueError):
                restore_file(path)
            self.assertFalse(path.exists())

    def test_only_completed_batch_members_are_compacted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name, complete in [('done',True),('active',False)]:
                batch=root/name; run=batch/'match'; run.mkdir(parents=True)
                (batch/'batch.json').write_text('{}')
                (run/'batch-row.json').write_text('{}')
                (run/'decisions.ndjson').write_text('evidence\n')
                (run/'replay.rpl').write_text('replay')
                (batch/'summary.json').write_text(json.dumps(dict(complete=complete,planned=1,rows=[dict(dir=str(run))])))
            (root/'summary.json').write_text('[]')
            report=compact_completed(root)
            self.assertEqual(report['files'],1)
            self.assertTrue((root/'active/match/decisions.ndjson').exists())
            self.assertEqual((root/'done/match/replay.rpl').read_text(),'replay')

    def test_budget_includes_next_batch_not_just_watermark(self):
        with patch('experiment_storage.shutil.disk_usage') as usage:
            usage.return_value.free=51*2**30
            require_batch_space('.',16)
            with self.assertRaises(RuntimeError):
                require_batch_space('.',17)


if __name__ == '__main__':
    unittest.main()
