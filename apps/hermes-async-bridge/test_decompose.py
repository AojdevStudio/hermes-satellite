import os
import sys
import unittest
from pathlib import Path

BRIDGE_DIR = Path(__file__).resolve().parent
REPO_ROOT = BRIDGE_DIR.parents[1]
sys.path.insert(0, str(BRIDGE_DIR))
os.environ["HERMES_ASYNC_BRIDGE_REPO"] = str(REPO_ROOT)

import hermes_async_bridge


class DecomposeWithRepoTest(unittest.TestCase):
    def test_decompose_with_repo_accepts_multiline_transcript_jsonl(self) -> None:
        transcript_jsonl = "\n".join(
            [
                '{"session_id":"s1","role":"assistant","tool_calls":[{"id":"t1","name":"bash","function":{"arguments":"pnpm test"}}]}',
                '{"session_id":"s1","role":"tool","tool_call_id":"t1","name":"bash","content":"1 passed"}',
                '{"session_id":"s1","role":"assistant","content":"Done. All tests pass."}',
            ]
        )
        original_prompt = "## Acceptance\n- Decompose multi-line transcripts\n"

        output = hermes_async_bridge.decompose_with_repo(transcript_jsonl, original_prompt)

        claims = output["claims"]
        self.assertTrue(claims)
        self.assertTrue(any(claim["kind"] == "user_requirement" for claim in claims))
        self.assertTrue(any(claim["kind"] == "tool_execution" for claim in claims))


if __name__ == "__main__":
    unittest.main()
