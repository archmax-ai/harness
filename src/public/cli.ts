/**
 * `@archmax-ai/harness/cli` — the state-flow renderer and its styling.
 *
 * A subpath of its own so a third-party frontend of the typed event stream can
 * render sessions the way `archmax run` does — and suites the way `archmax test`
 * does — without importing the CLI itself.
 */

/** Render one lifecycle event as the CLI's own console line, or `null` for none. */
export { renderEventLine } from "../core/events.js";

/** The CLI's colour and glyph vocabulary, honouring `NO_COLOR`. */
export { createStyle, icons } from "../cli/style.js";
export type { Style } from "../cli/style.js";

/** The live state flow `archmax run` builds from the event stream, and the test view `archmax test` builds on it. */
export { createStateFlowRenderer, createTestView, caseVerdictLine } from "../cli/state-flow.js";
export type { StateFlowRenderer, StateFlowWriter, TestView } from "../cli/state-flow.js";
