import unittest

try:
    import torch
except ImportError:
    torch = None


@unittest.skipIf(torch is None, 'PyTorch checks run on the training server')
class ContactMigrationTests(unittest.TestCase):
    def test_predictions_and_next_adam_step_preserve_old_behavior(self):
        self.check_migration(destination=False)

    def test_destination_inputs_preserve_predictions_and_next_adam_step(self):
        self.check_migration(destination=True)

    def check_migration(self, destination):
        import launch_train as train
        if destination:
            from maneuver_migrate import extend_artifact, extend_optimizer
            old_g, new_g, old_c, new_c = 217, 217, 48, 50
            old_schema, new_schema, control = 'operation-contact-v1', 'operation-maneuver-v1', 'base'
        else:
            from contact_migrate import extend_artifact, extend_optimizer
            old_g, new_g, old_c, new_c = 212, 217, 48, 48
            old_schema, new_schema, control = 'operation-v2', 'operation-contact-v1', 'zero'
        original_config = train.G, train.C, train.K, train.SCHEMA
        torch.manual_seed(91)
        torch.set_num_threads(2)
        try:
            train.G, train.C, train.K, train.SCHEMA = old_g, old_c, 77, old_schema
            old = train.Policy()
            opt = torch.optim.Adam(old.parameters(), lr=1e-4)
            g = torch.randn(7, old_g)
            c = torch.randn(7, 77, old_c)
            mask = torch.arange(77)[None, :] < torch.tensor([1, 3, 9, 24, 40, 75, 77])[:, None]
            actions = torch.tensor([0, 1, 2, 3, 4, 5, 6])

            def step(model, optimizer, observations, candidates):
                dist, value = model(observations, candidates, mask)
                loss = -dist.log_prob(actions).mean() + (value - .7).square().mean()
                optimizer.zero_grad(); loss.backward(); optimizer.step()

            step(old, opt, g, c)  # Nonzero Adam history must survive the migration.
            artifact = dict(schema=old_schema, controlScope='operation', training={'method': 'ppo'},
                            policyVersion='test', actor=train.layers(old.actor), critic=train.layers(old.critic))
            local = extend_artifact(artifact, 'local')
            zero = extend_artifact(artifact, control)
            self.assertEqual(local['actor'], zero['actor'])
            self.assertEqual(local['critic'], zero['critic'])
            train.G, train.C, train.SCHEMA = new_g, new_c, new_schema
            extended = train.Policy()
            for net, name in [(extended.actor, 'actor'), (extended.critic, 'critic')]:
                for layer, src in zip([m for m in net if isinstance(m, torch.nn.Linear)], local[name], strict=True):
                    with torch.no_grad():
                        layer.weight.copy_(torch.tensor(src['weights']).reshape(src['input'], src['output']).T)
                        layer.bias.copy_(torch.tensor(src['bias']))
            opt_extended = torch.optim.Adam(extended.parameters(), lr=1e-4)
            opt_extended.load_state_dict(extend_optimizer(opt.state_dict()))
            with torch.no_grad():
                before, value_before = old(g, c, mask)
                after, value_after = extended(torch.cat([g, torch.randn(7, new_g-old_g)], -1),
                                              torch.cat([c, torch.randn(7, 77, new_c-old_c)], -1), mask)
                torch.testing.assert_close(before.probs, after.probs, atol=1e-6, rtol=1e-6)
                torch.testing.assert_close(value_before, value_after, atol=1e-6, rtol=1e-6)
            padded_g = torch.cat([g, torch.zeros(7, new_g-old_g)], -1)
            padded_c = torch.cat([c, torch.zeros(7, 77, new_c-old_c)], -1)
            step(old, opt, g, c)
            step(extended, opt_extended, padded_g, padded_c)
            with torch.no_grad():
                before, value_before = old(g, c, mask)
                after, value_after = extended(padded_g, padded_c, mask)
                torch.testing.assert_close(before.probs, after.probs, atol=1e-6, rtol=1e-6)
                torch.testing.assert_close(value_before, value_after, atol=1e-6, rtol=1e-6)
        finally:
            train.G, train.C, train.K, train.SCHEMA = original_config


if __name__ == '__main__':
    unittest.main()
