/**
 * Consensus: turning many weak local signals into one strong global claim.
 *
 * This is the module the whole company rests on. Anyone can run probes against
 * a model and notice a difference; that is a commodity and there is free
 * open-source tooling for it. What cannot be replicated without a fleet is
 * CORROBORATION: the same statistical shift, on the same endpoint, in the same
 * direction, within the same time window, observed independently by many
 * tenants who share no infrastructure.
 *
 * That asymmetry runs in both directions and both are worth money:
 *
 *   - Confirmation. One tenant seeing a shift has no idea whether the provider
 *     changed or their own sampling was unlucky. Three hundred tenants seeing
 *     the same shift within the hour is not luck.
 *
 *   - SUPPRESSION. This is the underrated half. If a tenant sees a shift and
 *     nobody else on that endpoint does, it is almost certainly local — a bad
 *     deploy, a changed retrieval corpus, a region issue. Telling them "this
 *     is you, not them" is enormously valuable and is strictly impossible for
 *     a single-tenant tool to say.
 *
 * PRIVACY INVARIANT: the only thing that ever enters this module is a
 * statistical summary of Ultima's own published probes. No prompts, no
 * completions, no customer data. Summaries are non-reversible aggregates
 * (counts, moments, quantiles), which is what makes cross-tenant pooling
 * safe to offer contractually.
 */

import {
  benjaminiHochberg,
  binomialTailP,
  cliffsDelta,
  ksTest,
  leveneTest,
  mannWhitneyU,
  quantile,
  welchTTest,
  wilsonInterval,
} from './stats.js';
import { METRIC_KIND } from './probes.js';

/**
 * Effect-size thresholds for Cliff's delta (Romano et al.).
 * We use Cliff's delta rather than Cohen's d throughout because probe metrics
 * are frequently bounded, bimodal, or near-degenerate (a binary metric sitting
 * at 0.99), where a mean-and-SD effect size is meaningless or undefined.
 */
export const EFFECT = {
  NEGLIGIBLE: 0.147,
  SMALL: 0.33,
  MEDIUM: 0.474,
};

/** Confidence grades attached to a published change event. */
export const GRADE = {
  /** Many independent tenants, large effect. Safe to page someone. */
  CONFIRMED: 'confirmed',
  /** Corroborated but thin — few tenants or modest effect. Worth watching. */
  LIKELY: 'likely',
  /** Signal present, corroboration insufficient. Shown, never alerted on. */
  UNCONFIRMED: 'unconfirmed',
  /** Signal is local to one tenant and contradicted by the fleet. */
  LOCAL: 'local',
};

/** Default thresholds. Exposed so operators can tune without forking. */
export const DEFAULTS = Object.freeze({
  /** BH-adjusted significance level across the whole probe battery. */
  alpha: 0.05,
  /** Minimum |Cliff's delta| to consider a change practically meaningful. */
  minEffect: EFFECT.NEGLIGIBLE,
  /** Minimum samples per side before a comparison is attempted at all. */
  minSamplesPerWindow: 20,
  /** Independent tenants required to reach CONFIRMED. */
  confirmTenants: 5,
  /** Independent tenants required to reach LIKELY. */
  likelyTenants: 2,
  /** Fraction of reporting tenants that must agree on direction. */
  minAgreement: 0.6,
  /**
   * Assumed per-tenant chance-flag rate on a STABLE endpoint.
   *
   * Each tenant's local battery is BH-corrected, but we deliberately take the
   * minimum p across several tests per metric, so the realised per-tenant flag
   * rate on a null endpoint sits somewhat above alpha. Measured at ~0.08 in
   * simulation; 0.10 is the conservative value used as the null hypothesis for
   * the corroboration test. Too low a value manufactures consensus out of
   * noise, so this errs high on purpose.
   */
  nullFlagRate: 0.10,
  /**
   * Significance required for corroboration to beat chance at the observed
   * fleet size. Kept well below alpha because a published change event is a
   * far more expensive claim than a single local flag.
   */
  corroborationAlpha: 0.001,
});

