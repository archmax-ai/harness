import { join } from "node:path";
import { CompositeBackend, FilesystemBackend, type BackendProtocolV2 } from "deepagents";
import { resolveWorkspaceRoot } from "../env.js";
import { mountSubtree } from "./path-mapping.js";
import {
  createFilesystemSessionStore,
  DEFAULT_SESSIONS_DIR,
  SessionStoreRequiredError,
  type SessionStore,
} from "./session-store.js";
import { SessionZoneRouter } from "./session-zone.js";
import { Workspace } from "./workspace.js";
import { createWorkspaceRouter } from "./workspace-router.js";
import {
  defaultMounts,
  resolveMounts,
  type MountPrefixes,
  type MountSpec,
  type ResolvedMount,
} from "./mounts.js";

export interface WorkspaceContextOptions {
  /**
   * Agent workspace root: where the zero-config filesystem defaults — the
   * conventional mount table, the `sessions/` store, the authoring backend —
   * are built. With **none** of `backend`, `mounts`, `sessionStore` and
   * `authoring` supplied it defaults to the consumer's current working
   * directory, as documented. Once any of them is supplied, a default that still
   * needs a root is refused with {@link WorkspaceRootRequiredError} rather than
   * built over the cwd; and when nothing needs one, none is resolved
   * ({@link WorkspaceContext.rootDir} is absent).
   */
  rootDir?: string;
  /**
   * Declares that authored content comes from somewhere other than the local
   * filesystem root — a store, sandbox, or remote Deep Agents backend.
   *
   * Supplying it does **not** by itself serve anything: this backend reaches the
   * workspace only through the `mounts` table below, and its presence is what
   * withdraws every zero-config default (the conventional mount table, the local
   * `<rootDir>/sessions` store). Omit it for a filesystem
   * workspace, where those defaults apply.
   */
  backend?: BackendProtocolV2;
  /**
   * Physical storage for the writable session zone — the agent's workspace root
   * (checkpoints, artifacts, output, scratchpad, offloaded context). With the
   * default authored backend this defaults to a filesystem store at
   * `<rootDir>/sessions`; with a custom authored `backend` it is required — assembly
   * throws {@link SessionStoreRequiredError} rather than silently running without
   * session-scoped run routing or writing to local disk beside a virtual
   * workspace.
   */
  sessionStore?: SessionStore;
  /**
   * Authored mounts as a {@link CompositeBackend} route table: key → backend, or
   * `{ backend, readOnly }`. A key ending in `/` is a directory mount; a key
   * without one (`"/AGENTS.md"`) is an exact-path file mount. Mounts are
   * read-only unless a spec declares otherwise.
   *
   * Omitted on the default filesystem backend, {@link defaultMounts} is applied
   * over the workspace root. Omitted with a custom `backend`, nothing authored is
   * served — exposing that backend is an explicit act (compose it with
   * `mountSubtree(backend, "skills")`).
   */
  mounts?: Record<string, MountSpec>;
  /**
   * Backend serving the **authored governance plane** — `workflows/<slug>/`:
   * machine specs, prose addenda, lifecycle hook scripts, and offline test
   * cases. Read by the runtime, never routed into the agent's workspace
   * composite, so no agent tool and no PTC call can address it.
   *
   * Defaults to the authored `backend` when one is supplied, and otherwise to a
   * filesystem backend over the resolved root. Declaring it separately is what
   * lets governance live somewhere the agent's workspace does not: a store, a
   * service, a signed bundle.
   */
  authoring?: BackendProtocolV2;
}

/**
 * Thrown when the authoring backend is also served by a **writable** mount. A
 * writable route onto the authoring backend would let a session edit the machine
 * that governs it, which no downstream rule can undo — so it is refused at
 * assembly rather than diagnosed later.
 */
export class AuthoringBackendExposedError extends Error {
  constructor(readonly key: string) {
    super(
      `Mount '${key}' is writable and is served by the same backend as the authoring backend. ` +
        `The authoring backend must not be agent-writable — mount a different backend, or declare ` +
        `the mount read-only.`,
    );
    this.name = "AuthoringBackendExposedError";
  }
}

/**
 * Thrown when a workspace is partly composed — some of `mounts`, `sessionStore`
 * and `authoring` supplied, no `backend` — and a filesystem default for the rest
 * would have to be built over the process's working directory because no
 * `rootDir` was given. A service's cwd is not an agent root; the option that
 * needed one is named so the caller supplies it, or the source it stands for.
 */
