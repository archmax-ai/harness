/**
 * Enrich every requested order, one sub-run apiece, concurrently.
 *
 * The deterministic form of a fan-out: delegation is a tool call, so a script
 * decides how many to make and hands back exactly what the calling state
 * needs. Reads the `orders_to_enrich` list from `args.variables` (the session's
 * variables, which `archmax_run` supplies beside whatever the model passed),
 * calls `archmax_workflow_enrich-order` once per entry, awaits them together,
 * and returns one `{ order_id, enrichment_file, delayed }` object per order.
 *
 * Two things worth knowing about `tools.*`:
 *
 *  - the bridge camelCases every tool name, so `archmax_workflow_enrich-order`
 *    is reached as `tools.archmaxWorkflowEnrichOrder`;
 *  - a tool result arrives as text, so a structured answer is parsed here.
 *
 * `Promise.all` genuinely runs the calls concurrently — each host call is
 * started detached — and the runtime still bounds how many sub-runs are in
 * flight at once, queueing the rest.
 */
const orders = args.variables?.orders_to_enrich ?? [];

const enriched = await Promise.all(
  orders.map(async (entry) => {
    const answer = await tools.archmaxWorkflowEnrichOrder({ order_id: entry.order_id });
    // `enrich-order` declares `returns: [enrichment_file, delayed]`, so its
    // answer carries them under `returns`, beside its closing `message`.
    const { returns } = JSON.parse(answer);
    return {
      order_id: entry.order_id,
      enrichment_file: returns.enrichment_file,
      delayed: returns.delayed,
    };
  }),
);

enriched;
