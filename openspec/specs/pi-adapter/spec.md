# pi-adapter Specification

## Purpose

The Pi adapter connects the Pi coding agent to the Anureo SDK through the AHP session model. It translates Pi's in-process SDK operations and events into session requests, turn results and observation streams. The [package guide](../../../packages/adapter/pi/README.md) describes application setup and the `PiSessionHost` extension contract for alternate hosts.

## Requirements

### Requirement: Session lifecycle
The adapter SHALL open, resume and close Pi sessions through the AHP session model. Applications SHALL close sessions they no longer need or dispose the owning SDK client to release their hosts.

#### Scenario: Open a new session
- **WHEN** a client opens a session with a working directory
- **THEN** the SDK returns an attached session bound to that directory with a Pi native reference

#### Scenario: Resume an existing session
- **WHEN** a client opens a session referencing a previously persisted Pi session with a profile and configuration that enable persistence
- **THEN** the session resumes with its prior history available

#### Scenario: Close an active session
- **WHEN** a session closes successfully while a turn is active
- **THEN** the adapter detaches its event subscription, attempts to abort a busy host and awaits host disposal
- **AND** the close receipt reports closed observation and unconfirmed execution stop, and an unfinished turn result rejects with `OBSERVATION_CLOSED`

### Requirement: Turn completion
Successful turn completion SHALL wait for Pi's settlement event. Prompt acceptance and an individual assistant run ending can both precede settlement.

#### Scenario: Run end followed by automatic continuation
- **WHEN** Pi ends a run and then continues automatically (retry, recovery or queued work)
- **THEN** the turn stays active until Pi settles

#### Scenario: Observe a submitted turn
- **WHEN** a caller submits input through the SDK and that input binds to a Pi execution
- **THEN** `Session.submit` returns a turn observer and `Turn.result` waits for the execution outcome

#### Scenario: Streamed content
- **WHEN** Pi streams text, thinking and tool activity during a turn
- **THEN** the corresponding AHP items are emitted in order, with completed text items based on Pi's completed message and mapped content redacted as configured

#### Scenario: Model failure at settlement
- **WHEN** Pi settles with an unrecovered model error
- **THEN** the turn result has status `failed` and a typed error with a safe message

#### Scenario: Native abort at settlement
- **WHEN** Pi settles after aborting or the last assistant message has an aborted stop reason at settlement
- **THEN** the turn result has status `interrupted`

### Requirement: Steering and interruption
The adapter SHALL support steering and session-level interruption and distinguish queued input from extension-handled input.

#### Scenario: Steer an active turn
- **WHEN** input with native delivery is submitted while a turn is active
- **THEN** Pi receives it as steering and queued input joins the active turn

#### Scenario: Follow-up after the current work
- **WHEN** input with after-turn delivery is submitted while a turn is active
- **THEN** Pi receives it as a follow-up and queued input joins the active turn

#### Scenario: Turn-targeted controls
- **WHEN** a client calls turn-targeted steer or interrupt
- **THEN** the call fails with `CAPABILITY_UNSUPPORTED` because Pi has no turn identity to match atomically

#### Scenario: Input consumed by an extension
- **WHEN** Pi reports that an extension handled the input
- **THEN** the adapter acknowledges the input without binding it to a turn, and `Session.submit` continues waiting for a binding until the caller's wait ends

#### Scenario: Interrupt
- **WHEN** a client interrupts an active turn
- **THEN** the request acknowledges after Pi's abort call resolves and the turn reports interruption at settlement

#### Scenario: Cancel one observer of overlapping inputs
- **WHEN** an observer of an active turn is disposed and queued input joins the same turn
- **THEN** the sibling observer can still receive the shared turn result when Pi settles

### Requirement: Submission input
The adapter SHALL map text and inline base64 image input to Pi.

#### Scenario: Unsupported input
- **WHEN** a client submits a file or an image supplied only by URL
- **THEN** the request fails with `CAPABILITY_UNSUPPORTED`

### Requirement: Structured output
The SDK SHALL advertise structured output for sessions whose host exposes the direct output tool, including sessions from the embedded host.

#### Scenario: Submit a schema with the direct tool
- **WHEN** a client submits an output schema on an idle session that offers the direct tool
- **THEN** the SDK configures the tool with the submission's schema before dispatch, and accepting a valid result requests native termination on the embedded host
- **AND** the SDK publishes validated output as successful only when Pi reports successful completion
- **AND** the SDK disables the tool on terminal completion, definite submission rejection or session teardown

### Requirement: Fork, history and compaction
The adapter SHALL expose history for the current branch, fork for persisted sessions under a supporting profile and manual compaction under a supporting profile.

#### Scenario: Fork a persisted session
- **WHEN** a client forks a persisted session `before` or `through` a recognized turn boundary
- **THEN** a new session receives the matching history prefix and its own event subscription, while an open source session keeps its own branch and subscription