export class WorkspaceRootRequiredError extends Error {
  constructor(readonly option: "mounts" | "sessionStore" | "authoring") {
    super(
      `No 'rootDir' was given, and the filesystem default for '${option}' needs one. ` +
        `The working directory is not used as an agent root once the workspace is composed ` +
        `explicitly: pass 'rootDir', or supply '${option}' yourself.`,
    );
    this.name = "WorkspaceRootRequiredError";
  }
}

/**
 * Resolved workspace context shared by assembly, scaffold validation,
 * and offline test execution. Centralizing this keeps root resolution, backend
 * selection, platform-prompt directory choice, and run-store resolution
 * consistent across every entrypoint.
 */
export interface WorkspaceContext {
  /**
   * Absolute resolved workspace root — present when one was given or when a
   * filesystem default was built over it; absent when every source was supplied
   * and nothing was read from local disk to compose this context.
   */
  rootDir?: string;
  /** Backend serving workspace file access. */
  backend: BackendProtocolV2;
  /** Workspace wrapper over {@link backend}. */
  workspace: Workspace;
  /**
   * Workspace over the authoring backend — the runtime's read path for
   * `workflows/**`. Deliberately *not* the agent's {@link workspace}: nothing
   * reachable from here is reachable from a tool call.
   */
  authoring: Workspace;
  /** The resolved session store (explicit, or the zero-config filesystem default). */
  sessionStore: SessionStore;
  /** Whether the authored source is the default filesystem backend over `rootDir`. */
  usingDefaultBackend: boolean;
  /**
   * This workspace's resolved mount keys — the single source every consumer
   * classifies against: mount routing, agent-visible root shaping, the decision
   * kernel's zone rules, and static validation. Derived from the very keys the
   * composite routes on, so the two cannot drift.
   */
  mountPrefixes: MountPrefixes;
  /**
   * Router serving the workspace root's session-scoped, id-free addressing. Bind
   * it to a session id (`sessionScoped`) around a turn's `agent.invoke` so
   * agent-visible `scratchpad/…` and offload paths for that turn
   * resolve against that session without the session id embedded.
   */
  sessionZone: SessionZoneRouter;
}

/**
 * Build a {@link WorkspaceContext} from caller options. With no custom backend,
 * a filesystem backend is created over the resolved root, the platform prompt
 * directory defaults to the bundled platform assets, and the session store
 * defaults to `<rootDir>/sessions` on the local filesystem. With a custom backend,
 * an explicit {@link SessionStore} is required.
 */
