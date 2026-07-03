# Hermes `hermes_decompose` claim extraction accuracy

## Final recommendation

Build `hermes_decompose` as a provenance-preserving deterministic extractor over real Hermes T2 export structure, not a final-message NLP parser.

Ranked approach:

1. **Structured Hermes outputs first.** Require Hermes/dispatch prompts to emit a machine-readable `verify_claims` block or tool result whenever possible; ingest it with schema validation and keep each claim linked to `messageIndex`, `toolCallId`, and evidence row. Tradeoff: best precision and easiest review, but needs prompt/persona discipline and fixtures for malformed/missing blocks. Use provider structured outputs / constrained decoding where available; OpenAI Structured Outputs constrain model responses to developer JSON Schemas and report 100% schema-following on their eval for `gpt-4o-2024-08-06` ([OpenAI](https://openai.com/index/introducing-structured-outputs-in-the-api/)). Provider-neutral constrained generation options exist, e.g. Outlines guarantees structure during generation ([Outlines](https://github.com/dottxt-ai/outlines)) and Guidance supports regex/CFG constraints ([Guidance](https://github.com/guidance-ai/guidance)).
2. **Deterministic transcript-derived claims second.** Generate claims from T2 structure: `tool_execution`, `user_requirement`, `artifact_delta`, and only then low-confidence `assistant_assertion`. Tradeoff: lower recall for prose-only completions, much lower false-positive risk.
3. **Evidence-linked atomic fact extraction third.** For assistant prose, extract only sentences/bullets that are verifiable and attach nearest prior evidence. Treat FActScore/SAFE as evaluation inspiration, not production architecture: FActScore breaks long-form generations into atomic facts and scores support percentage against a source ([FActScore paper](https://arxiv.org/abs/2305.14251), [code](https://github.com/shmsw25/FActScore)); SAFE decomposes long answers into facts and checks them with search-backed reasoning ([SAFE paper](https://arxiv.org/abs/2403.18802), [code](https://github.com/google-deepmind/long-form-factuality)). Tradeoff: useful for recall, but model-generated atoms can hallucinate or over-split.
4. **NLI only as a checker, not an extractor.** Use entailment labels only to compare a candidate claim to a specific evidence snippet. FEVER frames claims as Supported/Refuted/NotEnoughInfo with sentence evidence ([FEVER](https://arxiv.org/abs/1803.05355)); MultiNLI is the broad NLI training/evaluation reference ([MultiNLI](https://arxiv.org/abs/1704.05426)). Tradeoff: good triage signal, not sufficient proof for repo/file effects.
5. **OpenIE/SRL last.** Do not add OpenIE/SRL to v1. Stanford OpenIE extracts open-domain relation tuples from plain text ([Stanford OpenIE](https://nlp.stanford.edu/software/openie.html)); PropBank-style SRL annotates semantic roles ([PropBank](https://aclanthology.org/J05-1004/)). Tradeoff: these overproduce relation fragments on agent logs and add dependencies without solving evidence linkage.

## Spec changes for `specs/hermes-satellite-verify.md`

Replace the v1 rule “Final assistant message → extract assertion sentences (patterns + bullet lines)” with this normative split:

```md
### `hermes_decompose` claim policy

`hermes_decompose` MUST prefer structured, evidence-linked claims over heuristic prose parsing.

Claim kinds:

- `tool_execution` — deterministic. One claim per tool call/result pair. Evidence tier: T2. Max confidence before oracle: 0.95.
- `user_requirement` — deterministic when parsed from dispatch `## Acceptance` bullets or equivalent explicit acceptance sections. Max confidence before oracle: 0.90. Conversational user prose without acceptance markers is `task_request_candidate`, not a gated deterministic requirement by default.
- `artifact_delta` — deterministic only when derived from successful tool rows that report a concrete write/create/update/save/export/install/configure operation for a path, diff, commit, test artifact, or URL. Path mentions, search results, reads, and assistant `MEDIA:/path` prose are not deltas by themselves. Max confidence before oracle: 0.90.
- `structured_assistant_claim` — semi-deterministic. Parsed only from an explicit `verify_claims` JSON block that validates against the `AtomicClaim[]` schema, cites evidence ids, and records a constrained mechanism (`structuredOutputMechanism`). Prompt-only final prose JSON is candidate-only. Max confidence before oracle: 0.80 only when mechanism is forced; otherwise 0.55.
- `assistant_assertion` — heuristic fallback. Parsed only from the final assistant message when no structured claim covers the assertion. It MUST include `sourceText`, `sourceSpan`, `nearestEvidenceIds`, and `extractionReason`. Max confidence before oracle: 0.55; max final confidence: 0.70 unless an independent oracle verifies it.

Do not extract claims from summaries, pleasantries, plans, intent statements, speculation, cost commentary, or unverifiable status prose unless they cite concrete evidence.

Verifier gates:

- Report MUST include every claim id returned by `hermes_decompose`.
- Report MUST refuse PERFECT if any deterministic `user_requirement` lacks a PASS/FAIL/UNSURE verdict. Conversational `task_request_candidate` rows are reported as context unless promoted to explicit acceptance criteria.
- Report MUST refuse PERFECT if any `assistant_assertion` is PASS solely because Hermes said it.
- Confidence MUST be clamped by claim kind and evidence tier before persona judgment.
```

Add provenance fields to `AtomicClaim`:

```ts
interface AtomicClaim {
  id: string;
  kind: "tool_execution" | "user_requirement" | "task_request_candidate" | "artifact_delta" | "structured_assistant_claim" | "assistant_assertion";
  text: string;
  source: { messageIndex: number; toolCallId?: string; toolName?: string; span?: [number, number] };
  evidenceIds: string[];
  evidenceTier: "T0_result_text" | "T1_export" | "T2_state_db" | "T3_external_oracle";
  evidenceContentFormat?: "json_object" | "json_array" | "untrusted_tool_result_text" | "text" | "invalid_json_like_text" | "empty_text";
  extraction: "deterministic" | "structured" | "heuristic";
  structuredOutputMechanism?: "provider_schema" | "strict_tool" | "verify_claims_tool" | "bridge_complete_structured" | "prompt_only";
  requirementExtractionMode?: "explicit_acceptance" | "conversational_candidate" | "dispatcher_wrapper";
  artifactPath?: string;
  artifactOperation?: "wrote" | "created" | "updated" | "saved" | "exported" | "installed" | "configured";
  confidenceCap: number;
  suggestedOracle: "tool_result" | "file_path" | "git" | "test" | "url" | "nli" | "manual";
}
```

Use a small provenance graph internally: claim nodes `wasDerivedFrom` transcript/evidence nodes and `wasGeneratedBy` tool-call activity nodes, following W3C PROV’s entity/activity/agent vocabulary for trust assessment ([W3C PROV overview](https://www.w3.org/TR/prov-overview/)).


## Real Hermes T2 fixture shape evidence

Mac mini export evidence now grounds the fixture format instead of inventing one. Evidence artifact: `specs/research/artifacts/macmini-t2-fixture-shape-evidence.txt`, derived from the true MoA export `specs/research/artifacts/macmini-moa-export-20260630_081522_c6e18380.jsonl`.

Observed shape:

- `hermes sessions export --session-id ...` writes JSONL with one **session object** per line, not one message per line.
- The session object contains metadata needed for claim context: `id`, `source`, `model`, `billing_provider`, `billing_base_url`, token counters, `estimated_cost_usd`, `cost_source`, and `messages`.
- The real MoA fixture has `message_count=111` with roles: `user=11`, `assistant=48`, `tool=51`, `session_meta=1`.
- Message rows have stable extraction fields: `id`, `role`, `content`, `tool_calls`, `tool_name`, `tool_call_id`, `timestamp`, plus optional reasoning/codex fields.
- Assistant tool calls appear on `role="assistant"` rows in `tool_calls[]` with `function.name` and JSON-string `function.arguments`.
- Tool results appear on `role="tool"` rows with `tool_name`, `tool_call_id`, and JSON/text `content`.
- Final assistant prose appears as `role="assistant"` with `content` and no `tool_calls`; those rows are heuristic sources only.

Fixture consequence: v1 fixtures should use this real session-object shape directly, then optionally include a reduced `messages` slice for tiny unit tests. Avoid a made-up transcript schema as the only golden input; it will miss Hermes-specific fields like `billing_provider`, `tool_call_id`, and `tool_calls[].function.arguments`.

Minimal fixture families should now include at least these real seeds:

1. `macmini-moa-export-20260630_081522_c6e18380.jsonl` — MoA metadata present, `moa.reference` events absent, normal tool rows only; verifies MoA detection stays session-metadata based and does not produce fake verification claims from cost/model telemetry.
2. `macmini-delegate-task-20260630_142436_667c9b.json` — durable `delegate_task` assistant/tool rows; verifies `tool_execution` pairing by `tool_call_id`/function call id.
3. `macmini-structured-output-runtime-source.txt` — runtime/source evidence that normal final prose is prompt-only; verifies `structured_assistant_claim` stays candidate-only unless `structuredOutputMechanism` is recorded.




## Artifact delta extraction from real file/path evidence

Mac mini artifact evidence: `specs/research/artifacts/macmini-artifact-delta-evidence.txt`.

The true MoA export contains many path-bearing rows: terminal output, search results, skill docs, user/assistant reply context, `MEDIA:/...` assistant attachments, and successful `execute_code` rows. This proves a naive “path + created/wrote word” heuristic overmatches badly: README/docs and search results mention paths and install commands without proving this session changed those files.

`artifact_delta` must therefore be tool-backed and operation-specific:

- Strong artifact evidence: a successful tool result reports an operation line such as `Wrote /path`, `Saved /path`, `Created /path`, `Updated /path`, `Exported /path`, or an install/configure result with explicit success fields and target path.
- Best real examples: `execute_code status="success"` rows that output `Wrote /Users/aojdevstudio/diagrams/...` for `.excalidraw` and `.png` files.
- Conditional evidence: `terminal exit_code=0` can support `artifact_delta` only when the command/result itself clearly performed the write/install/configure. Plain README text, benchmark logs, discovered paths, or installer help text are not deltas.
- Non-delta evidence: `read_file`, `search_files`, `vision_analyze`, path listings, and assistant `MEDIA:/path` prose are observation/reporting evidence. They can link to an existing artifact claim but cannot create one by themselves.
- Assistant “Done, I created … MEDIA:/path” is `assistant_assertion` unless backed by a prior successful tool result for the same normalized path.

`artifact_delta` nodes should record `artifactPath`, `operation`, `producingToolCallId`, `resultMessageId`, and `operationEvidenceText`. Later assistant/media claims for the same path should dedupe against the tool-backed node rather than creating a second independent claim.

## User requirement extraction from real Discord sessions

Mac mini user-message evidence: `specs/research/artifacts/macmini-user-requirement-shape-evidence.txt`.

The true MoA fixture is a Discord session with **11** user messages, **0** explicit `## Acceptance`/`Acceptance:` sections, **8** question-like messages, and multi-turn reply/context blocks. Examples include broad comparison prompts, follow-up approvals, channel-awareness complaints, and long Discord reply context. Treating every user sentence/question as a deterministic gated `user_requirement` would overproduce obligations and make PERFECT impossible for ordinary exploratory chat.

Requirement split:

- `user_requirement` with `requirementExtractionMode="explicit_acceptance"`: explicit dispatch/acceptance sections such as `## Acceptance`, `Acceptance:`, or a dispatcher/spec wrapper. These are deterministic and must receive PASS/FAIL/UNSURE verdicts before PERFECT.
- `task_request_candidate` with `requirementExtractionMode="conversational_candidate"`: ordinary Discord/user prose, questions, approvals, and follow-ups without explicit acceptance markers. Preserve source text, message id, and sequence order; promote only actionable deliverables with clear success criteria.
- `user_requirement` with `requirementExtractionMode="dispatcher_wrapper"`: a bridge/dispatcher may wrap conversational work into explicit acceptance criteria before Hermes runs. Those wrapper criteria become deterministic; the raw user prose remains provenance context.

Gating rule: PERFECT must cover every deterministic `user_requirement`, but conversational candidates should be reported separately unless promoted by a dispatcher/spec wrapper. A user saying “Approved” or asking “So there’s a scenario where both can be used?” is context, not automatically a standalone verifier claim.

## Tool-call pairing and result-status rules from real export

Mac mini pairing evidence: `specs/research/artifacts/macmini-tool-call-pairing-evidence.txt`.

In the true MoA export, all **51** assistant tool calls have matching `role="tool"` result rows; there are **0** unmatched tool results. The stable pairing key is:

```text
messages[tool].tool_call_id == messages[assistant].tool_calls[].call_id
fallback: messages[assistant].tool_calls[].id
not key: response_item_id
```

Observed `tool_calls[].call_id` and `tool_calls[].id` are equal for all 51 calls; `response_item_id` is a separate provider response item id and must not be used as the primary result join key.

`tool_execution` claims should therefore carry both sides of the pair:

- assistant call: `messageIndex`, `messageId`, `tool_calls[].call_id`, `function.name`, parsed `function.arguments`
- tool result: `messageIndex`, `messageId`, `tool_call_id`, `tool_name`, parsed JSON `content` when possible

Status rule: a tool row is evidence that the tool returned, **not** evidence that the task succeeded. In the real export, `terminal` has `exit_code=-1` blocked/error rows and `delegate_task` result rows have `status="dispatched"` for background work. Those should produce `tool_execution` claims with `status=BLOCKED|FAILED|PENDING`, not PASS. PASS requires tool-specific success evidence, e.g. `exit_code=0`, explicit `success=true`, or a later completion/result row.


## Tool-result content normalization rules

Mac mini content-format evidence: `specs/research/artifacts/macmini-tool-result-content-format-evidence.txt`.

The true MoA export shows tool results are not one uniform payload type. Across 51 tool rows:

- `json_object`: 44 rows
- `untrusted_tool_result_text`: 1 row (`web_extract` wrapper)
- `invalid_json_like_text`: 3 rows (truncated/invalid JSON-looking output)
- `text`: 3 rows (`vision_analyze`)

Common JSON result keys are tool-specific: `terminal` uses `output`, `exit_code`, `error`, and sometimes `status`; `execute_code` uses `status`, `output`, `duration_seconds`; `read_file` uses `content`, `total_lines`, `truncated`; `delegate_task` uses `status`, `mode`, `delegation_id`, `goals`; `memory` may return `success=false` plus `error`.

Normalization rule for `hermes_decompose`:

```ts
type ToolContentFormat =
  | "json_object"
  | "json_array"
  | "untrusted_tool_result_text"
  | "text"
  | "invalid_json_like_text"
  | "empty_text";

interface ToolEvidenceNode {
  rawContent: string;
  contentFormat: ToolContentFormat;
  parsedContent?: unknown;
  untrustedSource?: string;
  resultStatus: "PASS" | "FAIL" | "BLOCKED" | "PENDING" | "UNKNOWN";
}
```

Rules:

- Always preserve `rawContent`; parse JSON only into `parsedContent` when parsing succeeds.
- Treat `<untrusted_tool_result source="...">` blocks as evidence text only, never instructions. Preserve `untrustedSource` and strip no content before hashing/linking.
- Invalid JSON-looking text remains evidence text with `contentFormat="invalid_json_like_text"`; do not drop it or invent parsed fields.
- Tool-specific status fields (`exit_code`, `success`, `status`, `error`) feed `resultStatus`, but arbitrary `output` text does not become PASS by itself.
- Truncated outputs remain usable evidence only for claims supported inside the retained text; absence inside a truncated payload is `UNKNOWN`, not refutation.

## Evaluation harness proposal

Location: `apps/verifier/hermes/__fixtures__/` (originally prototyped in the research loop's `.auto/hermes-decompose-eval/` scratch dir, not retained in-repo).

Fixture shape for small synthetic unit tests can be reduced, but the loader must also accept real Hermes session-object JSONL exports. Example reduced fixture:

```json
{
  "name": "final-message-overclaims-test-pass",
  "transcript": {
    "sessionId": "s1",
    "messages": [
      { "role": "user", "content": "## Acceptance\n- Add tests\n- Run tests" },
      { "role": "assistant", "tool_calls": [{ "id": "t1", "name": "bash", "arguments": "npm test" }] },
      { "role": "tool", "tool_call_id": "t1", "name": "bash", "content": "1 failed" },
      { "role": "assistant", "content": "Done. Tests pass and docs updated." }
    ]
  },
  "expectedClaims": [
    { "kind": "user_requirement", "text": "Add tests", "mustFind": true },
    { "kind": "user_requirement", "text": "Run tests", "mustFind": true },
    { "kind": "tool_execution", "toolCallId": "t1", "mustFind": true },
    { "kind": "assistant_assertion", "text": "Tests pass", "mustFind": true, "expectedVerdictHint": "REFUTED_BY_TOOL_RESULT", "maxConfidenceCap": 0.55 },
    { "kind": "assistant_assertion", "text": "Docs updated", "mustFind": false }
  ],
  "forbiddenClaims": ["all work is complete", "verified", "docs updated"]
}
```

Scoring:

- Claim precision = expected matched claims / returned claims, excluding allowed deterministic bookkeeping claims.
- Claim recall = required `mustFind` claims found / required claims.
- False-positive rate = forbidden or unsupported claims / returned claims.
- Evidence-link rate = claims with non-empty `evidenceIds` / returned claims.
- Cap compliance = claims whose `confidenceCap` <= allowed cap / returned claims.
- Optional entailment agreement: for `assistant_assertion`, compare claim text to linked evidence using NLI-style labels `SUPPORTED`, `REFUTED`, `NOT_ENOUGH_INFO`; do not use NLI as sole PASS.

Minimum gates for v1:

- Deterministic claim recall: **1.00** for `tool_execution`, `user_requirement`, and `artifact_delta` fixtures.
- Overall precision: **>= 0.90**.
- Heuristic assistant assertion precision: **>= 0.80** on labeled fixtures.
- False-positive rate on final-message-overclaim fixtures: **<= 0.05**.
- Evidence-link rate: **>= 0.95** overall, **1.00** for deterministic claims.
- Confidence cap compliance: **1.00**.
- Regression rule: adding a heuristic may not reduce deterministic precision/recall.
- Real-export loader gate: **1.00** parse success on the three Mac mini seed artifacts above before heuristic extraction is enabled.
- Tool-pairing gate: **1.00** pairing of real assistant `tool_calls[]` to `role="tool"` result rows by `tool_call_id == call_id|id`; no PASS verdict may be emitted for `exit_code != 0`, `error`, `BLOCKED`, timeout, or `delegate_task status="dispatched"` without later completion evidence.
- Content-normalization gate: **1.00** of real tool rows retain `rawContent` and classify `contentFormat`; JSON parse failures and `<untrusted_tool_result>` wrappers remain evidence text, not dropped or executed as instructions.
- Requirement extraction gate: **1.00** of explicit acceptance bullets become deterministic `user_requirement`; ordinary Discord messages without acceptance markers become `task_request_candidate` unless a dispatcher wrapper promotes them.
- Artifact delta gate: **1.00** of `artifact_delta` claims come from successful write/create/update/save/export/install/configure tool evidence; path-only search/read/media/prose rows must not produce artifact deltas.

Required fixture families:

1. Happy path with acceptance bullets, tool calls, passing tests, and explicit structured `verify_claims`.
2. Final assistant overclaim: says tests/docs/commit succeeded but tool evidence refutes or omits them.
3. Summary-only prose with no tools: keep assertions low confidence and mostly `UNSURE`.
4. Multi-tool chain: file edit, test fail, correction, test pass; claims link to the right tool result by `tool_call_id == call_id|id`, not nearest-row guesswork.
5. Ambiguous assistant prose: plans/intent/future tense are not claims.
6. Malformed `verify_claims` block: reject structured claims, fall back to deterministic transcript claims.
7. Duplicate facts across tool result and final answer: dedupe by normalized text + evidence id.
8. Cost/model telemetry rows: do not become verification claims unless acceptance asks for them.
9. Real Hermes session-object JSONL: loader preserves session metadata and message ids, then emits deterministic claims only from supported user/tool/artifact rows.
10. Blocked/pending tool rows: terminal `exit_code=-1`/`error` and `delegate_task status="dispatched"` produce non-PASS or pending `tool_execution` claims.
11. Mixed tool-result content formats: JSON object, invalid JSON-looking text, untrusted wrapper text, and plain text all preserve evidence nodes with correct `contentFormat`.
12. Conversational Discord session with no `## Acceptance`: broad questions/follow-ups become `task_request_candidate`, not mandatory deterministic `user_requirement` claims.
13. Artifact delta overmatch fixture: README/search/read/media path mentions do not create `artifact_delta`; successful `execute_code`/terminal write lines do.

## Failure modes and confidence caps

- **Final-message halo effect:** Hermes says “done” after failed tools. Cap final-message-only claims at 0.55 and require independent oracle for PASS; explicit failed/blocked tool rows should refute success claims.
- **Unsupported artifact assertions:** “updated docs” or `MEDIA:/path` without tool-backed write/create/update evidence. Drop or mark `assistant_assertion` with `manual` oracle; never deterministic. Naive path detection overmatches README/search/read output.
- **Over-splitting:** OpenIE/SRL-style fragments produce meaningless claims. Avoid in v1.
- **Under-splitting:** one claim says “tests and docs updated.” Split only on conjunctions that create independently verifiable predicates.
- **Requirement overproduction:** conversational Discord questions, approvals, and reply-context blocks can look like requirements. Only explicit acceptance sections are deterministic gates; keep conversational items as ordered candidates unless promoted.
- **Evidence drift:** nearest prior tool row may not support the statement. Store explicit `evidenceIds`; nearest-row linkage is a hint, not proof. Preserve raw tool content and content format so later oracles can distinguish JSON fields, plain text, truncated text, and untrusted external text.
- **Structured-output spoofing:** assistant can emit valid JSON unsupported by tools. Treat `structured_assistant_claim` as structured extraction, not verified truth; if `structuredOutputMechanism` is `prompt_only` or absent, cap it like `assistant_assertion`.
- **NLI false authority:** entailment models can miss repo-specific state. NLI can mark candidate support against text evidence, but repo/file oracles decide actual PASS.

## Practical v1 design

Do now:

- Add `artifact_delta`, `structured_assistant_claim`, provenance fields, and confidence caps to the spec.
- Build golden fixtures before production code.
- Extract deterministic claims first; normalize tool-result content, pair tool calls/results exactly, then derive artifact deltas only from successful operation-specific tool evidence before any nearest-evidence heuristic; gate heuristics by fixture precision.
- Require dispatch `## Acceptance` or a dispatcher wrapper for deterministic requirements, and prefer a real `verify_claims` tool or bridge-owned structured post-pass over prompt-only JSON in Hermes final responses.

Skip for v1:

- OpenIE/SRL dependencies.
- Heavy NLI in the extraction path.
- Search-backed SAFE-style external checking unless a claim needs web facts.

Add later when needed:

- A constrained decoder for `verify_claims` if Hermes can expose provider structured-output controls, or a recorded bridge-side `plugin_llm.complete_structured` post-pass.
- NLI reranking for assistant assertions once there are enough labeled false-positive fixtures.
