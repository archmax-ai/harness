/**
 * An OpenTelemetry SDK for tests, registered the way a host registers one: a
 * tracer provider exporting to memory, a meter provider read on demand, and an
 * AsyncLocalStorage context manager, all on the API's globals — so the runtime
 * is observed through `@opentelemetry/api` exactly as in production.
 *
 * {@link useOtel} registers them before each test and removes them after it,
 * leaving no provider behind; the helpers read what was recorded as a tree, by
 * name, and as the flat list of every string a span or metric carries (what
 * the metadata-only tests search for markers).
 */
import {
  context,
  metrics,
  trace,
  type Attributes,
  type AttributeValue,
  type Tracer,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  DataPointType,
  MeterProvider,
  MetricReader,
  type DataPoint,
  type Histogram,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace";
import { afterEach, beforeEach } from "vitest";

export type { ReadableSpan };

/** A metric reader the test collects from when it wants to, never on a timer. */
class OnDemandReader extends MetricReader {
  protected async onShutdown(): Promise<void> {}
  protected async onForceFlush(): Promise<void> {}
}

/**
 * What every span looked like when it started — what a host's span processors
 * and samplers see — since a name or an attribute changed before the span ends
 * is gone from the exported span but was not private while it ran.
 */
class StartRecorder implements SpanProcessor {
  readonly started: Array<{ name: string; attributes: Attributes }> = [];
  onStart(span: Span): void {
    const started = span as unknown as { name: string; attributes: Attributes };
    this.started.push({ name: started.name, attributes: { ...started.attributes } });
  }
  onEnd(): void {}
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

/** One histogram series as collected: its attributes and what it holds. */
export interface RecordedPoint {
  attributes: Attributes;
  count: number;
  sum: number;
  min?: number;
  max?: number;
  boundaries: number[];
}

/** One metric as collected. */
export interface RecordedMetric {
  name: string;
  unit: string;
  description: string;
  scope: string;
  points: RecordedPoint[];
}

/** What a test reads the recorded telemetry through. */
export interface Otel {
  /** A tracer for the test's own spans, the way a host opens one around a turn. */
  readonly tracer: Tracer;
  /** Every span ended so far, in the order they ended. */
  spans(): ReadableSpan[];
  /** The spans with this name, or whose name matches, in start order. */
  named(name: string | RegExp): ReadableSpan[];
  /** The one span with this name; throws, listing what there is, when there is not exactly one. */
  one(name: string | RegExp): ReadableSpan;
  /** A span's parent among the ended spans. */
  parentOf(span: ReadableSpan): ReadableSpan | undefined;
  /** A span's ended children, in start order. */
  childrenOf(span: ReadableSpan): ReadableSpan[];
  /** Whether `span` lies anywhere under `ancestor`. */
  isUnder(span: ReadableSpan, ancestor: ReadableSpan): boolean;
  /** The ended spans grouped by trace id. */
  traces(): ReadableSpan[][];
  /**
   * The ended spans as an indented outline of names, children in start order —
   * from `root`, or from every span whose parent was not recorded.
   */
  outline(root?: ReadableSpan): string;
  /** Collect the metrics recorded so far. */
  metrics(): Promise<RecordedMetric[]>;
  /**
   * Every string a span or metric carries: span names, attribute keys and
   * values (arrays flattened), event names and attributes, status messages,
   * link attributes, metric names, units, descriptions and point attributes.
   */
  strings(): Promise<string[]>;
  /** Forget the spans recorded so far. */
  reset(): void;
}

interface Installed {
  exporter: InMemorySpanExporter;
  starts: StartRecorder;
  tracerProvider: TracerProvider;
  meterProvider: MeterProvider;
  reader: OnDemandReader;
}

let installed: Installed | undefined;

/** Register the SDK on the API's globals. {@link uninstallOtel} removes it. */
export function installOtel(): Otel {
  if (installed) throw new Error("an OpenTelemetry SDK is already registered for this test");
  const exporter = new InMemorySpanExporter();
  const starts = new StartRecorder();
  const tracerProvider = new TracerProvider({
    spanProcessors: [starts, new SimpleSpanProcessor({ exporter })],
  });
  const reader = new OnDemandReader();
  const meterProvider = new MeterProvider({ readers: [reader] });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(tracerProvider);
  metrics.setGlobalMeterProvider(meterProvider);
  installed = { exporter, starts, tracerProvider, meterProvider, reader };
  return otelView();
}

/** Remove what {@link installOtel} registered: the API is a no-op again. */
export async function uninstallOtel(): Promise<void> {
  const current = installed;
  installed = undefined;
  trace.disable();
  metrics.disable();
  context.disable();
  if (!current) return;
  await current.tracerProvider.shutdown();
  await current.meterProvider.shutdown();
}

/** Register the SDK before each test of the enclosing suite and remove it after. */
export function useOtel(): Otel {
  beforeEach(() => {
    installOtel();
  });
  afterEach(async () => {
    await uninstallOtel();
  });
  return otelView();
}

function current(): Installed {
  if (!installed)
    throw new Error("no OpenTelemetry SDK is registered: call useOtel() in the suite");
  return installed;
}

const idOf = (span: ReadableSpan) => span.spanContext().spanId;
const startOf = (span: ReadableSpan) => span.startTime[0] * 1e9 + span.startTime[1];
const byStart = (a: ReadableSpan, b: ReadableSpan) => startOf(a) - startOf(b);

function matches(span: ReadableSpan, name: string | RegExp): boolean {
  return typeof name === "string" ? span.name === name : name.test(span.name);
}

function stringsOfValue(value: AttributeValue | undefined): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value))
    return value.flatMap((v) => (v === null || v === undefined ? [] : [String(v)]));
  return [String(value)];
}

