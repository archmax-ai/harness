// QuickJS sandbox core: the verdict helpers a lifecycle hook answers with.
//
//   return ok();               // proceed
//   return correct("why");     // the agent gets another attempt (after hooks)
//   return veto("why");        // block, with the reason shown to the agent
//
// Returning nothing is `ok`; throwing is a veto (fail-closed). Nothing else is
// installed here — the hook reads its inputs from the object it is called with.

globalThis.__verdict = (verdict, reason, fallback) => ({
  verdict,
  reason: reason == null || String(reason).trim() === "" ? fallback : String(reason),
});

globalThis.ok = (reason) => globalThis.__verdict("ok", reason, "ok");
globalThis.veto = (reason) => globalThis.__verdict("veto", reason, "vetoed by hook");
globalThis.correct = (reason) => globalThis.__verdict("correct", reason, "correction requested");

globalThis.__isVerdict = (value) =>
  value != null &&
  typeof value === "object" &&
  (value.verdict === "ok" || value.verdict === "veto" || value.verdict === "correct");
