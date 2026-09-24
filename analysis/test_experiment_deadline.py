import json
import datetime
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

import psutil
import experiment_deadline

from experiment_deadline import live, scope_processes, stop_scope


class ResourceScopeTests(unittest.TestCase):
    def test_deadline_stops_a_stuck_final_evaluation_and_records_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);cwd=root/'source';run=root/'run';cwd.mkdir();run.mkdir()
            script=cwd/'commander_night.py'
            script.write_text('import time\nwhile True: time.sleep(1)\n')
            driver=subprocess.Popen([sys.executable,str(script),'--out',str(run)],cwd=cwd,start_new_session=True)
            (run/'state.json').write_text(json.dumps({'phase':'final-evaluation'}))
            (run/'plan.json').write_text('{}')
            now=datetime.datetime.now(datetime.timezone.utc)
            iso=lambda seconds:(now+datetime.timedelta(seconds=seconds)).isoformat()
            plan={'run':str(run),'cwd':str(cwd),'pid':driver.pid,'finalizer':'unused',
                  'trainingCutoff':iso(1),'trainingPhaseDeadline':iso(2),'evaluationDeadline':iso(3),'releaseAt':iso(4)}
            path=root/'plan.json';path.write_text(json.dumps(plan))
            try:
                result=subprocess.run([sys.executable,experiment_deadline.__file__,
                    str(path),'--out',str(root/'lease')],timeout=25,capture_output=True,text=True)
                self.assertEqual(result.returncode,0,result.stderr)
                state=json.loads((root/'lease/state.json').read_text())
                self.assertEqual(state['phase'],'released');self.assertEqual(state['remainingPids'],[])
                self.assertEqual(state['stopReason'],'Resource deadline reached')
                self.assertLess(state['releasedAt'],now.timestamp()+20)
                driver.wait(timeout=2)
            finally:
                if driver.poll() is None:driver.kill();driver.wait(timeout=2)

    def test_scoped_shutdown_includes_detached_child_and_preserves_neighbor(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);owned=root/'owned';other=root/'other';owned.mkdir();other.mkdir()
            script="""import subprocess,sys,time,json
from pathlib import Path
child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(120)'],start_new_session=True)
Path('child.json').write_text(json.dumps({'pid':child.pid}))
time.sleep(120)
"""
            parent=subprocess.Popen([sys.executable,'-c',script],cwd=owned,start_new_session=True)
            neighbor=subprocess.Popen([sys.executable,'-c','import time; time.sleep(120)'],cwd=other,start_new_session=True)
            try:
                for _ in range(100):
                    if (owned/'child.json').exists():break
                    time.sleep(.02)
                child=psutil.Process(json.loads((owned/'child.json').read_text())['pid'])
                self.assertEqual({p.pid for p in scope_processes(owned)},{parent.pid,child.pid})
                stopped=stop_scope(owned)
                self.assertIn(parent.pid,stopped);self.assertIn(child.pid,stopped)
                parent.wait(timeout=2)
                self.assertFalse(live(child));self.assertEqual(scope_processes(owned),[])
                self.assertIsNone(neighbor.poll())
            finally:
                stop_scope(owned)
                neighbor.terminate();neighbor.wait(timeout=3)


if __name__=='__main__':unittest.main()
