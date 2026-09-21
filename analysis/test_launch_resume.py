import tempfile
import unittest
from pathlib import Path
from launch_batch import fresh_attempt

class ResumeJournalTests(unittest.TestCase):
    def test_interrupted_journals_are_preserved_and_cannot_join_a_new_episode(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'match'
            self.assertEqual(fresh_attempt(root),root)
            old=root/'decisions.ndjson';old.write_text('{"tick":4500}\n')
            resumed=fresh_attempt(root)
            self.assertNotEqual(resumed,root)
            self.assertEqual(list(resumed.iterdir()),[])
            self.assertEqual(old.read_text(),'{"tick":4500}\n')
            (resumed/'decisions.ndjson').write_text('{"tick":75}\n')
            self.assertNotEqual(fresh_attempt(root),resumed)

if __name__=='__main__':unittest.main()
