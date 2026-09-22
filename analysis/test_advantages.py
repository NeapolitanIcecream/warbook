import unittest
from advantages import terminal_advantages


def episode(values, reward, active=None):
    return dict(rows=[dict(tick=75*i, value=v, trainable=(active or [True]*len(values))[i])
                      for i, v in enumerate(values)], reward=reward, period=75,
                terminalTick=75*(len(values)-1)+30)


class AdvantageTests(unittest.TestCase):
    def test_lambda_one_is_terminal_mc_for_wins_losses_and_unresolved_games(self):
        games=[episode([.2,.7,.3,.8],1.,[True,False,False,True]),
               episode([.8,.3],0.), episode([.4],0.)]
        actual=terminal_advantages(games,1.)
        expected=[e['reward']-r['value'] for e in games for r in e['rows']]
        self.assertEqual(len(actual),len(expected))
        for a,b in zip(actual,expected):self.assertAlmostEqual(a,b,places=12)

    def test_forced_keep_transitions_participate_and_terminal_reward_is_given_once(self):
        game=episode([.2,.7,.3,.8],1.,[True,False,False,True])
        actual=terminal_advantages([game],.99)
        # Weighted TD residuals: +.5, -.4, +.5, +.2. No broadcast +1 rewards.
        self.assertAlmostEqual(actual[0],.5 + .99*(-.4) + .99**2*.5 + .99**3*.2)
        self.assertAlmostEqual(actual[-1],.2)
        self.assertAlmostEqual(terminal_advantages([game],0.)[0],.5)

    def test_episode_boundaries_do_not_bootstrap_from_the_next_game(self):
        loss=episode([.8,.7],0.);win=episode([.2,.3],1.)
        actual=terminal_advantages([loss,win],.99)
        self.assertAlmostEqual(actual[0],-.1-.99*.7)
        self.assertAlmostEqual(actual[2],.1+.99*.7)
        self.assertLess(actual[0],0);self.assertGreater(actual[2],0)

    def test_missing_decisions_or_an_unexplained_terminal_gap_are_not_silently_compacted(self):
        game=episode([.2,.3,.4],1.);game['rows'].pop(1)
        with self.assertRaisesRegex(ValueError,'Missing'):terminal_advantages([game],.99)
        game=episode([.2,.3],1.);game['terminalTick']+=150
        with self.assertRaisesRegex(ValueError,'terminal'):terminal_advantages([game],.99)
        with self.assertRaises(ValueError):terminal_advantages([episode([.2],1.)],1.1)


if __name__=='__main__':unittest.main()
