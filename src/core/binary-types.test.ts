import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import * as spec from "../public/spec.js";
import { BINARY_MIME_TYPES, binaryMimeTypeOf } from "./binary-types.js";

describe("binaryMimeTypeOf", () => {
  it("is the spec subpath's binding", () => {
    expect(spec.binaryMimeTypeOf).toBe(binaryMimeTypeOf);
    expect(spec.BINARY_MIME_TYPES).toBe(BINARY_MIME_TYPES);
  });

  it("reads the extension as node's extname does, without node", () => {
    const paths = ["a/logo.PNG", "deck.pptx", "notes.txt", ".png", "dir.png/file", "a/b.tar.pdf", "x.", "plain"];
    for (const path of paths) {
      expect(binaryMimeTypeOf(path), path).toBe(BINARY_MIME_TYPES[posix.extname(path).toLowerCase()]);
    }
    expect(binaryMimeTypeOf("a/logo.PNG")).toBe("image/png");
    expect(binaryMimeTypeOf(".png")).toBeUndefined();
  });
});
