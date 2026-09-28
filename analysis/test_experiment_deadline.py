import json
import datetime
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import psutil
import experiment_deadline

from experiment_deadline import cleanup_initialization_gate, live, scope_processes, stop_scope


class InitializationGateCleanupTests(unittest.TestCase):
    def test_old_plans_do_not_add_gate_checks(self):
        with patch.object(experiment_deadline, 'scope_processes', side_effect=AssertionError):
            self.assertIsNone(cleanup_initialization_gate({}, '/unused/run', '/unused/source'))

    def test_outside_root_root_itself_and_symlink_escape_are_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);run=root/'run';outside=root/'outside';cwd=root/'source'
            run.mkdir();outside.mkdir();cwd.mkdir();(outside/'owner.json').write_text('{}')
            (run/'alias').symlink_to(outside, target_is_directory=True)
            for gate in [run,outside,run/'alias']:
                with self.subTest(gate=gate), self.assertRaisesRegex(ValueError,'strictly inside'):
                    cleanup_initialization_gate({'initializationGate':str(gate)},run,cwd)
            self.assertEqual((outside/'owner.json').read_text(),'{}')

    def test_actual_scoped_process_must_stop_before_dead_and_partial_files_are_removed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);run=root/'run';cwd=root/'source';run.mkdir();cwd.mkdir();gate=run/'initialization-gate';gate.mkdir()
            script=r"""import json,os,sys,time
from pathlib import Path
g=Path(sys.argv[1]);pid=os.getpid()
(g/'owner.json').write_text(json.dumps({'pid':pid}))
(g/f'pending-0000000000000001-{pid}-partial.json').write_text('{"pid":')
(g/'state.json').write_text('{"nextAllowedAtMs": 123456789}\n')
(g/'ready').write_text('ready')
time.sleep(120)
"""
            process=subprocess.Popen([sys.executable,'-c',script,str(gate)],cwd=cwd,start_new_session=True)
            try:
                for _ in range(100):
                    if (gate/'ready').exists():break
                    time.sleep(.02)
                self.assertTrue((gate/'ready').exists())
                plan={'initializationGate':str(gate)}
                with self.assertRaisesRegex(RuntimeError,'live users'):
                    cleanup_initialization_gate(plan,run,cwd)
                stopped=stop_scope(cwd);self.assertIn(process.pid,stopped);process.wait(timeout=2)
                before=(gate/'state.json').read_bytes()
                receipt=cleanup_initialization_gate(plan,run,cwd)
                self.assertTrue(receipt['complete'])
                self.assertEqual({r['file'] for r in receipt['removed']},{'owner.json',f'pending-0000000000000001-{process.pid}-partial.json'})
                self.assertIn('partial-or-malformed',[r['content'] for r in receipt['removed']])
                self.assertEqual((gate/'state.json').read_bytes(),before)
                self.assertTrue((gate/'ready').exists())
            finally:
                if process.poll() is None:process.kill();process.wait(timeout=2)

    def test_live_pid_in_owner_or_partial_ticket_refuses_cleanup(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);run=root/'run';cwd=root/'source';run.mkdir();cwd.mkdir();gate=run/'gate';gate.mkdir()
            plan={'initializationGate':str(gate)}
            for name,text in [('owner.json',json.dumps({'pid':os.getpid()})),
                              (f'pending-0000000000000001-{os.getpid()}-partial.json','{')]:
                path=gate/name;path.write_text(text)
                with self.subTest(name=name),self.assertRaisesRegex(RuntimeError,'live PID'):
                    cleanup_initialization_gate(plan,run,cwd)
                self.assertEqual(path.read_text(),text);path.unlink()

    def test_external_gate_flag_user_blocks_even_with_malformed_owner(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);run=root/'run';cwd=root/'source';other=root/'other'
            for p in [run,cwd,other]:p.mkdir()
            gate=run/'gate';gate.mkdir();(gate/'owner.json').write_text('{')
            for flags in [['--initialization-gate',str(gate)],['--initialization-gate=../run/gate']]:
                process=subprocess.Popen([sys.executable,'-c','import time; time.sleep(120)',*flags],cwd=other,start_new_session=True)
                try:
                    with self.subTest(flags=flags),self.assertRaisesRegex(RuntimeError,'live users'):
                        cleanup_initialization_gate({'initializationGate':str(gate)},run,cwd)
                    self.assertEqual((gate/'owner.json').read_text(),'{')
                    self.assertIsNone(process.poll())
                finally:
                    process.terminate();process.wait(timeout=3)

    def test_ephemeral_symlink_is_preserved_and_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);run=root/'run';cwd=root/'source';run.mkdir();cwd.mkdir();gate=run/'gate';gate.mkdir()
            outside=root/'outside.json';outside.write_text('{}');(gate/'owner.json').symlink_to(outside)
            with self.assertRaisesRegex(ValueError,'not regular'):
                cleanup_initialization_gate({'initializationGate':str(gate)},run,cwd)
            self.assertTrue((gate/'owner.json').is_symlink());self.assertEqual(outside.read_text(),'{}')

    def test_supervisor_cleans_before_finalizer_and_records_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);cwd=root/'source';run=root/'run';cwd.mkdir();run.mkdir();gate=run/'initialization-gate';gate.mkdir()
            script=cwd/'commander_night.py'
            script.write_text('import json,os,sys,time\nfrom pathlib import Path\n'
                'g=Path(sys.argv[sys.argv.index("--out")+1])/"initialization-gate"\n'
                '(g/"owner.json").write_text(json.dumps({"pid":os.getpid()}))\n'
                '(g/f"pending-0000000000000001-{os.getpid()}-partial.json").write_text("{")\n'
                '(g/"state.json").write_text("{\\\"nextAllowedAtMs\\\": 123456789}")\n'
                '(g/"ready").write_text("ready")\nwhile True: time.sleep(1)\n')
            finalizer=root/'finalizer.py'
            finalizer.write_text('import json,sys\nfrom pathlib import Path\n'
                'p=json.loads(Path(sys.argv[1]).read_text());g=Path(p["initializationGate"])\n'
                'assert not (g/"owner.json").exists() and not list(g.glob("pending-*.json"))\n'
                'assert json.loads((g/"state.json").read_text())["nextAllowedAtMs"]==123456789\n'
                'out=Path(sys.argv[sys.argv.index("--out")+1]);out.mkdir()\n'
                '(out/"gate-clean.json").write_text(json.dumps({"verified":True}))\n')
            driver=subprocess.Popen([sys.executable,str(script),'--out',str(run)],cwd=cwd,start_new_session=True,stderr=subprocess.DEVNULL)
            try:
                for _ in range(100):
                    if (gate/'ready').exists():break
                    time.sleep(.02)
                self.assertTrue((gate/'ready').exists())
                (run/'state.json').write_text(json.dumps({'phase':'sampling'}))
                (run/'plan.json').write_text(json.dumps({'initializationGate':str(gate)}))
                now=datetime.datetime.now(datetime.timezone.utc)
                iso=lambda seconds:(now+datetime.timedelta(seconds=seconds)).isoformat()
                plan={'run':str(run),'cwd':str(cwd),'pid':driver.pid,'finalizer':str(finalizer),
                      'trainingCutoff':iso(1),'trainingPhaseDeadline':iso(2),'evaluationDeadline':iso(90),'releaseAt':iso(95)}
                path=root/'plan.json';path.write_text(json.dumps(plan))
                result=subprocess.run([sys.executable,experiment_deadline.__file__,str(path),'--out',str(root/'lease')],timeout=25,capture_output=True,text=True)
                self.assertEqual(result.returncode,0,result.stderr)
                state=json.loads((root/'lease/state.json').read_text())
                self.assertEqual(state['finalizerExit'],0);self.assertTrue(state['initializationGateCleanup']['complete'])
                self.assertEqual(len(state['initializationGateCleanup']['removed']),2)
                self.assertTrue(json.loads((root/'lease/finalization/gate-clean.json').read_text())['verified'])
                driver.wait(timeout=2)
            finally:
                if driver.poll() is None:driver.kill();driver.wait(timeout=2)


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
