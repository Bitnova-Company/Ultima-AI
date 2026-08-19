/**
 * Consensus engine tests.
 *
 * These are the tests that check the business thesis, not just the code. The
 * claim Ultima sells is that pooling independent observers converts an
 * ambiguous local signal into a decisive global one, and -- just as
 * importantly -- correctly tells a lone tenant "this is your problem, not the
 * provider's". Both claims are simulated end to end below against synthetic
 * fleets, because if they do not hold numerically there is no product.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULTS,
  EFFECT,
  GRADE,
  analyseBattery,
  analyseLocal,
  blastRadius,
  buildChangeEvent,
  buildConsensus,
  independenceWeights,
  magnitudeLabel,
  testsForKind,
} from '../src/consensus.js';
import { METRIC_KIND } from '../src/probes.js';
import { gaussian, seededRandom } from '../src/stats.js';

/* ------------------------------------------------------------------ *
 * Local analysis
 * ------------------------------------------------------------------ */

test('test selection matches the metric kind', () => {
  // Binary metrics must not go through a t-test: at a proportion near 0 or 1
  // its nominal coverage is simply wrong.
  assert.deepEqual(testsForKind(METRIC_KIND.BINARY), ['mannWhitney']);
  assert.ok(testsForKind(METRIC_KIND.COUNT).includes('ks'));
  const continuous = testsForKind(METRIC_KIND.CONTINUOUS);
  assert.ok(continuous.includes('welch'), 'location');
  assert.ok(continuous.includes('levene'), 'scale');
  assert.ok(continuous.includes('ks'), 'shape');
});

test('analyseLocal refuses to guess from thin data', () => {
  const rnd = seededRandom(1);
  const few = Array.from({ length: 5 }, () => gaussian(rnd, 0, 1));
  const many = Array.from({ length: 50 }, () => gaussian(rnd, 3, 1));

  const r = analyseLocal(few, many, METRIC_KIND.CONTINUOUS);
  assert.equal(r.sufficient, false, 'must decline rather than report a p-value');
  assert.equal(r.pValue, 1, 'an unanalysable comparison is not evidence');
  assert.match(r.reason, /need \d+ samples/);
});

test('analyseLocal finds a real shift and stays quiet on noise', async (t) => {
  const rnd = seededRandom(2);
  const sample = (n, m, s) => Array.from({ length: n }, () => gaussian(rnd, m, s));

  await t.test('detects a genuine mean shift with a meaningful effect size', () => {
    const r = analyseLocal(sample(60, 100, 10), sample(60, 118, 10), METRIC_KIND.CONTINUOUS);
    assert.ok(r.sufficient);
    assert.ok(r.pValue < 1e-6, `p=${r.pValue}`);
    assert.ok(Math.abs(r.effect) > EFFECT.MEDIUM, `effect=${r.effect}`);
    assert.equal(r.direction, 1, 'current is higher than baseline');
  });

  await t.test('reports direction relative to baseline, not argument order', () => {
    const r = analyseLocal(sample(60, 118, 10), sample(60, 100, 10), METRIC_KIND.CONTINUOUS);
    assert.equal(r.direction, -1, 'current below baseline is negative');
  });

  await t.test('stays unconvinced on pure noise', () => {
    let flagged = 0;
    for (let i = 0; i < 100; i++) {
      const r = analyseLocal(sample(40, 50, 8), sample(40, 50, 8), METRIC_KIND.CONTINUOUS);
      if (r.pValue < 0.05 && Math.abs(r.effect) >= DEFAULTS.minEffect) flagged++;
    }
    // Three tests are combined by taking the minimum p, so the raw rate is
    // inflated above alpha by construction. That is intentional and is bought
    // back by BH plus corroboration; here we only assert it has not exploded.
    assert.ok(flagged <= 20, `raw local flag rate too high: ${flagged}/100`);
  });

  await t.test('catches a variance-only change that leaves the mean intact', () => {
    const r = analyseLocal(sample(80, 200, 10), sample(80, 200, 45), METRIC_KIND.CONTINUOUS);
    assert.ok(r.pValue < 0.01, `scale change should be detected, p=${r.pValue}`);
  });
});

