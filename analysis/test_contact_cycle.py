import json
import tempfile
import unittest
from pathlib import Path
from contact_cycle import completed_candidates, digest


class CandidateTests(unittest.TestCase):
    def test_validated_pending_update_survives_a_training_boundary(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'models').mkdir()
            old=root/'old.json';old.write_text(json.dumps({'controlScope':'operation','weight':0}))
            new=root/'models/cycle-01-main-gae99-47-ppo.json';new.write_text(json.dumps({'controlScope':'operation','weight':1}))
            state={'current':{'main-mc-47':str(old),'main-gae99-47':str(old)},
                   'initial':{'main-mc-47':str(old),'main-gae99-47':str(old)},
                   'pending':{'main-gae99-47':{'model':str(new),'sha256':digest(new)}}}
            candidates=completed_candidates(json.loads(json.dumps(state)),'main',root,[])
            self.assertEqual(len(candidates),2)
            self.assertEqual(candidates['main-gae99-47-pending']['model'],str(new))
            self.assertEqual(state['current']['main-gae99-47'],str(old))
            new.write_text(json.dumps({'controlScope':'operation','weight':2}))
            with self.assertRaisesRegex(ValueError,'changed'):completed_candidates(state,'main',root,[])

    def test_milestones_require_validation_and_identical_models_are_deduplicated(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'models').mkdir()
            old=root/'old.json';old.write_text(json.dumps({'controlScope':'operation','weight':0}))
            saved=root/'models/cycle-02-main-mc-47-ppo.json';saved.write_text(old.read_text())
            state={'current':{'main-mc-47':str(old)},'initial':{'main-mc-47':str(old)}}
            with self.assertRaisesRegex(ValueError,'validation'):completed_candidates(state,'main',root,[3])
            (root/(saved.stem+'-parity.done.json')).write_text('{}')
            self.assertEqual(len(completed_candidates(state,'main',root,[3])),1)


if __name__=='__main__':unittest.main()
