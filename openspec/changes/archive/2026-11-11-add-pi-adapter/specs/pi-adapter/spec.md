## ADDED Requirements

### Requirement: Session lifecycle
The adapter SHALL open, resume and close Pi sessions through the AHP session model, and SHALL release every native resource when a session closes.

#### Scenario: Open a new session
- **WHEN** a client opens a session with a working directory
- **THEN** a Pi session bound to that directory is created and a session state is returned

#### Scenario: Resume an existing session
- **WHEN** a client opens a session referencing a previously persisted Pi session
- **THEN** the session resumes with its prior history available

#### Scenario: Close releases resources
- **WHEN** a session is closed, including while a turn is active
- **THEN** the native session is disposed, no event listeners remain, and the active turn ends with a closed/cancelled outcome

### Requirement: Turn completion
A turn SHALL be reported complete only when Pi has stopped working on its own (settled), not merely when an assistant run ends or when the prompt is accepted.

#### Scenario: Run end followed by automatic continuation
- **WHEN** Pi ends a run and then continues automatically (retry, recovery or queued work)
- **THEN** the turn stays active until Pi settles

#### Scenario: Streamed content
- **WHEN** Pi streams text, thinking and tool activity during a turn
- **THEN** the corresponding AHP items are emitted in order, and the final item content equals Pi's completed message

#### Scenario: Native failure
- **WHEN** Pi reports an error or aborted stop reason
- **THEN** the turn ends with a typed turn error carrying that reason

### Requirement: Steering and interruption
The adapter SHALL support steering an active turn and interrupting it, and SHALL report accurately whether input was queued.

#### Scenario: Steer an active turn
- **WHEN** input with native delivery is submitted while a turn is active
- **THEN** it is delivered to Pi as steering and joins the active turn

#### Scenario: Follow-up after the current work
- **WHEN** input with after-turn delivery is submitted while a turn is active
- **THEN** it is delivered to Pi as a follow-up and joins the active turn

#### Scenario: Atomic turn controls are not offered
- **WHEN** a client calls turn-targeted steer or interrupt
- **THEN** the call fails as unsupported, because Pi has no turn identity to match atomically

#### Scenario: Input consumed by an extension
- **WHEN** Pi reports the input as handled by an extension rather than queued
- **THEN** the adapter does not report it as queued agent input

#### Scenario: Interrupt
- **WHEN** a client interrupts an active turn
- **THEN** Pi's work is aborted and the turn ends as interrupted

#### Scenario: Overlapping submission
- **WHEN** a second turn is submitted while one is active
- **THEN** behavior follows the shared native conformance scenarios (overlap, close-active, observer-cancel)

### Requirement: Fork, history and compaction
The adapter SHALL expose fork, history and compaction when and only when Pi supports them for the open session.

#### Scenario: Fork keeps events flowing
- **WHEN** a session is forked
- **THEN** the fork is a new session with the parent history up to the boundary, and events continue to be delivered for the session that is active afterward

#### Scenario: History paging
- **WHEN** a client requests history
- **THEN** items are returned in order and in pages bounded by the configured maximum

#### Scenario: Compaction
- **WHEN** a client requests compaction
- **THEN** compaction progress is surfaced as a compaction item inside an active turn, or as notices when no turn is active, and the session remains usable afterward

### Requirement: Configuration
The adapter SHALL expose model and thinking-level configuration, and a model catalog, using values Pi reports as available.

#### Scenario: Change model
- **WHEN** a client sets a model that Pi lists as available
- **THEN** subsequent turns use that model

#### Scenario: Invalid value
- **WHEN** a client sets a model or thinking level that Pi does not list
- **THEN** the request fails with an invalid-parameters error and the previous value remains

### Requirement: Permission modes
The adapter SHALL implement `read-only` and `agent-full-access` permission modes by restricting Pi's available tools, and SHALL NOT advertise approval-based modes.

#### Scenario: Read-only mode
- **WHEN** a session is configured as `read-only`
- **THEN** Pi has no tool that can write files or execute commands

#### Scenario: Unsupported mode
- **WHEN** a client requests a permission mode other than the supported ones
- **THEN** the request fails with an invalid-parameters error

### Requirement: Capability advertisement
The adapter SHALL advertise only the capabilities verified for the detected Pi version profile, and SHALL reject others explicitly.

#### Scenario: Unsupported capability
- **WHEN** a client calls revert, goal or review
- **THEN** the call fails with a not-supported error and the capability is absent from the advertised set

#### Scenario: Unverified version
- **WHEN** the Pi version is outside every known profile
- **THEN** only the safe baseline capability set is advertised

### Requirement: Failure handling and secrets
The adapter SHALL surface native failures as typed errors, SHALL NOT leak credentials into events, errors or diagnostics, and SHALL mark outcomes as unknown when a failure leaves them uncertain.

#### Scenario: Lost native source
- **WHEN** the native source is lost while a turn is active
- **THEN** observation fails with a typed error and no terminal turn event is fabricated

#### Scenario: Native session crash
- **WHEN** the native session throws during a turn
- **THEN** the turn fails with a typed error and the session can still be closed cleanly

#### Scenario: Credential redaction
- **WHEN** an error or diagnostic would contain a configured credential value
- **THEN** the value is redacted
