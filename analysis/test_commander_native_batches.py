import unittest
from launch_batch import commander_execution_flags


class CommanderExecutionFlagsTests(unittest.TestCase):
    def test_default_and_explicit_false_keep_the_original_command(self):
        self.assertEqual(commander_execution_flags({}),[])
        self.assertEqual(commander_execution_flags({'commander':True,'policy':'model','nativeFiniteBatches':False}),[])

    def test_explicit_full_commander_opt_in(self):
        for policy in ['model','teacher']:
            self.assertEqual(commander_execution_flags({'commander':True,'policy':policy,'nativeFiniteBatches':True}),['--commander-native-batches'])

    def test_invalid_or_ambiguous_activation_is_rejected(self):
        for subject in [{'nativeFiniteBatches':1},{'nativeFiniteBatches':True},
                        {'commander':True,'nativeFiniteBatches':True},
                        {'commander':True,'policy':'model','release':'frozen.json','nativeFiniteBatches':True}]:
            with self.subTest(subject=subject),self.assertRaises(ValueError):commander_execution_flags(subject)


if __name__=='__main__':unittest.main()