test('analyseBattery applies BH across the whole battery, not per metric', async (t) => {
  const rnd = seededRandom(3);
  const noise = (n) => Array.from({ length: n }, () => gaussian(rnd, 1, 0.2));

  await t.test('multiplicity control suppresses the daily false event', () => {
    // 30 null comparisons per cycle. Uncorrected, a cycle throws a flag more
    // often than not; corrected, it should almost never publish anything.
    let cyclesWithRaw = 0;
    let cyclesWithAdjusted = 0;
    const CYCLES = 120;

    for (let c = 0; c < CYCLES; c++) {
      const observations = Array.from({ length: 30 }, (_, i) => ({
        key: `probe${i}::metric`,
        probeId: `probe${i}`,
        metricId: 'metric',
        kind: METRIC_KIND.CONTINUOUS,
        label: 'metric',
        baseline: noise(40),
        current: noise(40),
      }));
      const out = analyseBattery(observations);
      if (out.uncorrectedFlags > 0) cyclesWithRaw++;
      if (out.flagged > 0) cyclesWithAdjusted++;
    }

    assert.ok(cyclesWithRaw / CYCLES > 0.3,
      `expected uncorrected testing to be noisy, got ${cyclesWithRaw}/${CYCLES}`);
    assert.ok(cyclesWithAdjusted / CYCLES < 0.12,
      `BH failed to control the battery: ${cyclesWithAdjusted}/${CYCLES} cycles flagged`);
    assert.ok(cyclesWithAdjusted < cyclesWithRaw,
      'correction must reduce the flag rate');
  });

  await t.test('a real change still survives correction', () => {
    const observations = Array.from({ length: 30 }, (_, i) => ({
      key: `probe${i}::metric`,
      probeId: `probe${i}`,
      metricId: 'metric',
      kind: METRIC_KIND.CONTINUOUS,
      label: 'metric',
      baseline: noise(60),
      current: i < 3
        ? Array.from({ length: 60 }, () => gaussian(rnd, 1.35, 0.2))
        : noise(60),
    }));
    const out = analyseBattery(observations);
    assert.ok(out.flagged >= 3, `expected the 3 shifted metrics, got ${out.flagged}`);
    assert.ok(out.flagged <= 6, `too many extra flags: ${out.flagged}`);
  });

  await t.test('insufficient-data entries never count as evidence', () => {
    const out = analyseBattery([
      {
        key: 'a::m',
        probeId: 'a',
        metricId: 'm',
        kind: METRIC_KIND.CONTINUOUS,
        label: 'm',
        baseline: [1, 2, 3],
        current: [9, 9, 9],
      },
    ]);
    assert.equal(out.comparisons, 0, 'nothing was testable');
    assert.equal(out.flagged, 0, 'and so nothing may be flagged');
    assert.equal(out.entries[0].result.adjustedP, 1);
  });

  await t.test('an empty battery is handled', () => {
    const out = analyseBattery([]);
    assert.deepEqual(out.entries, []);
    assert.equal(out.flagged, 0);
  });
});

/* ------------------------------------------------------------------ *
 * Independence weighting
 * ------------------------------------------------------------------ */

test('independence weighting discounts correlated witnesses', async (t) => {
  await t.test('tenants in distinct cohorts each count fully', () => {
    const w = independenceWeights([
      { tenantId: 'a', region: 'us-east', gateway: 'direct', sdk: 'node' },
      { tenantId: 'b', region: 'eu-west', gateway: 'portkey', sdk: 'python' },
      { tenantId: 'c', region: 'ap-south', gateway: 'litellm', sdk: 'go' },
    ]);
    for (const id of ['a', 'b', 'c']) assert.equal(w.get(id), 1);
  });

  await t.test('a crowded cohort is discounted', () => {
    // Five tenants behind one reseller in one region are not five independent
    // witnesses; treating them as such is how a shared misconfiguration gets
    // published as a global provider change.
    const reports = Array.from({ length: 5 }, (_, i) => ({
      tenantId: `t${i}`, region: 'us-east', gateway: 'acme-reseller', sdk: 'node',
    }));
    const w = independenceWeights(reports);
    assert.equal(w.get('t0'), 1, 'first witness counts fully');
    assert.ok(w.get('t4') < 0.5, 'fifth adds little');
    const total = reports.reduce((s, r) => s + w.get(r.tenantId), 0);
    assert.ok(total < 3.5, `five clones should not weigh 5, got ${total.toFixed(2)}`);
    assert.ok(total > 2.5, 'but they are not worthless either');
  });

  await t.test('weights are monotonically non-increasing within a cohort', () => {
    const reports = Array.from({ length: 8 }, (_, i) => ({
      tenantId: `t${i}`, region: 'r', gateway: 'g', sdk: 's',
    }));
    const w = independenceWeights(reports);
    for (let i = 1; i < 8; i++) {
      assert.ok(w.get(`t${i}`) <= w.get(`t${i - 1}`));
    }
  });
});