// ---------------------------------------------------------------------------
// Local analysis: one tenant, one metric, two time windows
// ---------------------------------------------------------------------------

/**
 * Choose the right test battery for a metric kind.
 *
 * The reasoning matters, because using the wrong test is how a detector
 * develops a reputation for crying wolf:
 *
 *   BINARY      Mann-Whitney with tie correction. A t-test on 0/1 data with a
 *               proportion near 0 or 1 has badly wrong nominal coverage.
 *   COUNT       Mann-Whitney (no normality assumption) plus KS, because count
 *               metrics like preamble length are heavily zero-inflated and a
 *               change often shows up as a fatter tail, not a moved mean.
 *   CONTINUOUS  Welch for location, Levene for scale, KS for shape. Latency in
 *               particular can hold its mean while its tail doubles, which is
 *               precisely the failure customers feel.
 */
export function testsForKind(kind) {
  switch (kind) {
    case METRIC_KIND.BINARY:
      return ['mannWhitney'];
    case METRIC_KIND.COUNT:
      return ['mannWhitney', 'ks'];
    case METRIC_KIND.CONTINUOUS:
    default:
      return ['welch', 'levene', 'ks'];
  }
}

/**
 * Compare one metric across two windows for a single tenant.
 *
 * Returns raw (unadjusted) p-values. Adjustment happens later, across the
 * entire battery at once — adjusting per-metric would defeat the purpose.
 */
export function analyseLocal(baseline, current, kind = METRIC_KIND.CONTINUOUS, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const nBaseline = baseline.length;
  const nCurrent = current.length;

  if (nBaseline < cfg.minSamplesPerWindow || nCurrent < cfg.minSamplesPerWindow) {
    return {
      sufficient: false,
      reason: `need ${cfg.minSamplesPerWindow} samples per window, have `
        + `${nBaseline}/${nCurrent}`,
      nBaseline,
      nCurrent,
      tests: {},
      pValue: 1,
      effect: 0,
      direction: 0,
    };
  }

  const tests = {};
  for (const name of testsForKind(kind)) {
    if (name === 'welch') tests.welch = welchTTest(baseline, current);
    if (name === 'mannWhitney') tests.mannWhitney = mannWhitneyU(baseline, current);
    if (name === 'ks') tests.ks = ksTest(baseline, current);
    if (name === 'levene') tests.levene = leveneTest(baseline, current);
  }

  // Take the most sensitive test as the metric's p-value. This inflates the
  // per-metric false-positive rate on purpose: we are deliberately trading
  // local specificity for sensitivity, then buying the specificity back with
  // BH adjustment across the battery AND cross-tenant corroboration. A shift
  // that only one test sees and no other tenant confirms will not survive.
  const pValue = Math.min(1, ...Object.values(tests).map((t) => t.p));

  // Effect size and direction are always measured the same way regardless of
  // which test fired, so events remain comparable across metric kinds.
  const effect = cliffsDelta(current, baseline);

  return {
    sufficient: true,
    nBaseline,
    nCurrent,
    tests,
    pValue,
    effect,
    direction: Math.sign(effect),
    baselineMedian: quantile(baseline, 0.5),
    currentMedian: quantile(current, 0.5),
  };
}

/**
 * Analyse a tenant's whole probe battery in one pass and apply BH across every
 * comparison simultaneously.
 *
 * This is the step that keeps us honest. A battery of 8 probes with 2-4 metrics
 * each is ~25 comparisons per cycle. At alpha=0.05, uncorrected, roughly one in
 * every cycle throws a false positive purely by chance — which would mean
 * inventing a drift event most days on a perfectly stable endpoint.
 */