function stringsOfAttributes(attributes: Attributes | undefined): string[] {
  return Object.entries(attributes ?? {}).flatMap(([key, value]) => [
    key,
    ...stringsOfValue(value),
  ]);
}

function recordedMetrics(collected: ResourceMetrics): RecordedMetric[] {
  return collected.scopeMetrics.flatMap((scope) =>
    scope.metrics.map((metric) => ({
      name: metric.descriptor.name,
      unit: metric.descriptor.unit,
      description: metric.descriptor.description,
      scope: scope.scope.name,
      points:
        metric.dataPointType === DataPointType.HISTOGRAM
          ? (metric.dataPoints as DataPoint<Histogram>[]).map((point) => ({
              attributes: point.attributes,
              count: point.value.count,
              sum: point.value.sum ?? 0,
              ...(point.value.min !== undefined ? { min: point.value.min } : {}),
              ...(point.value.max !== undefined ? { max: point.value.max } : {}),
              boundaries: point.value.buckets.boundaries,
            }))
          : (metric.dataPoints as DataPoint<unknown>[]).map((point) => ({
              attributes: point.attributes,
              count: 1,
              sum: typeof point.value === "number" ? point.value : 0,
              boundaries: [],
            })),
    })),
  );
}

function otelView(): Otel {
  const spans = () => current().exporter.getFinishedSpans();
  const parentOf = (span: ReadableSpan) => {
    const parentId = span.parentSpanContext?.spanId;
    return parentId ? spans().find((s) => idOf(s) === parentId) : undefined;
  };
  const childrenOf = (span: ReadableSpan) =>
    spans()
      .filter((s) => s.parentSpanContext?.spanId === idOf(span))
      .sort(byStart);
  const named = (name: string | RegExp) =>
    spans()
      .filter((s) => matches(s, name))
      .sort(byStart);
  const outline = (root?: ReadableSpan): string => {
    const lines: string[] = [];
    const walk = (span: ReadableSpan, depth: number) => {
      lines.push(`${"  ".repeat(depth)}${span.name}`);
      for (const child of childrenOf(span)) walk(child, depth + 1);
    };
    const roots = root
      ? [root]
      : spans()
          .filter((s) => !parentOf(s))
          .sort(byStart);
    for (const span of roots) walk(span, 0);
    return lines.join("\n");
  };
  const collect = async () => {
    const { resourceMetrics, errors } = await current().reader.collect();
    if (errors.length > 0) throw new AggregateError(errors, "collecting metrics failed");
    return recordedMetrics(resourceMetrics);
  };
  return {
    get tracer() {
      current();
      return trace.getTracer("host");
    },
    spans,
    named,
    one(name) {
      const found = named(name);
      if (found.length !== 1) {
        throw new Error(
          `expected exactly one span named ${String(name)}, found ${found.length}; recorded:\n${outline()}`,
        );
      }
      return found[0]!;
    },
    parentOf,
    childrenOf,
    isUnder(span, ancestor) {
      for (let parent = parentOf(span); parent; parent = parentOf(parent)) {
        if (idOf(parent) === idOf(ancestor)) return true;
      }
      return false;
    },
    traces() {
      const byTrace = new Map<string, ReadableSpan[]>();
      for (const span of spans()) {
        const id = span.spanContext().traceId;
        byTrace.set(id, [...(byTrace.get(id) ?? []), span]);
      }
      return [...byTrace.values()].map((group) => group.sort(byStart));
    },
    outline,
    metrics: collect,
    async strings() {
      const fromSpans = spans().flatMap((span) => [
        span.name,
        ...stringsOfAttributes(span.attributes),
        ...span.events.flatMap((event) => [event.name, ...stringsOfAttributes(event.attributes)]),
        ...(span.status.message ? [span.status.message] : []),
        ...span.links.flatMap((link) => stringsOfAttributes(link.attributes)),
      ]);
      const atStart = current().starts.started.flatMap((start) => [
        start.name,
        ...stringsOfAttributes(start.attributes),
      ]);
      const fromMetrics = (await collect()).flatMap((metric) => [
        metric.name,
        metric.unit,
        metric.description,
        ...metric.points.flatMap((point) => stringsOfAttributes(point.attributes)),
      ]);
      return [...fromSpans, ...atStart, ...fromMetrics];
    },
    reset() {
      current().exporter.reset();
      current().starts.started.length = 0;
    },
  };
}