/* ------------------------------------------------------------------ *
 * Consensus grading -- the core of the moat
 * ------------------------------------------------------------------ */

/** Build a synthetic tenant report. */
function report(id, { significant = true, effect = 0.5, region = null, at = '2026-08-19T14:07:00Z' } = {}) {
  return {
    tenantId: id,
    region: region ?? `region-${id}`,
    gateway: `gw-${id}`,
    sdk: 'node',
    significant,
    effect,
    direction: Math.sign(effect),
    adjustedP: significant ? 0.001 : 0.4,
    observedAt: at,
  };
}

test('consensus grading reflects the weight of evidence', async (t) => {
  await t.test('a broad, independent, large-effect signal is CONFIRMED', () => {
    const reports = Array.from({ length: 12 }, (_, i) => report(`t${i}`, { effect: 0.55 }));
    const c = buildConsensus(reports);
    assert.equal(c.grade, GRADE.CONFIRMED);
    assert.ok(c.effectiveWitnesses >= DEFAULTS.confirmTenants);
    assert.equal(c.agreement, 1);
    assert.equal(c.direction, 1);
    assert.equal(c.effectMagnitude, 'large');
  });

  await t.test('a modest but well-corroborated effect grades LIKELY', () => {
    // Corroboration beats chance, but the effect is below the "large" bar, so
    // it is worth watching rather than paging.
    const reports = [
      ...Array.from({ length: 5 }, (_, i) => report(`hit${i}`, { effect: 0.25 })),
      ...Array.from({ length: 3 }, (_, i) => report(`ok${i}`, { significant: false, effect: 0.01 })),
    ];
    const c = buildConsensus(reports);
    assert.equal(c.grade, GRADE.LIKELY);
    assert.equal(c.tenantsCorroborating, 5);
  });

  await t.test('a handful of agreeing tenants is not yet evidence', () => {
    // Two of three tenants agreeing looks compelling to a human and is not:
    // at a 10% per-tenant chance-flag rate it happens ~2.8% of the time by
    // luck. The engine must decline to publish.
    const c = buildConsensus([
      report('a', { effect: 0.5 }),
      report('b', { effect: 0.48 }),
      report('c', { significant: false, effect: 0.01 }),
    ]);
    assert.ok(c.corroborationP > 0.001, `p=${c.corroborationP}`);
    assert.equal(c.grade, GRADE.UNCONFIRMED);
  });

  await t.test('a single witness among many healthy peers is LOCAL', () => {
    // The suppression case. This is the verdict a single-tenant tool can never
    // reach, and it is worth as much as the confirmation case: it stops an
    // engineer chasing a provider change that did not happen.
    const reports = [
      report('noisy', { effect: 0.6 }),
      ...Array.from({ length: 9 }, (_, i) => report(`ok${i}`, { significant: false, effect: 0.01 })),
    ];
    const c = buildConsensus(reports);
    assert.equal(c.grade, GRADE.LOCAL);
    assert.equal(c.tenantsCorroborating, 1);
    assert.ok(c.falseAlarmBound.upper < 0.45,
      'the fleet bounds how often this endpoint looks broken');
  });

  await t.test('tenants disagreeing on direction is not a change', () => {
    // Half up, half down is noise or a routing split, never a coherent
    // provider change, and must not be published as one.
    const reports = [
      ...Array.from({ length: 5 }, (_, i) => report(`up${i}`, { effect: 0.5 })),
      ...Array.from({ length: 5 }, (_, i) => report(`dn${i}`, { effect: -0.5 })),
    ];
    const c = buildConsensus(reports);
    assert.ok(c.agreement <= 0.6, `agreement should be low, got ${c.agreement}`);
    assert.notEqual(c.grade, GRADE.CONFIRMED);
  });

  await t.test('many correlated witnesses cannot fake a CONFIRMED grade', () => {
    // Eight tenants, all in one cohort. Naive counting says "8 witnesses,
    // confirmed". Independence weighting must refuse.
    const reports = Array.from({ length: 8 }, (_, i) => ({
      ...report(`clone${i}`, { effect: 0.55 }),
      region: 'us-east',
      gateway: 'one-reseller',
      sdk: 'node',
    }));
    const c = buildConsensus(reports);
    assert.equal(c.tenantsCorroborating, 8);
    assert.ok(c.effectiveWitnesses < 5,
      `correlated witnesses should not reach the confirm threshold, got ${c.effectiveWitnesses.toFixed(2)}`);
    assert.notEqual(c.grade, GRADE.CONFIRMED);
  });

  await t.test('a fixed count cannot be cleared by noise in a large fleet', () => {
    // The regression guard for the rule this engine originally got wrong.
    // Ten agreeing tenants is plenty of evidence in a fleet of 12 and is
    // exactly what chance produces in a fleet of 100. The verdict must differ.
    const mk = (n, agreeing) => [
      ...Array.from({ length: agreeing }, (_, i) => report(`hit${i}`, { effect: 0.55 })),
      ...Array.from({ length: n - agreeing }, (_, i) => report(`ok${i}`, { significant: false, effect: 0.01 })),
    ];
    const small = buildConsensus(mk(12, 10));
    const large = buildConsensus(mk(100, 10));
    assert.equal(small.grade, GRADE.CONFIRMED, '10 of 12 is overwhelming');
    assert.notEqual(large.grade, GRADE.CONFIRMED, '10 of 100 is the chance rate');
    assert.ok(large.corroborationP > small.corroborationP);
  });

  await t.test('a statistically real but negligible effect is not published', () => {
    // Large samples make trivial differences significant. Publishing those
    // would page customers over nothing and destroy trust in the alert.
    const reports = Array.from({ length: 20 }, (_, i) => report(`t${i}`, { effect: 0.05 }));
    const c = buildConsensus(reports);
    assert.equal(c.effectMagnitude, 'negligible');
    assert.notEqual(c.grade, GRADE.CONFIRMED);
    assert.notEqual(c.grade, GRADE.LIKELY);
  });

  await t.test('no reports yields a safe empty verdict', () => {
    const c = buildConsensus([]);
    assert.equal(c.grade, GRADE.UNCONFIRMED);
    assert.equal(c.tenantsReporting, 0);
    assert.equal(c.effectiveWitnesses, 0);
  });

  await t.test('the onset window brackets independent sightings', () => {
    const c = buildConsensus([
      report('a', { effect: 0.5, at: '2026-08-19T14:07:00Z' }),
      report('b', { effect: 0.5, at: '2026-08-19T14:22:00Z' }),
      report('c', { effect: 0.5, at: '2026-08-19T15:01:00Z' }),
    ]);
    assert.equal(c.onsetWindow.earliest, '2026-08-19T14:07:00Z');
    assert.equal(c.onsetWindow.latest, '2026-08-19T15:01:00Z');
    assert.equal(c.onsetWindow.sightings, 3);
  });
});

