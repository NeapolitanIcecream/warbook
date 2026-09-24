import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

import psutil

from experiment_deadline import live, scope_processes, stop_scope


class ResourceScopeTests(unittest.TestCase):
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