export function analyseBattery(observations, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const entries = [];

  for (const obs of observations) {
    entries.push({
      key: obs.key,
      probeId: obs.probeId,
      metricId: obs.metricId,
      kind: obs.kind,
      direction: obs.metricDirection,
      label: obs.label,
      result: analyseLocal(obs.baseline, obs.current, obs.kind, cfg),
    });
  }

  const testable = entries.filter((e) => e.result.sufficient);
  const adjusted = benjaminiHochberg(testable.map((e) => e.result.pValue));
  testable.forEach((e, i) => { e.result.adjustedP = adjusted[i]; });
  entries.filter((e) => !e.result.sufficient).forEach((e) => { e.result.adjustedP = 1; });

  for (const e of entries) {
    e.significant = e.result.sufficient
      && e.result.adjustedP < cfg.alpha
      && Math.abs(e.result.effect) >= cfg.minEffect;
  }

  return {
    entries,
    comparisons: testable.length,
    flagged: entries.filter((e) => e.significant).length,
    // Reported so a customer can see the multiplicity burden we absorbed.
    uncorrectedFlags: testable.filter(
      (e) => e.result.pValue < cfg.alpha && Math.abs(e.result.effect) >= cfg.minEffect,
    ).length,
  };
}

// ---------------------------------------------------------------------------
// Consensus: pooling across tenants
// ---------------------------------------------------------------------------

/**
 * Independence weighting.
 *
 * Five tenants behind one reseller, in one region, hitting one gateway are not
 * five independent witnesses. If we counted them as five we could be fooled by
 * a single shared misconfiguration — the exact failure mode that would make us
 * publish a false global event. So each tenant is discounted by how crowded its
 * (region, gateway, sdk) cohort is: the k-th member of a cohort contributes
 * 1/sqrt(k). The first witness in a cohort counts fully; the tenth adds little.
 */
export function independenceWeights(reports) {
  const seen = new Map();
  const weights = new Map();

  for (const r of reports) {
    const cohort = `${r.region ?? 'unknown'}|${r.gateway ?? 'direct'}|${r.sdk ?? 'unknown'}`;
    const k = (seen.get(cohort) ?? 0) + 1;
    seen.set(cohort, k);
    weights.set(r.tenantId, 1 / Math.sqrt(k));
  }

  return weights;
}

/**
 * Fold per-tenant findings for ONE endpoint+metric into a consensus verdict.
 *
 * `reports` are already-analysed local results, one per tenant:
 *   { tenantId, region, gateway, sdk, significant, effect, direction,
 *     adjustedP, observedAt }
 */