test('magnitudeLabel matches the Cliff thresholds', () => {
  assert.equal(magnitudeLabel(0.10), 'negligible');
  assert.equal(magnitudeLabel(0.20), 'small');
  assert.equal(magnitudeLabel(0.40), 'medium');
  assert.equal(magnitudeLabel(0.80), 'large');
});

/* ------------------------------------------------------------------ *
 * The network effect, simulated
 * ------------------------------------------------------------------ */

test('detection confidence scales with fleet size', () => {
  // The moat claim, stated numerically: with a subtle real change, a single
  // tenant is a coin flip, while a fleet is decisive. If this does not hold,
  // there is no network effect to defend.
  const rnd = seededRandom(777);

  /** One tenant observes a subtle real shift, with local sampling noise. */
  function tenantObserves(shifted) {
    const baseline = Array.from({ length: 30 }, () => gaussian(rnd, 1.0, 0.25));
    const current = Array.from({ length: 30 },
      () => gaussian(rnd, shifted ? 1.11 : 1.0, 0.25));
    const local = analyseLocal(baseline, current, METRIC_KIND.CONTINUOUS);
    return {
      significant: local.pValue < 0.05 && Math.abs(local.effect) >= DEFAULTS.minEffect,
      effect: local.effect,
      direction: local.direction,
    };
  }

  function fleetVerdict(size, shifted) {
    const reports = Array.from({ length: size }, (_, i) => ({
      tenantId: `t${i}`,
      region: `region-${i % 7}`,
      gateway: `gw-${i % 5}`,
      sdk: `sdk-${i % 3}`,
      observedAt: '2026-08-19T14:07:00Z',
      ...tenantObserves(shifted),
    }));
    return buildConsensus(reports);
  }

  const TRIALS = 80;
  const detected = {};
  const falseAlarms = {};

  for (const size of [1, 3, 10, 50]) {
    let hits = 0;
    let fps = 0;
    for (let i = 0; i < TRIALS; i++) {
      const real = fleetVerdict(size, true);
      if (real.grade === GRADE.CONFIRMED || real.grade === GRADE.LIKELY) hits++;
      const nullRun = fleetVerdict(size, false);
      if (nullRun.grade === GRADE.CONFIRMED || nullRun.grade === GRADE.LIKELY) fps++;
    }
    detected[size] = hits / TRIALS;
    falseAlarms[size] = fps / TRIALS;
  }

  // A lone tenant literally cannot reach a verdict on a subtle change: no
  // corroboration count in a fleet of one can beat chance. This is the honest
  // statement of what single-tenant tooling can and cannot do.
  assert.equal(detected[1], 0,
    'a single tenant must never self-confirm a provider change');

  // A fleet is decisive on exactly the same underlying signal.
  assert.ok(detected[50] > 0.9,
    `a 50-tenant fleet should be near-certain, got ${detected[50]}`);

  // Detection improves monotonically with scale -- the moat, measured.
  assert.ok(detected[3] >= detected[1], 'detection must not fall with scale');
  assert.ok(detected[10] >= detected[3], 'detection must not fall with scale');
  assert.ok(detected[50] >= detected[10], 'detection must not fall with scale');
  assert.ok(detected[50] - detected[10] > 0 || detected[10] > 0.85,
    'scale must buy real sensitivity, not a plateau at chance');

  // Crucially, scale buys sensitivity WITHOUT buying false alarms. This is the
  // property the original fixed-threshold rule violated: chance flags grow
  // linearly with fleet size, so a fixed "K agreeing tenants" bar is cleared
  // by noise alone once the network is large.
  for (const size of [1, 3, 10, 50]) {
    assert.ok(falseAlarms[size] <= 0.05,
      `fleet of ${size} raised ${falseAlarms[size]} false alarms on a stable endpoint`);
  }
  assert.ok(falseAlarms[50] <= falseAlarms[1] + 0.02,
    'false alarms must not grow with the network');
});

