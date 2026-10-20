## MODIFIED Requirements

### Requirement: The grader and its evidence

The grader SHALL be the model factory's `judge` role (default: the env-configured model) handed the environment with `tests.judge.model` and `tests.judge.modelOptions` (`temperature`, `maxTokens`; any other key fails the spec load) applied over it; the environment is loaded lazily so a factory carrying its own credentials needs no `ARCHMAX_*` variables. Its evidence is derived from the same view the step's other assertions read: the action's `reply` (what the agent said during the action's turn, as its outcome carries it), and a chronological record, covering the session so far, of every assistant message, runtime note (`[runtime:<kind>]`) and tool call with name, input, output and status (`completed`, `failed`, `rejected`, `pending`) — a mocked call appearing with its mocked output. The reply's closing message is not repeated in the record when it closed the turn. Each rendered input, output or message is capped at `MAX_VALUE_CHARS` (800) with a marker naming the dropped characters; the record is capped at `MAX_RECORD_CHARS` (12000), dropping the oldest entries first behind one marker naming how many were omitted; an empty record says so explicitly; the reply is never capped. The prompt labels the two sections and instructs the model that a criterion about what the user was told is met only by the reply while one about behaviour may be met by the record, asks for JSON `{ score, pass, reason }` with a 1–3 sentence reason, and tolerates prose or fences around the JSON by taking the first balanced `{...}` block that parses; when none parses the grader is asked once more for JSON only, and if that also fails the score is 0 with the reason "grader returned no readable JSON verdict".

#### Scenario: A person's decision is evidence

- **WHEN** a refund was approved by `decide` and the next turn is graded on "the refund was approved by a person"
- **THEN** the prompt carries the `[runtime:decision]` note and the final reply in its own section, and no `archmax_note` tool call

#### Scenario: Oversized evidence elided visibly

- **WHEN** a tool output exceeds 800 characters and the record exceeds 12000
- **THEN** the output is truncated with a `…(+N chars)` marker, the oldest entries are dropped behind an omission marker, and the reply reaches the grader whole

#### Scenario: One retry then zero

- **WHEN** the grader answers with unparseable text twice
- **THEN** the record scores 0 and the case continues

#### Scenario: The grader reads this action's reply

- **WHEN** a case's first `send` ends with the agent saying "ORD-1001 is shipped", and a second `send` is answered with a proposal written next to an advance followed by "I'll wait for your confirmation", and a `grade` follows it
- **THEN** the grader's reply section holds the proposal and the confirmation line, not "ORD-1001 is shipped"

#### Scenario: A silent action is graded as silent

- **WHEN** an action's turn adds no assistant text and a `grade` follows it
- **THEN** the grader's reply section is empty, not the previous turn's text
