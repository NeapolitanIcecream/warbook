import unittest
from commander_sequence import stream_batches,unique_batches,event_weight,training_action

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

if __name__=='__main__':unittest.main()