/* ------------------------------------------------------------------ *
 * Change events and blast radius
 * ------------------------------------------------------------------ */

/** Build a metric verdict with a given consensus grade. */
function verdict(key, grade, { effect = 0.5, witnesses = 8, label = key } = {}) {
  return {
    key,
    probeId: key.split('::')[0],
    metricId: key.split('::')[1],
    label,
    consensus: {
      grade,
      direction: Math.sign(effect),
      medianEffect: effect,
      effectMagnitude: magnitudeLabel(Math.abs(effect)),
      effectiveWitnesses: witnesses,
      tenantsCorroborating: Math.round(witnesses),
      onsetWindow: {
        earliest: '2026-08-19T14:07:00Z',
        latest: '2026-08-19T14:40:00Z',
        sightings: Math.round(witnesses),
      },
    },
  };
}

test('change events are only published on material evidence', async (t) => {
  await t.test('no material signal means no event', () => {
    assert.equal(buildChangeEvent('gpt-x', []), null);
    assert.equal(
      buildChangeEvent('gpt-x', [verdict('a::b', GRADE.UNCONFIRMED)]),
      null,
      'unconfirmed signals must never become an event',
    );
    assert.equal(
      buildChangeEvent('gpt-x', [verdict('a::b', GRADE.LOCAL)]),
      null,
      'a local signal is not a provider change',
    );
  });

  await t.test('a confirmed signal produces an actionable event', () => {
    const event = buildChangeEvent('gpt-x@2026-06', [
      verdict('json.strict.flat::json_parses_strict', GRADE.CONFIRMED,
        { effect: -0.62, witnesses: 14, label: 'parses as JSON without repair' }),
      verdict('format.exact.answer::preamble_chars', GRADE.CONFIRMED,
        { effect: 0.41, witnesses: 9, label: 'characters before the answer' }),
      verdict('latency.baseline::latency_ms', GRADE.LIKELY,
        { effect: 0.2, witnesses: 3, label: 'end-to-end latency' }),
      verdict('refusal.benign.medical::refused', GRADE.LOCAL,
        { effect: 0.7, witnesses: 1, label: 'declined to answer' }),
    ]);

    assert.equal(event.grade, GRADE.CONFIRMED);
    assert.equal(event.signalCount, 3, 'the LOCAL signal is excluded');
    assert.deepEqual(event.suppressed, ['refusal.benign.medical::refused'],
      'suppressed signals are reported, not silently dropped');

    // Ranked by corroboration weight, so the most defensible signal leads.
    assert.equal(event.directionVector[0].key, 'json.strict.flat::json_parses_strict');
    assert.ok(event.directionVector[0].interpretation.includes('decreased'));

    assert.equal(event.onsetWindow.earliest, '2026-08-19T14:07:00Z');
    assert.ok(event.summary.includes('gpt-x@2026-06'));
    assert.ok(/effective independent witnesses/.test(event.summary));
  });

  await t.test('signals with equal corroboration are ranked by effect size', () => {
    // The tie-break decides which sentence leads the customer-facing summary,
    // so it should surface the biggest behavioural move, not insertion order.
    const event = buildChangeEvent('gpt-x', [
      verdict('small::m', GRADE.CONFIRMED, { effect: 0.35, witnesses: 7 }),
      verdict('big::m', GRADE.CONFIRMED, { effect: -0.80, witnesses: 7 }),
    ]);
    assert.equal(event.directionVector[0].key, 'big::m');
    assert.ok(event.summary.startsWith('Confirmed'));
  });

  await t.test('only-likely signals produce a likely event', () => {
    const event = buildChangeEvent('gpt-x', [
      verdict('a::b', GRADE.LIKELY, { effect: 0.3, witnesses: 2 }),
    ]);
    assert.equal(event.grade, GRADE.LIKELY);
  });
});

