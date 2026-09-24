import unittest
from commander_sequence import stream_batches,unique_batches,event_weight,training_action,canonical_action

class SequenceTests(unittest.TestCase):
    def test_adjacent_chunks_carry_episode_identity_and_use_every_frame_once(self):
        episodes=[{'path':str(n),'rows':list(range(k))} for n,k in enumerate([3,17,8,1,12])]
        batches=stream_batches(episodes,4,2);seen={e['path']:[] for e in episodes}
        for batch in batches:
            for e,start in batch:seen[e['path']].extend(e['rows'][start:start+4])
        self.assertEqual(seen,{e['path']:e['rows'] for e in episodes})
    def test_two_and_five_windows_pad_with_zero_work(self):
        a=unique_batches([0,1],4,2);b=unique_batches(list(range(5)),4,2)
        self.assertEqual(a,[[0,1],[]]);self.assertEqual(b,[[0,1,2,3],[4]])
    def test_changed_actions_receive_training_weight_without_changing_their_labels(self):
        a={'units':[18],'placements':[0,0],'queues':[0]*6}
        self.assertEqual(event_weight(a,32),1)
        a['units']=[17];self.assertEqual(event_weight(a,32),32)
        self.assertEqual(a['units'],[17])
    def test_expert_labels_never_replace_executed_ppo_actions(self):
        row={'action':{'units':[18]},'teacherAction':{'units':[17]}}
        self.assertEqual(training_action(row,'bc'),{'units':[17]})
        self.assertEqual(training_action(row,'ppo'),{'units':[18]})
        self.assertEqual(row['action'],{'units':[18]})
    def test_v2_migration_preserves_explicit_teacher_membership_semantics(self):
        world={'previousRoles':[2,3,19],'previousKinds':[0,0,8,4]+[0]*12}
        action={'kinds':[0,0,6,0]+[0]*12,'units':[18,3,19]}
        self.assertEqual(canonical_action(action,world,'graph-plan-v2')['units'],[2,18,18])
        self.assertEqual(action['units'],[18,3,19])
        self.assertIs(canonical_action(action,world,'graph-plan-v1'),action)

    def test_v3_bc_edits_include_membership_confirmation_when_a_task_changes_kind(self):
        world={'previousRoles':[2],'previousKinds':[1,1,8]+[1]*13}
        action={'queues':[0]*6,'kinds':[0,0,6]+[0]*13,'units':[18],'buildings':[],'placements':[0,0]}
        label=canonical_action(action,world,'graph-plan-v3')
        self.assertEqual(label['units'],[2])
        self.assertEqual(label['edits'],[0,1,1,0,0])
        self.assertNotIn('edits',action)

    def test_ppo_preserves_open_review_gates_even_when_the_resulting_plan_keeps_everything(self):
        executed={'queues':[0]*6,'kinds':[0]*16,'units':[18],'buildings':[],'placements':[0,0],'edits':[1,1,1,0,0]}
        row={'action':executed,'teacherAction':{**executed,'edits':[0]*5}}
        self.assertIs(training_action(row,'ppo'),executed)
        self.assertEqual(training_action(row,'ppo')['edits'],[1,1,1,0,0])

if __name__=='__main__':unittest.main()