export function createWorkspaceContext(
  options: WorkspaceContextOptions = {},
): WorkspaceContext {
  // Nothing serves `options.backend` directly: a custom authored backend reaches
  // the workspace only where the consumer mounts it (see `mounts`). What its
  // presence decides here is that this is not the zero-config filesystem
  // workspace — so neither the conventional mount table, the local session store,
  // nor the bundled platform directory may be assumed.
  const usingDefaultBackend = options.backend === undefined;

  // Which filesystem defaults this call would build over a root. The cwd stands
  // in for a root only in the fully zero-config case; a workspace the caller has
  // started composing gets no silent root, and one composed entirely gets none at all.
  const defaults: ("mounts" | "sessionStore" | "authoring")[] = usingDefaultBackend
    ? (["mounts", "sessionStore", "authoring"] as const).filter((option) => options[option] === undefined)
    : [];
  const composed =
    options.backend !== undefined ||
    options.mounts !== undefined ||
    options.sessionStore !== undefined ||
    options.authoring !== undefined;
  let rootDir: string | undefined;
  if (options.rootDir !== undefined) rootDir = resolveWorkspaceRoot(options.rootDir);
  else if (defaults.length > 0) {
    if (composed) throw new WorkspaceRootRequiredError(defaults[0]!);
    rootDir = resolveWorkspaceRoot();
  }
  /** The root a filesystem default is built over; only reached when one was resolved above. */
  const rootFor = (option: "mounts" | "sessionStore" | "authoring"): string => {
    if (rootDir === undefined) throw new WorkspaceRootRequiredError(option);
    return rootDir;
  };

  // The consumer owns physical run-state storage; the SDK owns the logical
  // namespace. Zero-config (default backend, no store) keeps the documented
  // local default; a custom backend must name its store explicitly — never
  // infer storage or drop session routing based on how the authored backend
  // was supplied.
  if (!usingDefaultBackend && options.sessionStore === undefined) {
    throw new SessionStoreRequiredError();
  }
  const sessionStore =
    options.sessionStore ??
    createFilesystemSessionStore({ dir: join(rootFor("sessionStore"), DEFAULT_SESSIONS_DIR) });

  // The session zone is the workspace root: checkpoints, artifacts, governed
  // the agent's `scratchpad/…` working area and the runtime's context-offload
  // areas all resolve per session through one router. Authored content is
  // mounted read-only beside it — each mount maps paths in both directions so
  // the authored backend sees authored paths and results come back in
  // workspace form.
  const sessionZone = new SessionZoneRouter(sessionStore.backend);

  // Which directories are authored is workspace shape, not framework knowledge:
  // the consumer composes a route table of backends. The conventional table is a
  // default value applied only on the zero-config filesystem path.
  const table =
    options.mounts ?? (usingDefaultBackend ? defaultMounts(rootFor("mounts")) : {});
  const { mounts, prefixes: mountPrefixes } = resolveMounts(table);

  // Directory mounts become composite routes; file mounts are matched exactly by
  // the router, since a prefix route can neither address a single file nor
  // distinguish `AGENTS.md` from `AGENTS.md.bak`.
  const dirMounts = mounts.filter((m) => m.isDir);
  const routes: Record<string, BackendProtocolV2> = Object.fromEntries(
    dirMounts.map((m) => [m.key, guard(m)]),
  );
  const fileMounts = new Map(mounts.filter((m) => !m.isDir).map((m) => [m.name, guard(m)]));
  const composite = new CompositeBackend(sessionZone, routes);

  // A root-wide search fans out to every route the composite has, and one
  // route's `{ error }` is fatal to the whole search. A mount declared
  // `searchable: false` is therefore left out of the composite that serves
  // searches — the same default route and the same guarded route objects, so
  // nothing else about routing differs — and reached only by a search
  // addressed at it, which the router delegates to the route directly. With
  // no such mount the search composite *is* the routing composite, so an
  // existing table behaves byte-identically.
  const unsearchable = dirMounts.filter((m) => !m.searchable);
  const searchComposite =
    unsearchable.length === 0
      ? composite
      : new CompositeBackend(
          sessionZone,
          Object.fromEntries(
            dirMounts.filter((m) => m.searchable).map((m) => [m.key, routes[m.key]!]),
          ),
        );
  const unsearchableRoutes = new Map(unsearchable.map((m) => [m.name, routes[m.key]!]));
  const backend = createWorkspaceRouter({
    composite,
    searchComposite,
    unsearchableRoutes,
    fileMounts,
    mountPrefixes,
    boundSessionId: () => sessionZone.boundSessionId(),
  });

  const workspace = new Workspace(backend);

  // The governance plane is served beside the agent's workspace, never inside
  // it. With a custom authored backend that backend is the natural source (it
  // already holds the authored tree); the agent still cannot reach `workflows/**`
  // through it, because the composite has no route there and `resolveMounts`
  // refuses one.
  const authoringBackend =
    options.authoring ??
    options.backend ??
    new FilesystemBackend({ rootDir: rootFor("authoring"), virtualMode: true });
  for (const mount of mounts) {
    if (!mount.readOnly && mount.backend === authoringBackend) {
      throw new AuthoringBackendExposedError(mount.key);
    }
  }
  const authoring = new Workspace(authoringBackend);

  return {
    ...(rootDir !== undefined ? { rootDir } : {}),
    backend,
    workspace,
    authoring,
    sessionStore,
    usingDefaultBackend,
    sessionZone,
    mountPrefixes,
  };
}

/**
 * A read-only mount refuses writes at the mount itself, so authored content
 * cannot be modified even by a caller that bypasses governance; the kernel's
 * `zone.read-only` rule remains the agent-facing diagnostic. A mount the consumer
 * declared writable is delegated as-is.
 *
 * A directory mount is addressed with its route prefix already stripped by the
 * composite, so the refusal is told that prefix (`data`) to re-apply when naming
 * the rejected path; a file mount is addressed by its exact key, which needs no
 * re-application.
 */
function guard(mount: ResolvedMount) {
  return mount.readOnly
    ? mountSubtree(mount.backend, "", {
        readOnly: true,
        ...(mount.isDir ? { displayPrefix: mount.name } : {}),
      })
    : mount.backend;
}
