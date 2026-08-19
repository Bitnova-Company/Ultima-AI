/**
 * Sentinel probe suite tests.
 *
 * Two things must hold or the product is either unsafe or unsound:
 *
 *   1. Probes stay frozen. If probe text or metric definitions can drift, we
 *      would attribute our own edits to the provider. The fingerprint test
 *      exists to make an accidental edit fail loudly.
 *
 *   2. Extractors are total. A collection cycle runs against a live endpoint
 *      that can return anything at all -- truncated JSON, an empty body, a
 *      provider error object. No extractor may throw or emit NaN, because one
 *      bad response must not take down a whole cycle.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DIRECTION,
  METRIC_KIND,
  PROBES,
  SUITE_VERSION,
  allMetricKeys,
  extractMetrics,
  firstToolCall,
  getProbe,
  hedgeCount,
  looksLikeRefusal,
  parsesAfterRepair,
  parsesAsStrictJson,
  preambleLength,
  probeFingerprint,
  requiredKeyCoverage,
  shapeOf,
  stripFences,
  wordCount,
} from '../src/probes.js';

/* ------------------------------------------------------------------ *
 * Suite integrity
 * ------------------------------------------------------------------ */

test('the probe suite is well formed', async (t) => {
  await t.test('every probe has the fields the pipeline relies on', () => {
    for (const p of PROBES) {
      assert.ok(p.id && typeof p.id === 'string', 'probe needs an id');
      assert.ok(p.title, `${p.id}: needs a title`);
      assert.ok(p.rationale && p.rationale.length > 40,
        `${p.id}: needs a rationale explaining what production breakage it catches`);
      assert.ok(p.request?.user, `${p.id}: needs a user message`);
      assert.ok(Array.isArray(p.metrics) && p.metrics.length > 0,
        `${p.id}: needs at least one metric`);
    }
  });

  await t.test('probe ids are unique', () => {
    const ids = PROBES.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate probe id');
  });

  await t.test('metric ids are unique within a probe', () => {
    for (const p of PROBES) {
      const ids = p.metrics.map((m) => m.id);
      assert.equal(new Set(ids).size, ids.length, `${p.id}: duplicate metric id`);
    }
  });

  await t.test('every metric declares a known kind and direction', () => {
    const kinds = new Set(Object.values(METRIC_KIND));
    const directions = new Set(Object.values(DIRECTION));
    for (const p of PROBES) {
      for (const m of p.metrics) {
        assert.ok(kinds.has(m.kind), `${p.id}::${m.id}: unknown kind ${m.kind}`);
        assert.ok(directions.has(m.direction),
          `${p.id}::${m.id}: unknown direction ${m.direction}`);
        assert.ok(m.label, `${p.id}::${m.id}: needs a human-readable label`);
        assert.equal(typeof m.extract, 'function', `${p.id}::${m.id}: needs an extractor`);
      }
    }
  });

  await t.test('probes are deterministic: temperature 0 everywhere', () => {
    // A probe that samples is a probe that manufactures its own drift.
    for (const p of PROBES) {
      assert.equal(p.request.temperature, 0,
        `${p.id}: probes must run at temperature 0`);
    }
  });

  await t.test('probes contain no customer data placeholders', () => {
    // The cross-tenant privacy guarantee depends on probe text being ours and
    // fully public. Any templating hole would be a way for tenant data to leak
    // into a pooled comparison.
    for (const p of PROBES) {
      const text = JSON.stringify(p.request);
      assert.ok(!/\{\{|\$\{|<%/.test(text),
        `${p.id}: probe text must be literal, found a template placeholder`);
    }
  });

  await t.test('allMetricKeys enumerates the full battery', () => {
    const keys = allMetricKeys();
    const expected = PROBES.reduce((n, p) => n + p.metrics.length, 0);
    assert.equal(keys.length, expected);
    assert.equal(new Set(keys.map((k) => k.key)).size, expected, 'keys must be unique');
    // The battery must be big enough that multiplicity control is genuinely
    // needed -- this is the premise of the BH stage in the pipeline.
    assert.ok(expected >= 20,
      `battery has only ${expected} comparisons; expected 20+`);
  });

  await t.test('getProbe finds by id and returns null otherwise', () => {
    assert.equal(getProbe('json.strict.flat')?.id, 'json.strict.flat');
    assert.equal(getProbe('nope.not.here'), null);
  });
});

test('probes are frozen against accidental mutation', async (t) => {
  await t.test('the suite object is deeply immutable', () => {
    assert.throws(() => { PROBES.push({}); }, 'suite array must be frozen');
    assert.throws(() => { PROBES[0].request.user = 'tampered'; },
      'probe request must be frozen');
    assert.throws(() => { PROBES[0].metrics[0].id = 'tampered'; },
      'metric definition must be frozen');
  });

  await t.test('fingerprints are stable and distinct per probe', () => {
    // Same input, same fingerprint -- twice in a row, and irrespective of the
    // key order the object literal happened to use.
    for (const p of PROBES) {
      assert.equal(probeFingerprint(p), probeFingerprint(p), `${p.id}: unstable`);
    }
    const prints = PROBES.map(probeFingerprint);
    assert.equal(new Set(prints).size, PROBES.length,
      'distinct probes must fingerprint differently');
    for (const fp of prints) {
      assert.match(fp, /^[0-9a-f]{16}$/, 'fingerprint should be 16 hex chars');
    }
  });

  await t.test('a changed request produces a changed fingerprint', () => {
    const probe = getProbe('format.exact.answer');
    const before = probeFingerprint(probe);
    const tampered = {
      ...probe,
      request: { ...probe.request, user: `${probe.request.user} ` },
    };
    assert.notEqual(probeFingerprint(tampered), before,
      'even a trailing space must break comparability');
  });

  await t.test('the suite version is pinned', () => {
    assert.match(SUITE_VERSION, /^\d+\.\d+\.\d+$/);
  });
});

/* ------------------------------------------------------------------ *
 * Extractor behaviour
 * ------------------------------------------------------------------ */

test('stripFences unwraps code fences without damaging plain text', () => {
  assert.equal(stripFences('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripFences('```\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripFences('  ```JSON\n{"a":1}\n```  '), '{"a":1}');
  assert.equal(stripFences('{"a":1}'), '{"a":1}');
  assert.equal(stripFences('no fences here'), 'no fences here');
  // A fence in the middle is not a wrapper and must be left alone.
  assert.equal(stripFences('before ```x``` after'), 'before ```x``` after');
  assert.equal(stripFences(null), '');
  assert.equal(stripFences(undefined), '');
});

test('JSON strictness is measured the way an integration would experience it', async (t) => {
  await t.test('strict parse accepts only genuinely bare JSON', () => {
    assert.equal(parsesAsStrictJson('{"a":1}'), true);
    assert.equal(parsesAsStrictJson('[1,2,3]'), true);
    assert.equal(parsesAsStrictJson('```json\n{"a":1}\n```'), false);
    assert.equal(parsesAsStrictJson('Here you go: {"a":1}'), false);
    assert.equal(parsesAsStrictJson(''), false);
    assert.equal(parsesAsStrictJson('   '), false);
    assert.equal(parsesAsStrictJson(null), false);
  });

  await t.test('fence-wrapping is detected as a distinct failure mode', () => {
    // This distinction is the entire point: a model that starts emitting
    // ```json breaks every bare JSON.parse while still "returning JSON".
    assert.equal(parsesAfterRepair('```json\n{"a":1}\n```'), true);
    assert.equal(parsesAfterRepair('{"a":1}'), false, 'already strict, not a repair');
    assert.equal(parsesAfterRepair('total garbage'), false, 'unrepairable');
  });
});

test('shapeOf describes structure and never leaks values', () => {
  assert.equal(shapeOf({ b: 1, a: 'x' }), '{a:string,b:number}');
  assert.equal(shapeOf([{ a: 1 }]), 'array<{a:number}>');
  assert.equal(shapeOf([]), 'array<empty>');
  assert.equal(shapeOf(null), 'null');
  assert.equal(shapeOf(true), 'boolean');
  // Key order must not change the shape, or comparisons would be meaningless.
  assert.equal(shapeOf({ a: 1, b: 2 }), shapeOf({ b: 2, a: 1 }));
  // The privacy-relevant property: no value survives into the description.
  const secret = { email: 'user@example.com', balance: 12345 };
  const shape = shapeOf(secret);
  assert.ok(!shape.includes('user@example.com'), 'shape must not contain values');
  assert.ok(!shape.includes('12345'), 'shape must not contain values');
});

test('requiredKeyCoverage scores schema adherence', () => {
  const req = ['city', 'population', 'country'];
  assert.equal(requiredKeyCoverage({ city: 'x', population: 1, country: 'y' }, req), 1);
  assert.equal(requiredKeyCoverage({ city: 'x' }, req), 1 / 3);
  assert.equal(requiredKeyCoverage({}, req), 0);
  assert.equal(requiredKeyCoverage(null, req), 0);
  assert.equal(requiredKeyCoverage([1, 2], req), 0, 'array is not a keyed object');
  assert.equal(requiredKeyCoverage({ a: 1 }, []), 1, 'no requirements means satisfied');
  // Keys present but null still count as present: the schema shape is intact.
  assert.equal(requiredKeyCoverage({ city: null, population: null, country: null }, req), 1);
});

test('refusal detection is sensitive at the start and quiet elsewhere', () => {
  assert.equal(looksLikeRefusal("I can't help with that."), true);
  assert.equal(looksLikeRefusal('I cannot provide medical advice.'), true);
  assert.equal(looksLikeRefusal('I am unable to assist with this request.'), true);
  assert.equal(looksLikeRefusal('The standard dose is 200-400mg every 4-6 hours.'), false);
  // A refusal phrase deep in a long, genuinely helpful answer is discussion,
  // not a refusal. Counting it would inflate the refusal rate on every
  // long-form answer and drown the real signal.
  const longHelpful = `${'The recommended dose is 200mg. '.repeat(40)}I cannot advise on overdose.`;
  assert.equal(looksLikeRefusal(longHelpful), false);
  assert.equal(looksLikeRefusal(''), false);
  assert.equal(looksLikeRefusal(null), false);
});

test('hedgeCount tracks safety-tuning verbosity', () => {
  assert.equal(hedgeCount('The answer is 42.'), 0);
  assert.ok(hedgeCount('It depends. Generally, you should consult a professional.') >= 3);
  assert.equal(hedgeCount(null), 0);
});

test('preambleLength measures chattiness before the answer', () => {
  assert.equal(preambleLength('JP', 'JP'), 0);
  assert.equal(preambleLength('The code is JP', 'JP'), 12);
  assert.equal(preambleLength('Sure! jp', 'JP'), 6, 'match should be case-insensitive');
  assert.equal(preambleLength('no answer present', 'JP'), null);
  assert.equal(preambleLength(null, 'JP'), null);
  assert.equal(preambleLength('JP', null), null);
});

test('wordCount is robust to whitespace', () => {
  assert.equal(wordCount('one two three'), 3);
  assert.equal(wordCount('  padded   words  '), 2);
  assert.equal(wordCount('line\nbreaks\tand\ttabs'), 4);
  assert.equal(wordCount(''), 0);
  assert.equal(wordCount('   '), 0);
  assert.equal(wordCount(null), 0);
});

test('firstToolCall normalises across provider conventions', () => {
  // Arguments as an object (Anthropic-style).
  assert.deepEqual(
    firstToolCall({ toolCalls: [{ name: 'f', arguments: { a: 1 } }] }),
    { name: 'f', args: { a: 1 }, argsUnparseable: false },
  );
  // Arguments as a JSON string (OpenAI-style).
  assert.deepEqual(
    firstToolCall({ toolCalls: [{ name: 'f', arguments: '{"a":1}' }] }),
    { name: 'f', args: { a: 1 }, argsUnparseable: false },
  );
  // Malformed argument JSON is a real, observed failure mode and must be
  // reported rather than thrown.
  assert.deepEqual(
    firstToolCall({ toolCalls: [{ name: 'f', arguments: '{"a":' }] }),
    { name: 'f', args: null, argsUnparseable: true },
  );
  assert.equal(firstToolCall({ toolCalls: [] }), null);
  assert.equal(firstToolCall({}), null);
  assert.equal(firstToolCall(null), null);
});

/* ------------------------------------------------------------------ *
 * Extraction over whole responses
 * ------------------------------------------------------------------ */

/** Minimal well-behaved response for a given probe. */
function goodResponse(probeId) {
  switch (probeId) {
    case 'json.strict.flat':
      return { text: '{"city":"Tokyo","population":13960000,"country":"Japan"}' };
    case 'json.nested.types':
      return {
        text: '{"items":[{"sku":"A1","qty":2,"inStock":true},'
          + '{"sku":"B2","qty":1,"inStock":false}],"total":3}',
      };
    case 'tool.args.shape':
      return {
        text: '',
        toolCalls: [{ name: 'get_weather', arguments: '{"location":"Osaka","unit":"celsius"}' }],
      };
    case 'format.exact.answer':
      return { text: 'JP' };
    case 'instruction.conflict':
      return { text: 'Ocean is vast' };
    case 'refusal.benign.medical':
      return { text: 'The standard adult dose is 200 to 400 mg every four to six hours.' };
    case 'determinism.temp0':
      return { text: '2, 3, 5, 7, 11, 13, 17, 19' };
    case 'latency.baseline':
      return { text: 'Water evaporates. Then it rains.', latencyMs: 812 };
    default:
      return { text: '' };
  }
}

test('healthy responses score as compliant', () => {
  for (const probe of PROBES) {
    const metrics = extractMetrics(probe, [goodResponse(probe.id)]);
    for (const m of probe.metrics) {
      const values = metrics[m.id];
      assert.ok(Array.isArray(values), `${probe.id}::${m.id}: missing series`);
      for (const v of values) {
        assert.ok(Number.isFinite(v), `${probe.id}::${m.id}: non-finite value ${v}`);
      }
    }
  }

  // Spot-check the semantics rather than just the plumbing.
  const flat = extractMetrics(getProbe('json.strict.flat'), [goodResponse('json.strict.flat')]);
  assert.deepEqual(flat.json_parses_strict, [1]);
  assert.deepEqual(flat.json_needs_fence_strip, [0]);
  assert.deepEqual(flat.schema_key_coverage, [1]);
  assert.deepEqual(flat.extra_key_count, [0]);

  const exact = extractMetrics(getProbe('format.exact.answer'), [goodResponse('format.exact.answer')]);
  assert.deepEqual(exact.exact_match, [1]);
  assert.deepEqual(exact.preamble_chars, [0]);

  const tool = extractMetrics(getProbe('tool.args.shape'), [goodResponse('tool.args.shape')]);
  assert.deepEqual(tool.tool_called, [1]);
  assert.deepEqual(tool.tool_name_correct, [1]);
  assert.deepEqual(tool.tool_args_parse, [1]);
  assert.deepEqual(tool.tool_args_flat, [1]);
});

test('extractors survive every hostile response a provider can return', () => {
  // This is not paranoia: truncation, empty bodies, and error objects all
  // happen in production. One of them crashing the extractor would abort the
  // collection cycle and blind us exactly when something is going wrong.
  const hostile = [
    {},
    { text: null },
    { text: undefined },
    { text: '' },
    { text: '   ' },
    { text: 'not json at all' },
    { text: '{"truncated": ' },
    { text: '```json\n{"a":1}\n```' },
    { text: '[]' },
    { text: 'null' },
    { text: '{"items":[]}' },
    { text: '{"items":[{}]}' },
    { text: '{"items":"not-an-array"}' },
    { text: '\u0000\u0001binary' },
    { text: 'x'.repeat(100000) },
    { text: '{}', toolCalls: 'not-an-array' },
    { text: '', toolCalls: [{}] },
    { text: '', toolCalls: [{ name: null, arguments: null }] },
    { text: '', toolCalls: [{ name: 'get_weather', arguments: '{"broken":' }] },
    { text: '', toolCalls: [{ name: 'get_weather', arguments: { location: 42 } }] },
    { text: 'ok', latencyMs: NaN },
    { text: 'ok', latencyMs: Infinity },
    { text: 'ok', latencyMs: -1 },
  ];

  for (const probe of PROBES) {
    const metrics = extractMetrics(probe, hostile);
    for (const m of probe.metrics) {
      const values = metrics[m.id];
      assert.ok(Array.isArray(values), `${probe.id}::${m.id}: must return an array`);
      for (const v of values) {
        assert.ok(
          Number.isFinite(v),
          `${probe.id}::${m.id}: emitted non-finite ${v} for a hostile response`,
        );
      }
    }
  }
});

test('an extractor that throws is contained, not propagated', () => {
  // Guarding this explicitly because a single bad extractor must degrade to
  // missing data for that metric, never abort the cycle for every other probe.
  const exploding = {
    id: 'test.exploding',
    title: 'Exploding',
    rationale: 'x'.repeat(50),
    request: { user: 'hi', temperature: 0 },
    metrics: [
      {
        id: 'boom',
        kind: METRIC_KIND.BINARY,
        direction: DIRECTION.NEUTRAL,
        label: 'boom',
        extract: () => { throw new Error('extractor bug'); },
      },
      {
        id: 'fine',
        kind: METRIC_KIND.COUNT,
        direction: DIRECTION.NEUTRAL,
        label: 'fine',
        extract: (r) => wordCount(r.text),
      },
    ],
  };

  const out = extractMetrics(exploding, [{ text: 'one two' }, { text: 'three' }]);
  assert.deepEqual(out.boom, [], 'throwing extractor yields no data');
  assert.deepEqual(out.fine, [2, 1], 'sibling metric is unaffected');
});

test('null-returning extractors drop samples rather than coercing to zero', () => {
  // Coercing missing data to 0 would fabricate a distribution shift the moment
  // a metric stops applying -- a false drift event created entirely by us.
  const probe = getProbe('format.exact.answer');
  const responses = [
    { text: 'JP' },              // preamble 0
    { text: 'The code is JP' },  // preamble 12
    { text: 'I do not know' },   // preamble null -> dropped
  ];
  const out = extractMetrics(probe, responses);
  assert.deepEqual(out.preamble_chars, [0, 12], 'the null sample is dropped, not zeroed');
  assert.equal(out.word_count.length, 3, 'word_count applies to all three');
});

test('extraction over an empty response set yields empty series', () => {
  for (const probe of PROBES) {
    const out = extractMetrics(probe, []);
    for (const m of probe.metrics) {
      assert.deepEqual(out[m.id], [], `${probe.id}::${m.id}`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * The failure modes the suite exists to catch
 * ------------------------------------------------------------------ */

test('the suite detects each production breakage it claims to catch', async (t) => {
  await t.test('fence-wrapping regression', () => {
    const probe = getProbe('json.strict.flat');
    const before = extractMetrics(probe, Array.from({ length: 30 },
      () => ({ text: '{"city":"Tokyo","population":13960000,"country":"Japan"}' })));
    const after = extractMetrics(probe, Array.from({ length: 30 },
      () => ({ text: '```json\n{"city":"Tokyo","population":13960000,"country":"Japan"}\n```' })));

    assert.deepEqual([...new Set(before.json_parses_strict)], [1]);
    assert.deepEqual([...new Set(after.json_parses_strict)], [0],
      'fence-wrapped output must register as a strict-parse failure');
    assert.deepEqual([...new Set(after.json_needs_fence_strip)], [1]);
    // Schema coverage stays perfect -- proving we can distinguish "wrapped"
    // from "wrong", which is what makes the alert actionable.
    assert.deepEqual([...new Set(after.schema_key_coverage)], [1]);
  });

  await t.test('numeric type coercion regression', () => {
    const probe = getProbe('json.nested.types');
    const after = extractMetrics(probe, [{
      text: '{"items":[{"sku":"A1","qty":"2","inStock":"true"}],"total":"3"}',
    }]);
    assert.deepEqual(after.json_parses_strict, [1], 'still valid JSON');
    assert.deepEqual(after.qty_is_number, [0], 'but the number became a string');
    assert.deepEqual(after.instock_is_boolean, [0], 'and the boolean became a string');
  });

  await t.test('tool argument nesting regression', () => {
    const probe = getProbe('tool.args.shape');
    const after = extractMetrics(probe, [{
      text: '',
      toolCalls: [{ name: 'get_weather', arguments: '{"input":{"location":"Osaka"}}' }],
    }]);
    assert.deepEqual(after.tool_called, [1]);
    assert.deepEqual(after.tool_args_parse, [1], 'arguments still parse');
    assert.deepEqual(after.tool_args_flat, [0], 'but the declared shape is gone');
  });

  await t.test('chattiness regression', () => {
    const probe = getProbe('format.exact.answer');
    const after = extractMetrics(probe, [
      { text: 'The ISO 3166-1 alpha-2 country code for Japan is JP.' },
    ]);
    assert.deepEqual(after.exact_match, [0]);
    assert.ok(after.preamble_chars[0] > 40, 'preamble is measured, not just flagged');
  });

  await t.test('instruction-precedence regression', () => {
    const probe = getProbe('instruction.conflict');
    const compliant = extractMetrics(probe, [{ text: 'Ocean is vast' }]);
    const overridden = extractMetrics(probe, [{
      text: 'The ocean covers more than seventy percent of the planet surface and '
        + 'plays a central role in regulating the global climate system.',
    }]);
    assert.deepEqual(compliant.system_wins, [1]);
    assert.deepEqual(overridden.system_wins, [0],
      'user instruction overriding the system prompt must be visible');
  });

  await t.test('refusal regression on a benign question', () => {
    const probe = getProbe('refusal.benign.medical');
    const helpful = extractMetrics(probe, [
      { text: 'The standard adult dose is 200 to 400 mg every four to six hours.' },
    ]);
    const refusing = extractMetrics(probe, [
      { text: "I can't provide medical dosing advice. Please consult a professional." },
    ]);
    assert.deepEqual(helpful.refused, [0]);
    assert.deepEqual(refusing.refused, [1]);
  });
});