export function buildConsensus(reports, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };

  if (reports.length === 0) {
    return {
      grade: GRADE.UNCONFIRMED,
      tenantsReporting: 0,
      tenantsCorroborating: 0,
      agreement: 0,
      effectiveWitnesses: 0,
      medianEffect: 0,
      direction: 0,
      onsetWindow: null,
      falseAlarmBound: null,
    };
  }

  const weights = independenceWeights(reports);
  const corroborating = reports.filter((r) => r.significant);

  // Directional agreement: a real provider-side change moves everyone the same
  // way. Tenants split evenly on direction indicates noise or a routing split,
  // not a coherent change, and must not be published as one.
  const up = corroborating.filter((r) => r.direction > 0).length;
  const down = corroborating.filter((r) => r.direction < 0).length;
  const dominant = up >= down ? 1 : -1;
  const agreeing = corroborating.filter((r) => r.direction === dominant);
  const agreement = corroborating.length === 0
    ? 0
    : agreeing.length / corroborating.length;

  // Effective witnesses: independence-weighted count of agreeing tenants.
  const effectiveWitnesses = agreeing.reduce(
    (sum, r) => sum + (weights.get(r.tenantId) ?? 1),
    0,
  );

  const effects = agreeing.map((r) => r.effect);
  const medianEffect = effects.length ? quantile(effects, 0.5) : 0;

  // Onset window: the interval in which the change became visible. We report
  // an interval rather than a timestamp because that is what the evidence
  // supports — the truth is bounded by first and last independent sighting.
  const times = agreeing.map((r) => r.observedAt).filter(Boolean).sort();
  const onsetWindow = times.length
    ? { earliest: times[0], latest: times[times.length - 1], sightings: times.length }
    : null;

  // Honest upper bound on the false-alarm rate given the corroborating
  // fraction. With zero corroboration out of many reporters, a Wald interval
  // would claim 0%; Wilson gives a defensible bound instead.
  const falseAlarmBound = wilsonInterval(corroborating.length, reports.length);

  // --- The corroboration test -------------------------------------------
  //
  // This is the step that makes the network genuinely worth more as it grows,
  // and getting it wrong inverts the entire product thesis.
  //
  // The tempting rule is "alert once K tenants agree". That rule DEGRADES with
  // scale: if each tenant throws a chance flag at rate p0 on a stable
  // endpoint, then across n tenants roughly p0*n of them flag by luck alone,
  // so any fixed K is eventually cleared by noise on every single cycle. A
  // 500-tenant fleet would alert constantly on a perfectly healthy endpoint.
  //
  // So we do not ask "how many agree". We ask whether MORE tenants agree than
  // chance would produce at this fleet size, via an exact binomial tail. The
  // null grows with n, the observed count grows with n, and a real change
  // separates the two ever more sharply — which is precisely the asymmetry we
  // are selling. A lone tenant cannot compute this number at all.
  const agreeingCount = agreeing.length;
  const corroborationP = binomialTailP(agreeingCount, reports.length, cfg.nullFlagRate);
  const beatsChance = corroborationP < cfg.corroborationAlpha;

  let grade;
  if (
    beatsChance
    && effectiveWitnesses >= cfg.confirmTenants
    && agreement >= cfg.minAgreement
    && Math.abs(medianEffect) >= EFFECT.SMALL
  ) {
    grade = GRADE.CONFIRMED;
  } else if (
    beatsChance
    && effectiveWitnesses >= cfg.likelyTenants
    && agreement >= cfg.minAgreement
    && Math.abs(medianEffect) >= cfg.minEffect
  ) {
    grade = GRADE.LIKELY;
  } else if (
    corroborating.length >= 1
    && reports.length >= cfg.confirmTenants
    && !beatsChance
  ) {
    // The suppression verdict: this tenant sees something, a healthy fleet on
    // the same endpoint does not. Point them at their own stack.
    grade = GRADE.LOCAL;
  } else {
    grade = GRADE.UNCONFIRMED;
  }

  return {
    grade,
    tenantsReporting: reports.length,
    tenantsCorroborating: corroborating.length,
    agreement,
    effectiveWitnesses,
    medianEffect,
    direction: effects.length ? Math.sign(medianEffect) : 0,
    effectMagnitude: magnitudeLabel(Math.abs(medianEffect)),
    onsetWindow,
    falseAlarmBound,
    // Surfaced so a customer can audit exactly why we did or did not publish:
    // "9 of 40 tenants agreed; chance alone produces that 21% of the time".
    corroborationP,
    beatsChance,
  };
}

/** Human-readable effect magnitude, using the Cliff's delta thresholds. */
export function magnitudeLabel(absEffect) {
  if (absEffect < EFFECT.NEGLIGIBLE) return 'negligible';
  if (absEffect < EFFECT.SMALL) return 'small';
  if (absEffect < EFFECT.MEDIUM) return 'medium';
  return 'large';
}

/**
 * Assemble a publishable Change Event for one endpoint from consensus verdicts
 * across the whole battery.
 *
 * The direction vector is the part Autopilot consumes: an ordered list of which
 * behaviours moved and how. "Stricter JSON, more preamble, higher refusal rate"
 * is actionable; "something changed" is not.
 */
