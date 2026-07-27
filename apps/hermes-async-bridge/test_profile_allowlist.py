import importlib
import os
import unittest
from unittest.mock import patch

import hermes_async_bridge


class ProfileAllowlistTests(unittest.TestCase):
    def test_default_named_profile_allowlist_is_fitness_only(self) -> None:
        with patch.dict(os.environ):
            os.environ.pop("HERMES_ASYNC_BRIDGE_PROFILES", None)
            module = importlib.reload(hermes_async_bridge)

        self.assertEqual(module.ALLOWED_PROFILES, ("fitness",))


if __name__ == "__main__":
    unittest.main()
