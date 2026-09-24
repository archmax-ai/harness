import { describe, expect, it } from "vitest";
import { afterHookLabel, hookKind, hookMaxIterations, normalizeHooks } from "./hook-shape.js";

describe("hookKind", () => {
  it("returns the single kind key of a tagged hook", () => {
    expect(hookKind({ script: "hooks/x.js" })).toBe("script");
    expect(hookKind({ rubric: { instructions: "tone" } })).toBe("rubric");
    expect(hookKind({ webhook: "approvals/refund" })).toBe("webhook");
  });

  it("ignores the reserved max_iterations sidecar key", () => {
    expect(hookKind({ script: "hooks/x.js", max_iterations: 2 })).toBe("script");
    expect(hookKind({ webhook: "approvals/refund", max_iterations: 1 } as never)).toBe("webhook");
  });

  // The removed `instructions` sidecar is not reserved: a hook carrying it has
  // two candidate kind keys and is malformed.
  it("does not treat the removed instructions sidecar as reserved", () => {
    expect(hookKind({ rubric: "judge", instructions: "be strict" } as never)).toBeUndefined();
    expect(hookKind({ script: "x.js", instructions: "be strict" } as never)).toBeUndefined();
  });

  it("treats sidecar-only and multi-kind objects as malformed", () => {
    expect(hookKind({ max_iterations: 3 } as never)).toBeUndefined();
    expect(hookKind({ script: "a.js", rubric: "judge" })).toBeUndefined();
    expect(hookKind({} as never)).toBeUndefined();
  });
});

describe("hook readers", () => {
  it("labels tagged script and rubric hooks", () => {
    expect(afterHookLabel({ script: "hooks/x.js" })).toBe("hooks/x.js");
    // An inline rubric has no name, so its position is what tells two apart.
    expect(afterHookLabel({ rubric: { instructions: "tone" } })).toBe("rubric#0");
    expect(afterHookLabel({ rubric: { instructions: "completeness" } }, 1)).toBe("rubric#1");
    expect(afterHookLabel({} as never)).toBe("hook");
  });

  it("reads the sidecar budget only when it is a non-negative number", () => {
    // The sidecar belongs to a script or custom hook; an inline rubric declares
    // `max_iterations` inside itself, so there is only one place to put it.
    expect(hookMaxIterations({ script: "hooks/x.js", max_iterations: 2 })).toBe(2);
    expect(hookMaxIterations({ rubric: { instructions: "tone" } })).toBeUndefined();
    expect(hookMaxIterations({ script: "hooks/x.js", max_iterations: -1 } as never)).toBeUndefined();
  });

  it("normalizes a single hook and a list to an ordered list", () => {
    expect(normalizeHooks(undefined)).toEqual([]);
    expect(normalizeHooks({ script: "hooks/a.js" })).toEqual([{ script: "hooks/a.js" }]);
    expect(normalizeHooks([{ script: "hooks/a.js" }, { rubric: "j" }])).toHaveLength(2);
  });
});