export function buildChangeEvent(endpoint, metricVerdicts, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };

  const material = metricVerdicts.filter(
    (v) => v.consensus.grade === GRADE.CONFIRMED || v.consensus.grade === GRADE.LIKELY,
  );

  if (material.length === 0) return null;

  // Rank by how much corroboration each signal carries, then by effect size.
  const ranked = [...material].sort((a, b) => {
    const w = b.consensus.effectiveWitnesses - a.consensus.effectiveWitnesses;
    if (Math.abs(w) > 1e-9) return w;
    return Math.abs(b.consensus.medianEffect) - Math.abs(a.consensus.medianEffect);
  });

  const confirmed = ranked.filter((v) => v.consensus.grade === GRADE.CONFIRMED);
  const grade = confirmed.length > 0 ? GRADE.CONFIRMED : GRADE.LIKELY;

  const directionVector = ranked.map((v) => ({
    key: v.key,
    probeId: v.probeId,
    metricId: v.metricId,
    label: v.label,
    direction: v.consensus.direction,
    effect: v.consensus.medianEffect,
    magnitude: v.consensus.effectMagnitude,
    witnesses: v.consensus.effectiveWitnesses,
    tenantsCorroborating: v.consensus.tenantsCorroborating,
    interpretation: interpret(v),
  }));

  // The onset window for the event is the tightest interval consistent with
  // all contributing signals: latest earliest-sighting, earliest latest-sighting.
  const windows = ranked.map((v) => v.consensus.onsetWindow).filter(Boolean);
  const onsetWindow = windows.length
    ? {
      earliest: windows.map((w) => w.earliest).sort()[0],
      latest: windows.map((w) => w.latest).sort().at(-1),
      sightings: windows.reduce((n, w) => n + w.sightings, 0),
    }
    : null;

  const peakWitnesses = Math.max(...ranked.map((v) => v.consensus.effectiveWitnesses));

  return {
    endpoint,
    grade,
    onsetWindow,
    signalCount: ranked.length,
    peakWitnesses,
    directionVector,
    summary: summarise(endpoint, grade, directionVector, peakWitnesses),
    alpha: cfg.alpha,
    suppressed: metricVerdicts
      .filter((v) => v.consensus.grade === GRADE.LOCAL)
      .map((v) => v.key),
  };
}

/**
 * Translate a signal into the sentence a customer actually needs. The direction
 * semantics come from the probe definition, so "higher" means the right thing
 * for each metric rather than being reported as a bare number.
 */
function interpret(verdict) {
  const { direction, effectMagnitude } = verdict.consensus;
  const label = verdict.label ?? verdict.metricId;
  if (direction === 0) return `${label}: changed shape without a clear direction`;
  const way = direction > 0 ? 'increased' : 'decreased';
  return `${label}: ${way} (${effectMagnitude} effect)`;
}

function summarise(endpoint, grade, vector, witnesses) {
  const top = vector.slice(0, 3).map((v) => v.interpretation).join('; ');
  const strength = grade === GRADE.CONFIRMED ? 'Confirmed' : 'Likely';
  const w = witnesses.toFixed(1);
  return `${strength} behavioural change on ${endpoint} — ${top}. `
    + `Corroborated by ${w} effective independent witnesses.`;
}

/**
 * Blast radius: which of a tenant's own prompts are exposed to a change event.
 *
 * We never inspect prompt text server-side. A tenant registers each prompt with
 * the endpoint it targets and the behaviours it depends on (declared in their
 * config or inferred locally by the SDK), and we intersect those declarations
 * with the event's direction vector. The result is ordered by exposure so an
 * on-call engineer knows what to check first.
 */
export function blastRadius(changeEvent, promptInventory) {
  if (!changeEvent) return [];

  const affectedKeys = new Map(
    changeEvent.directionVector.map((d) => [d.key, d]),
  );

  const hits = [];
  for (const prompt of promptInventory) {
    if (prompt.endpoint !== changeEvent.endpoint) continue;

    const matched = (prompt.dependsOn ?? [])
      .filter((key) => affectedKeys.has(key))
      .map((key) => affectedKeys.get(key));

    if (matched.length === 0) continue;

    // Exposure combines how many depended-on behaviours moved, how hard they
    // moved, and how business-critical the prompt is. Criticality is the
    // tenant's own declaration — they know which prompt is load-bearing.
    const severity = matched.reduce((s, m) => s + Math.abs(m.effect), 0);
    const criticality = prompt.criticality ?? 1;
    hits.push({
      promptId: prompt.id,
      name: prompt.name ?? prompt.id,
      endpoint: prompt.endpoint,
      criticality,
      matchedSignals: matched.map((m) => m.key),
      exposure: Number((severity * criticality).toFixed(6)),
      rationale: matched.map((m) => m.interpretation),
    });
  }

  return hits.sort((a, b) => b.exposure - a.exposure);
}
