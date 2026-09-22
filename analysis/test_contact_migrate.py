import unittest

try:
    import torch
except ImportError:
    torch = None


@unittest.skipIf(torch is None, 'PyTorch checks run on the training server')
class ContactMigrationTests(unittest.TestCase):
    def test_predictions_and_next_adam_step_preserve_old_behavior(self):
        import launch_train as train
        from contact_migrate import extend_artifact, extend_optimizer
        original_config = train.G, train.C, train.K, train.SCHEMA
        torch.manual_seed(91)
        torch.set_num_threads(2)
        try:
            train.G, train.C, train.K, train.SCHEMA = 212, 48, 75, 'operation-v2'
            old = train.Policy()
            opt = torch.optim.Adam(old.parameters(), lr=1e-4)
            g = torch.randn(7, 212)
            c = torch.randn(7, 75, 48)
            mask = torch.arange(75)[None, :] < torch.tensor([1, 3, 9, 24, 40, 62, 75])[:, None]
            actions = torch.tensor([0, 1, 2, 3, 4, 5, 6])

            def step(model, optimizer, observations):
                dist, value = model(observations, c, mask)
                loss = -dist.log_prob(actions).mean() + (value - .7).square().mean()
                optimizer.zero_grad(); loss.backward(); optimizer.step()

            step(old, opt, g)  # Nonzero Adam history must survive the migration.
            artifact = dict(schema='operation-v2', controlScope='operation',
                            policyVersion='test', actor=train.layers(old.actor), critic=train.layers(old.critic))
            local = extend_artifact(artifact, 'local')
            zero = extend_artifact(artifact, 'zero')
            self.assertEqual(local['actor'], zero['actor'])
            self.assertEqual(local['critic'], zero['critic'])
            train.G, train.SCHEMA = 217, 'operation-contact-v1'
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
                after, value_after = extended(torch.cat([g, torch.randn(7, 5)], -1), c, mask)
                torch.testing.assert_close(before.probs, after.probs, atol=1e-6, rtol=1e-6)
                torch.testing.assert_close(value_before, value_after, atol=1e-6, rtol=1e-6)
            step(old, opt, g)
            step(extended, opt_extended, torch.cat([g, torch.zeros(7, 5)], -1))
            with torch.no_grad():
                before, value_before = old(g, c, mask)
                after, value_after = extended(torch.cat([g, torch.zeros(7, 5)], -1), c, mask)
                torch.testing.assert_close(before.probs, after.probs, atol=1e-6, rtol=1e-6)
                torch.testing.assert_close(value_before, value_after, atol=1e-6, rtol=1e-6)
        finally:
            train.G, train.C, train.K, train.SCHEMA = original_config


if __name__ == '__main__':
    unittest.main()