test('blast radius ranks a tenant\'s exposure without reading their prompts', async (t) => {
  const event = buildChangeEvent('gpt-x', [
    verdict('json.strict.flat::json_parses_strict', GRADE.CONFIRMED,
      { effect: -0.6, witnesses: 12, label: 'parses as JSON without repair' }),
    verdict('format.exact.answer::preamble_chars', GRADE.CONFIRMED,
      { effect: 0.4, witnesses: 10, label: 'characters before the answer' }),
  ]);

  const inventory = [
    {
      id: 'p1',
      name: 'Invoice extractor',
      endpoint: 'gpt-x',
      criticality: 3,
      dependsOn: ['json.strict.flat::json_parses_strict'],
    },
    {
      id: 'p2',
      name: 'Support autoresponder',
      endpoint: 'gpt-x',
      criticality: 1,
      dependsOn: ['format.exact.answer::preamble_chars'],
    },
    {
      id: 'p3',
      name: 'Unrelated summariser',
      endpoint: 'gpt-x',
      criticality: 5,
      dependsOn: ['some.other::metric'],
    },
    {
      id: 'p4',
      name: 'Runs on a different model',
      endpoint: 'other-model',
      criticality: 9,
      dependsOn: ['json.strict.flat::json_parses_strict'],
    },
  ];

  await t.test('only genuinely exposed prompts are listed', () => {
    const hits = blastRadius(event, inventory);
    const ids = hits.map((h) => h.promptId);
    assert.deepEqual(ids, ['p1', 'p2'], 'p3 depends on nothing that moved; p4 is another endpoint');
  });

  await t.test('ranking combines effect size with tenant-declared criticality', () => {
    const hits = blastRadius(event, inventory);
    assert.equal(hits[0].promptId, 'p1', 'critical + large effect ranks first');
    assert.ok(hits[0].exposure > hits[1].exposure);
    assert.ok(hits[0].rationale[0].includes('parses as JSON'),
      'each hit explains itself in product terms');
  });

  await t.test('a prompt exposed to several moved behaviours outranks one', () => {
    const both = blastRadius(event, [
      { id: 'one', endpoint: 'gpt-x', criticality: 1, dependsOn: ['json.strict.flat::json_parses_strict'] },
      {
        id: 'two',
        endpoint: 'gpt-x',
        criticality: 1,
        dependsOn: [
          'json.strict.flat::json_parses_strict',
          'format.exact.answer::preamble_chars',
        ],
      },
    ]);
    assert.equal(both[0].promptId, 'two');
    assert.equal(both[0].matchedSignals.length, 2);
  });

  await t.test('degenerate inputs are handled', () => {
    assert.deepEqual(blastRadius(null, inventory), []);
    assert.deepEqual(blastRadius(event, []), []);
    assert.deepEqual(
      blastRadius(event, [{ id: 'x', endpoint: 'gpt-x', criticality: 1 }]),
      [],
      'a prompt with no declared dependencies claims no exposure',
    );
  });
});
