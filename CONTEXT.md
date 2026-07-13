# Hermes Satellite

Hermes Satellite is a verified remote-execution product: it dispatches work to Hermes and returns results that have been checked independently of the executor.

## Language

**User**:
The person who owns or operates a Hermes Host and dispatches work through Hermes Satellite.
_Avoid_: Customer, operator account

**Hermes**:
The agent that executes dispatched work on a Hermes Host. Hermes is never the verifier of its own work.
_Avoid_: Verifier, Satellite verifier

**Hermes Host**:
The user-controlled machine on which Hermes and the Task Engine execute dispatched work.
_Avoid_: Bridge host, worker box

**Dispatcher**:
A control-plane role that accepts work from Dispatch Surfaces, submits it to the Task Engine, receives task state and Evidence, invokes the Satellite Verifier, and sends corrective follow-ups when verification does not close the loop. The Dispatcher may share a machine with the Hermes Host but never its process, context, or authority.
_Avoid_: Dispatch Surface, Orchestrator, caller

**Dispatch Surface**:
A User-facing client such as a local agent, CLI, or managed web application that sends requests to the Dispatcher and presents task progress and Verified Results. It does not execute Hermes work or author verification judgment.
_Avoid_: Dispatcher, verifier, protocol adapter

**Task Engine**:
The protocol-neutral authority for task lifecycle, continuation, evidence, verification state, and cost records.
_Avoid_: MCP server, A2A server

**Task**:
A stable unit of User intent and acceptance criteria that spans every Hermes Execution and verification pass required to close the loop. Corrective work remains inside the same Task unless the User's objective materially changes.
_Avoid_: Execution, child task, Hermes run

**Execution**:
One immutable Hermes run within a Task. An Execution records its own status, result, evidence references, and cost snapshot; corrective follow-ups create new Executions under the same Task.
_Avoid_: Task, attempt task

**Execution Status**:
The lifecycle state of one Execution: queued, running, succeeded, failed, cancelled, or timed out. A succeeded Execution does not close its Task.
_Avoid_: Task Outcome, Verification State

**Context**:
An optional grouping for related Tasks and Messages. Context does not own execution lifecycle or verification state.
_Avoid_: Task, Hermes session

**Message**:
An immutable communication record within a Task or Context, authored by the User, Dispatcher, Hermes, Satellite Verifier, or system. A Message may trigger an Execution but is not itself an Execution.
_Avoid_: Artifact, Execution

**Artifact**:
An immutable or explicitly versioned output reference with producer, media type, digest, size, storage location, sensitivity, and retention metadata. Artifact bodies may remain local while authorized metadata and references travel through Protocol Adapters.
_Avoid_: Message, transcript body

**Evidence**:
An Artifact used to support verification, carrying evidence tier, provenance, completeness, capture time, and associated Execution. Verification Reports reference Evidence identifiers instead of embedding full evidence bodies.
_Avoid_: Verification Report, result prose

**Task Trace**:
The ordered, durable history of a Task's Messages, Executions, Evidence references, Verification Reports, corrective decisions, events, and Cost Records.
_Avoid_: Transcript, chat history

**Continuation**:
A Message added to an active Task while its original User intent and acceptance criteria remain stable. It may trigger a new Execution; a materially changed objective creates a new Task in the same Context instead.
_Avoid_: New task, child task

**Task Event**:
An immutable, uniquely identified change in a Task Trace with a monotonic per-Task sequence. Task Events are committed before delivery and support cursor-based replay.
_Avoid_: Callback, notification

**Subscription**:
An at-least-once delivery view over Task Events beginning at a cursor. Protocol streams, callbacks, local IPC, and Managed Relay wakeups are delivery adapters; polling after a cursor is the recovery path.
_Avoid_: Event log, callback URL

**Cost Record**:
An immutable, itemized usage and monetary record for one Execution, verification pass, or other Task component. Task cost is the derived total for the complete execution-and-verification loop, with actual, estimated, subscription-included, unreconciled, and unknown bases kept distinct.
_Avoid_: Cumulative snapshot total, Hermes-only cost

**Protocol Adapter**:
A boundary that maps an external protocol such as MCP or A2A onto the Task Engine without owning task semantics.
_Avoid_: Task Engine

**Satellite Verifier**:
An independent, read-only verification role owned by the Dispatcher side. After Hermes reports a terminal result, it inspects Hermes's claims, transcript evidence, and resulting world state, then either closes the loop with a Verification Report or sends corrective work back through the Dispatcher.
_Avoid_: Local Verifier, Hermes verifier, host verifier

**Local Pi Verifier**:
The separate verifier used for local Pi builder sessions. It is not the Satellite Verifier and is outside the Hermes Satellite dispatch loop.
_Avoid_: Satellite Verifier

**Verified Result**:
Hermes's final response paired with an independent Verification Report grounded in transcript evidence and world-state checks.
_Avoid_: Result, completion message

**Verification Report**:
A structured judgment authored by the Dispatcher-owned Satellite Verifier that states what was checked, the Evidence used, unresolved claims, and the confidence permitted by that Evidence. The Task Engine persists and serves the report but never authors or changes its judgment.
_Avoid_: Hermes summary, transcript

**Verification State**:
The Task Engine's durable projection of valid Verification Reports for a Task. It exposes the Satellite Verifier's latest judgment without making that judgment itself.
_Avoid_: Execution Status, Hermes result

**Task Outcome**:
The terminal disposition of a Task: verified, failed, cancelled, or unverifiable. It remains unset while execution, verification, or corrective work can continue.
_Avoid_: Execution Status, Hermes completion

**Execution Cancellation**:
A request to stop one running or queued Execution without abandoning its Task. The Task remains open for retry, correction, or verification.
_Avoid_: Task Cancellation

**Task Cancellation**:
The terminal abandonment of the User's intent. It prevents new Executions and cannot be overwritten by late Execution results, which remain trace events only.
_Avoid_: Execution Cancellation, process termination

**Connectivity Mode**:
One of the supported ways a Dispatch Surface reaches the User-installed Dispatcher: Local, Private, Public Edge, or Managed. Connectivity Modes are technical deployment choices, not Commercial Tiers; the Dispatcher-to-Host boundary remains local and unchanged.
_Avoid_: Tier, plan

**Local Mode**:
A Connectivity Mode in which same-machine Dispatch Surfaces reach the Dispatcher over loopback without an external account or network service.

**Private Mode**:
A Connectivity Mode in which User-owned private networking connects enrolled remote Dispatch Surfaces to the Dispatcher without public exposure.

**Public Edge Mode**:
A Connectivity Mode in which User-owned Cloudflare Tunnel and Access expose the locally bound Dispatcher to authorized Dispatch Surfaces through a protected hostname.
_Avoid_: Cloudflare mode, public bind

**Managed Mode**:
A Connectivity Mode in which AOJ-operated identity, Dispatch Surfaces, and a Managed Relay reach the User-installed Dispatcher runtime through an outbound Dispatcher connection. The Hermes Host service never connects to or becomes reachable through the relay. The User does not need Cloudflare or private-network infrastructure, and verification still executes locally under the Dispatcher.

**Managed Relay**:
AOJ-operated control-plane infrastructure that routes task envelopes and small Verified Results between managed Dispatch Surfaces and the User-installed Dispatcher over an outbound installation connection. It is not a repository, Artifact, transcript store, Task Engine, or verifier.
_Avoid_: Cloudflare Tunnel, bulk data plane

**Commercial Tier**:
A future pricing and entitlement package. Commercial Tiers are deliberately separate from Connectivity Modes.
_Avoid_: Connectivity Mode