#### Scenario: History paging
- **WHEN** a client requests history without a snapshot token
- **THEN** the adapter snapshots the most recent configured number of mapped items in branch order, defaulting to 5,000 items and retaining all when `maxHistoryItems` is zero
- **AND** the result contains a `snapshotToken` and at most 1,000 items, with a default page size of 200
- **AND** when the result includes `nextCursor`, the client can continue the same snapshot by sending that cursor with the token

#### Scenario: Expired history snapshot
- **WHEN** a client reuses a token for a snapshot that has been evicted because the session retains only the eight most recent snapshots
- **THEN** the request fails with `CURSOR_EXPIRED` and the client can start a fresh read without the token

#### Scenario: Manual compaction
- **WHEN** a client requests compaction on a session whose profile supports it and native compaction succeeds
- **THEN** the request returns a completed receipt after native compaction and the session remains usable

#### Scenario: Compaction progress
- **WHEN** Pi reports compaction progress
- **THEN** the adapter publishes a compaction item inside an active turn or notices outside a turn

### Requirement: Configuration
The adapter SHALL expose model and thinking-level configuration, and a model catalog, using values Pi reports as available.

#### Scenario: Change model
- **WHEN** a client sets an available model using its `provider/id` reference
- **THEN** subsequent turns use that model

#### Scenario: Invalid value
- **WHEN** a client updates the configuration with an unavailable model or a thinking level unavailable for the target model
- **THEN** the request fails with `INVALID_PARAMS` before applying the patch

#### Scenario: Host failure during a configuration update
- **WHEN** a configuration patch passes validation and a native setter fails after an earlier setter succeeded
- **THEN** the request rejects before committing the configuration patch, and the earlier native change may remain in effect

#### Scenario: List models before opening a session
- **WHEN** an application calls `createPiCatalogSession`
- **THEN** it receives Pi's available model list after the temporary in-memory host has been disposed

### Requirement: Permission modes
The adapter SHALL implement `read-only` and `agent-full-access` through built-in tool allowlists and SHALL NOT advertise approval-based modes. Embedded Pi runs with the host process's credentials and filesystem rights.

#### Scenario: Read-only mode
- **WHEN** a session is configured as `read-only`
- **THEN** Pi's built-in tools are limited to `read`, `grep`, `find` and `ls`

#### Scenario: Full-access mode
- **WHEN** a session is explicitly configured as `agent-full-access`
- **THEN** the built-in tool allowlist also includes `bash`, `edit` and `write`

#### Scenario: Permission mode omitted at open
- **WHEN** the open request and its configuration omit the permission mode
- **THEN** the host keeps its native tool defaults

#### Scenario: Unsupported mode
- **WHEN** a client requests a permission mode other than the supported ones
- **THEN** the request fails with `INVALID_PARAMS`

### Requirement: Capability advertisement
The adapter SHALL choose native capabilities from the supplied Pi version and persistence policy and SHALL reject unsupported operations explicitly.

#### Scenario: Unsupported capability
- **WHEN** a client calls revert, goal or review, or configures a session with MCP servers
- **THEN** the request fails with `CAPABILITY_UNSUPPORTED`

#### Scenario: Version outside the optional capability profile
- **WHEN** `version` is omitted or does not identify a major-1 release at or above `1.5.2`
- **THEN** the adapter selects the in-memory baseline without resume, fork or manual compaction

#### Scenario: Version within the optional capability profile
- **WHEN** `version` identifies a major-1 release at or above `1.5.2`
- **THEN** the adapter offers manual compaction, with resume and fork enabled when `persistSessions` is true or omitted
- **AND** the profile is marked verified only for the exact version `1.5.2`

### Requirement: Failure handling and secrets
The adapter SHALL surface native failures as typed errors and redact configured secret values from mapped message and tool content. Alternate hosts supplying typed SDK errors are responsible for making their messages and details safe to expose.

#### Scenario: Lost native source
- **WHEN** the native source is lost while a turn is active
- **THEN** unfinished turn observation rejects with a typed unknown-outcome error and no terminal turn event is fabricated

#### Scenario: Native prompt rejected before acceptance
- **WHEN** Pi rejects a prompt before reporting acceptance
- **THEN** the submission rejects with a typed SDK error and the session remains open for the caller to close

#### Scenario: Native run fails after acceptance
- **WHEN** the embedded host reports a run rejection after accepting the prompt and a turn is active
- **THEN** the turn ends with a typed `PI_RUN_FAILED` error

#### Scenario: Credential redaction
- **WHEN** mapped message or tool content contains a configured credential value
- **THEN** the value is redacted from published content and history
- **AND** untyped native failure messages are discarded when producing SDK errors
