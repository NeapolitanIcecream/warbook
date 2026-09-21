import json
import tempfile
import unittest
from pathlib import Path
from operation_overnight import checkpoint_artifact, final_subjects

class CheckpointTests(unittest.TestCase):
    def test_validated_update_survives_restart_before_development_selection(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);start=root/'start.json';start.write_text('{"weights":0}')
            updated=root/'updated.json';updated.write_text('{"weights":1}')
            state=dict(initial={'main-operation-47':str(start),'main-launch-47':str(start)},
                       reference={},current={'main-operation-47':str(start),'main-launch-47':str(start)},
                       retained={'main-operation':str(start),'main-launch':str(start)},cycle=3,routeIndex=0)
            checkpoint_artifact(state,'pendingUpdated','main-operation-47',updated)
            # Simulate the durable JSON that remains when the deadline interrupts
            # development, followed by a restart entering the final comparison.
            recovered=json.loads(json.dumps(state))
            subjects,shas=final_subjects(recovered,'main')
            self.assertIn('main-operation-47-pending',subjects)
            self.assertEqual(subjects['main-operation-47-pending']['model'],str(updated))
            self.assertEqual(recovered['retained']['main-operation'],str(start))
            self.assertEqual(recovered['current']['main-operation-47'],str(start))
            updated.write_text('{"weights":2}')
            with self.assertRaises(ValueError):final_subjects(recovered,'main')

if __name__=='__main__':unittest.main()
