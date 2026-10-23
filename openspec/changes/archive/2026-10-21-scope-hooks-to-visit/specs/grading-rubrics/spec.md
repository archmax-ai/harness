## ADDED Requirements

### Requirement: A rubric is shown the visit

A rubric hook's grader SHALL be shown the transcript of the visit the hook sees (as a script hook
does: see the runtime's "A hook sees its visit"), with every tool result in full, and the session's
opening request as `userRequest`. It SHALL NOT be shown messages from earlier visits, and SHALL
NOT be shown a fixed number of trailing messages instead. The transcript SHALL be read from the
session's own messages, never from a summarized request prepared for the model.

#### Scenario: A long visit is shown whole

- **WHEN** a state's visit holds forty messages, among them twelve control calls, and its `after`
  rubric runs
- **THEN** the grader's history holds all forty messages, tool results included

#### Scenario: Earlier states are not shown

- **WHEN** the person's request opened `identify-case`, the agent advanced to `orders-question` and
  answered there, and `orders-question`'s `after` rubric runs
- **THEN** the grader's history starts at the entry into `orders-question`, and `userRequest` is the
  person's opening message
