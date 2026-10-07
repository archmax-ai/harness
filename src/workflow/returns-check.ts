/**
 * The completion check on a trigger's `returns`, decided once, as a session
 * finishes. Nothing is handed back: the session settles on what it set.
 *
 * - Every declared return set and conforming: the session completes.
 * - A typed return that does not conform: the session is rejected, a child
 *   included — a wrong-typed value is never handed on.
 * - Returns left unset, in a **sub-workflow child**: the child completes, and
 *   its caller gets the returns it did set plus a `note` naming the rest (the
 *   dispatcher builds it). A top-level session has no caller to read a note,
 *   so it is rejected, naming what it left unset.
 */
import type { WorkflowMachine } from "../machine/machine.js";
import type { VariableStore } from "../machine/variables.js";
import { returnsRejectionFor, returnsShortfall } from "./signature-checks.js";

/** Where the check runs: the session as it finishes. */
export interface ReturnsCheckInput {
  /** The trigger that started the current turn. */
  trigger: string | undefined;
  /** The state the session is finishing in. */
  state: string;
  store: VariableStore;
  /** Whether the session is a sub-workflow child, whose caller reads what it set. */
  child: boolean;
}

export type ReturnsCheck =
  /** Complete: nothing owed, or a child whose caller gets what it set and a note. */
  | { verdict: "complete" }
  /** Rejected, with the reason the session settles with. */
  | { verdict: "reject"; reason: string };

export function checkReturns(machine: WorkflowMachine, input: ReturnsCheckInput): ReturnsCheck {
  const owed = returnsShortfall(machine, input.trigger, input.store);
  if (!owed) return { verdict: "complete" };
  if (input.child && owed.invalid.length === 0) return { verdict: "complete" };
  return { verdict: "reject", reason: returnsRejectionFor(owed, input.state) };
}
