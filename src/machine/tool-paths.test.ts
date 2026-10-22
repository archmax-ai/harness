import { describe, expect, it } from "vitest";
import { BUILT_IN_TOOL_PATHS, pathArgNamesOf } from "./tool-paths.js";

describe("pathArgNamesOf", () => {
  it("names a built-in's declared path arguments and the aliases it reads them by", () => {
    expect(pathArgNamesOf("read_file", BUILT_IN_TOOL_PATHS.read_file)).toEqual(["file_path", "path"]);
    expect(pathArgNamesOf("copy_file", BUILT_IN_TOOL_PATHS.copy_file)).toEqual(["source", "destination"]);
  });

  it("names file_path for a tool that declares none", () => {
    expect(pathArgNamesOf("sync", undefined)).toEqual(["file_path"]);
  });
});
