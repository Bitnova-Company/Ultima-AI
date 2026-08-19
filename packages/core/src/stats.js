/**
 * Ultima AI — statistical primitives.
 *
 * Everything here is implemented from scratch (zero dependencies) and is
 * exercised by packages/core/test/stats.test.js against values computed
 * independently with scipy.
 *
 * Design rule: we never alert on a p-value alone. Every detector pairs a
 * significance test with a non-parametric effect size, and the pipeline
 * applies a multiplicity correction across the whole probe battery. A
 * statistically significant 0.4% shift is noise with a big sample, not news.
 */

// ---------------------------------------------------------------------------
// Special functions
// ---------------------------------------------------------------------------

const LANCZOS_G = 7;
const LANCZOS_C = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** Natural log of the gamma function (Lanczos approximation). */
export function logGamma(z) {
  if (z < 0.5) {
    // Reflection formula: Γ(z)Γ(1-z) = π / sin(πz)
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  z -= 1;
  let x = LANCZOS_C[0];
  for (let i = 1; i < LANCZOS_G + 2; i++) x += LANCZOS_C[i] / (z + i);
  const t = z + LANCZOS_G + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * Regularised incomplete beta function I_x(a,b), via the continued fraction
 * expansion (Lentz's algorithm). This is the workhorse behind the t-distribution.
 */
export function incompleteBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  const lbeta = logGamma(a + b) - logGamma(a) - logGamma(b);
  const front = Math.exp(lbeta + a * Math.log(x) + b * Math.log(1 - x));

  // The continued fraction converges rapidly only for x < (a+1)/(a+b+2);
  // otherwise use the symmetry I_x(a,b) = 1 - I_{1-x}(b,a).
  //
  // The inequality MUST be strict. The two swap thresholds sum to exactly 1,
  // so a strict test guarantees the swapped call never swaps back, whereas
  // `>=` recurses forever whenever x sits exactly on the boundary — which
  // happens for the perfectly ordinary case I_0.5(1,1).
  if (x > (a + 1) / (a + b + 2)) return 1 - incompleteBeta(1 - x, b, a);

  const TINY = 1e-30;
  let f = 1, c = 1, d = 0;

  for (let i = 0; i <= 300; i++) {
    const m = Math.floor(i / 2);
    let numerator;
    if (i === 0) numerator = 1;
    else if (i % 2 === 0) numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    else numerator = -(((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1)));

    d = 1 + numerator * d;
    if (Math.abs(d) < TINY) d = TINY;
    d = 1 / d;

    c = 1 + numerator / c;
    if (Math.abs(c) < TINY) c = TINY;

    const cd = c * d;
    f *= cd;
    if (Math.abs(1 - cd) < 1e-12) break;
  }
  return (front * (f - 1)) / a;
}

/**
 * Standard normal CDF, accurate to near machine precision across the whole
 * range. Expressed via erfc rather than erf so that deep-tail probabilities --
 * which is where a strong drift signal lands -- do not lose all their
 * significant digits to floating-point cancellation.
 */
export function normalCdf(z) {
  return 0.5 * erfc(-z / Math.SQRT2);
}

/**
 * Two-sided 95% normal quantile, to full double precision.
 * (1.96 is a rounding of this and is not accurate enough for interval endpoints.)
 */
export const Z_95 = 1.959963984540054;

/** Error function — max abs error ~1.5e-7. */
export function erf(x) {
  if (x === 0) return 0; // exact, and keeps normalCdf(0) exactly 0.5
  if (!Number.isFinite(x)) return x > 0 ? 1 : -1;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  // erf(x) = P(1/2, x²) for x >= 0.
  return sign * (ax < 2 ? lowerGammaP(0.5, ax * ax) : 1 - upperGammaQ(0.5, ax * ax));
}

/**
 * Complementary error function, 1 - erf(x), computed without cancellation.
 * Needed because normalCdf in the far tail would otherwise evaluate
 * 1 - 0.999999... and throw away every significant digit.
 */
export function erfc(x) {
  if (!Number.isFinite(x)) return x > 0 ? 0 : 2;
  if (x < 0) return 2 - erfc(-x);
  return x < 2 ? 1 - lowerGammaP(0.5, x * x) : upperGammaQ(0.5, x * x);
}

/**
 * Regularised lower incomplete gamma P(a,x) by series expansion.
 * Converges quickly for x < a+1.
 */
function lowerGammaP(a, x) {
  if (x <= 0) return 0;
  let ap = a;
  let sum = 1 / a;
  let del = sum;
  for (let n = 0; n < 1000; n++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * 1e-16) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

/**
 * Regularised upper incomplete gamma Q(a,x) by continued fraction (Lentz).
 * Converges quickly for x > a+1, which is the regime erfc cares about.
 */
function upperGammaQ(a, x) {
  const TINY = 1e-300;
  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/** Two-sided p-value for Student's t with `df` degrees of freedom. */
export function tDistTwoSided(t, df) {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return 1;
  const x = df / (df + t * t);
  return clampP(incompleteBeta(x, df / 2, 0.5));
}

const clampP = (p) => Math.min(1, Math.max(0, p));

// ---------------------------------------------------------------------------
// Descriptive statistics
// ---------------------------------------------------------------------------

export function mean(xs) {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample variance (Bessel-corrected, n-1). */
export function variance(xs) {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return s / (n - 1);
}

export const stdev = (xs) => Math.sqrt(variance(xs));

/** Linear-interpolation quantile (matches numpy's default 'linear' method). */
export function quantile(xs, q) {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] + (pos - lo) * (s[hi] - s[lo]);
}

export const median = (xs) => quantile(xs, 0.5);

// ---------------------------------------------------------------------------
// Effect sizes
// ---------------------------------------------------------------------------

/**
 * Cliff's delta — non-parametric effect size in [-1, 1].
 *
 * Preferred over Cohen's d throughout Ultima because LLM probe metrics are
 * frequently bounded, bimodal, or near-degenerate (a JSON-validity metric is
 * mostly 1.0 with occasional 0.0). Cohen's d is meaningless on those; Cliff's
 * delta is well-defined. Interpretation: |d|<0.147 negligible, <0.33 small,
 * <0.474 medium, else large.
 */
export function cliffsDelta(a, b) {
  if (a.length === 0 || b.length === 0) return 0;
  // O(n log n): sort b, then count via binary search rather than a double loop.
  const sb = [...b].sort((x, y) => x - y);
  let dominance = 0;
  for (const x of a) {
    const lt = lowerBound(sb, x);      // count of b strictly < x
    const le = upperBound(sb, x);      // count of b <= x
    const gt = sb.length - le;         // count of b strictly > x
    dominance += lt - gt;
  }
  return dominance / (a.length * b.length);
}

function lowerBound(sorted, target) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(sorted, target) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Cohen's d with pooled standard deviation. */
export function cohensD(a, b) {
  const na = a.length, nb = b.length;
  if (na < 2 || nb < 2) return 0;
  const va = variance(a), vb = variance(b);
  const pooled = Math.sqrt(((na - 1) * va + (nb - 1) * vb) / (na + nb - 2));
  if (pooled === 0) return 0;
  return (mean(a) - mean(b)) / pooled;
}

// ---------------------------------------------------------------------------
// Significance tests
// ---------------------------------------------------------------------------

/** Welch's unequal-variance t-test. Returns {t, df, p}. */
export function welchTTest(a, b) {
  const na = a.length, nb = b.length;
  if (na < 2 || nb < 2) return { t: 0, df: 0, p: 1 };
  const va = variance(a) / na;
  const vb = variance(b) / nb;
  const denom = va + vb;
  if (denom === 0) return { t: 0, df: 0, p: 1 };
  const t = (mean(a) - mean(b)) / Math.sqrt(denom);
  // Welch–Satterthwaite degrees of freedom
  const df = denom ** 2 / (va ** 2 / (na - 1) + vb ** 2 / (nb - 1));
  return { t, df, p: tDistTwoSided(t, df) };
}

/**
 * Mann-Whitney U (two-sided) with normal approximation, continuity correction
 * and a tie correction on the variance. Robust to the non-normal, heavily-tied
 * distributions typical of probe metrics.
 */
export function mannWhitneyU(a, b) {
  const na = a.length, nb = b.length;
  if (na === 0 || nb === 0) return { u: 0, z: 0, p: 1 };

  const combined = [
    ...a.map((v) => ({ v, g: 0 })),
    ...b.map((v) => ({ v, g: 1 })),
  ].sort((x, y) => x.v - y.v);

  // Midrank assignment for ties, accumulating the tie-correction term.
  const ranks = new Array(combined.length);
  let tieTerm = 0;
  let i = 0;
  while (i < combined.length) {
    let j = i;
    while (j + 1 < combined.length && combined[j + 1].v === combined[i].v) j++;
    const avgRank = (i + j + 2) / 2; // ranks are 1-based
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    const t = j - i + 1;
    if (t > 1) tieTerm += t ** 3 - t;
    i = j + 1;
  }

  let rankSumA = 0;
  for (let k = 0; k < combined.length; k++) if (combined[k].g === 0) rankSumA += ranks[k];

  const uA = rankSumA - (na * (na + 1)) / 2;
  const uB = na * nb - uA;
  const u = Math.min(uA, uB);

  const n = na + nb;
  const muU = (na * nb) / 2;
  const sigmaU = Math.sqrt(
    ((na * nb) / 12) * (n + 1 - tieTerm / (n * (n - 1)))
  );
  if (sigmaU === 0) return { u, z: 0, p: 1 };

  const z = (u - muU + 0.5) / sigmaU; // continuity correction toward the mean
  const p = clampP(2 * normalCdf(-Math.abs(z)));
  return { u, z, p };
}

/**
 * Two-sample Kolmogorov-Smirnov test (asymptotic). Sensitive to changes in
 * distribution *shape*, not just central tendency — which is how we catch a
 * provider that keeps the mean output length but fattens the tail.
 */
export function ksTest(a, b) {
  const na = a.length, nb = b.length;
  if (na === 0 || nb === 0) return { d: 0, p: 1 };

  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);

  let i = 0, j = 0, d = 0;
  while (i < na && j < nb) {
    const va = sa[i], vb = sb[j];
    if (va <= vb) i++;
    if (vb <= va) j++;
    d = Math.max(d, Math.abs(i / na - j / nb));
  }

  // Effective sample size for the two-sample case.
  const ne = (na * nb) / (na + nb);

  // Use the EXACT one-sample kstwo distribution at n = round(ne), which is what
  // scipy.stats.ks_2samp does. This matters: the asymptotic Kolmogorov limit is
  // noticeably conservative at the sample sizes a probe cycle actually produces
  // (e.g. n=8 vs n=9 gives exact p=0.0078 where asymptotic says p=0.0171). Being
  // conservative here means missing real drift, so we pay for the exact form.
  // Round half to even, matching Python's round() and therefore scipy exactly.
  // With equal group sizes ne is frequently a clean .5 (n=45 vs 45 -> 22.5), so
  // the tie rule is hit often enough to matter.
  const nEff = roundHalfEven(ne);

  // The exact method builds a (2k-1)² matrix and raises it to the n-th power,
  // so its cost grows with n*d. We spend that cost only where it can change a
  // decision. The asymptotic limit is always slightly conservative (it
  // overstates p), and its absolute error is ~1e-2 near p=0.05 even at n=500 --
  // enough to flip an alert -- so we do NOT lean on it in the interesting range.
  // But once the asymptotic p is already below KS_ASYMPTOTIC_FLOOR, no
  // threshold or BH ranking we apply downstream can care about the difference,
  // and that is exactly the large-d regime where the matrix is biggest.
  const asymptotic = kolmogorovQ(Math.sqrt(ne) * d);
  const mSize = 2 * Math.ceil(nEff * d) - 1;

  const useExact = nEff >= 1
    && nEff <= KS_EXACT_MAX_N
    && mSize <= KS_EXACT_MAX_M
    && asymptotic >= KS_ASYMPTOTIC_FLOOR;

  return { d, p: clampP(useExact ? ksTwoSf(d, nEff) : asymptotic) };
}

/** Beyond these the exact matrix power stops being worth its cost. */
const KS_EXACT_MAX_N = 2000;
const KS_EXACT_MAX_M = 401;

/**
 * If even the conservative asymptotic p is this small, the result is
 * "overwhelmingly significant" under any threshold we use, and refining it
 * cannot change an alerting decision.
 */
const KS_ASYMPTOTIC_FLOOR = 1e-4;

/** Round half to even ("banker's rounding"), as in IEEE 754 and Python's round(). */
function roundHalfEven(x) {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * Exact survival function of the one-sample KS statistic, P(D_n >= d), via the
 * Marsaglia–Tsang–Wang (2003) matrix method: P(D_n < d) = n!/n^n * (H^n)_{kk}.
 * Scaling by 2^-256 per multiply keeps the entries from overflowing.
 */
function ksTwoSf(d, n) {
  if (d <= 0) return 1;
  if (d >= 1) return 0;

  const nd = n * d;
  const k = Math.ceil(nd);
  const h = k - nd;
  const m = 2 * k - 1;

  // Build H.
  const H = Array.from({ length: m }, () => new Float64Array(m));
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) {
      if (i - j + 1 >= 0) H[i][j] = 1;
    }
  }
  for (let i = 0; i < m; i++) {
    H[i][0] -= h ** (i + 1);
    H[m - 1][i] -= h ** (m - i);
  }
  H[m - 1][0] += 2 * h - 1 > 0 ? (2 * h - 1) ** m : 0;
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) {
      if (i - j + 1 > 0) {
        for (let g = 1; g <= i - j + 1; g++) H[i][j] /= g;
      }
    }
  }

  let eQ = 0;
  const { matrix: Q, exponent } = matrixPower(H, m, n);
  eQ = exponent;

  let s = Q[k - 1][k - 1];
  for (let i = 1; i <= n; i++) {
    s = (s * i) / n;
    if (s < 1e-140) { s *= 1e140; eQ -= 140; }
  }
  s *= 10 ** eQ;

  return clampP(1 - s);
}

/** Repeated-squaring power of an m×m matrix with base-10 exponent tracking. */
function matrixPower(A, m, p) {
  if (p === 1) return { matrix: A.map((r) => Float64Array.from(r)), exponent: 0 };

  const half = matrixPower(A, m, Math.floor(p / 2));
  let exponent = 2 * half.exponent;
  let V = matMul(half.matrix, half.matrix, m);

  if (p % 2 === 1) V = matMul(V, A, m);

  if (V[Math.floor(m / 2)][Math.floor(m / 2)] > 1e140) {
    for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) V[i][j] *= 1e-140;
    exponent += 140;
  }
  return { matrix: V, exponent };
}

function matMul(A, B, m) {
  const C = Array.from({ length: m }, () => new Float64Array(m));
  for (let i = 0; i < m; i++) {
    for (let g = 0; g < m; g++) {
      const a = A[i][g];
      if (a === 0) continue;
      for (let j = 0; j < m; j++) C[i][j] += a * B[g][j];
    }
  }
  return C;
}

/** Q_KS(λ) = 2 Σ (-1)^{k-1} e^{-2k²λ²} — the asymptotic KS survival function. */
function kolmogorovQ(lambda) {
  if (lambda <= 0) return 1;
  let sum = 0;
  for (let k = 1; k <= 100; k++) {
    const term = 2 * (-1) ** (k - 1) * Math.exp(-2 * k * k * lambda * lambda);
    sum += term;
    if (Math.abs(term) < 1e-12) break;
  }
  return Math.min(1, Math.max(0, sum));
}

/** Levene's test (Brown-Forsythe variant, median-centred) for scale change. */
export function leveneTest(a, b) {
  const na = a.length, nb = b.length;
  if (na < 2 || nb < 2) return { w: 0, p: 1 };
  const za = a.map((x) => Math.abs(x - median(a)));
  const zb = b.map((x) => Math.abs(x - median(b)));
  const n = na + nb;
  const zaBar = mean(za), zbBar = mean(zb);
  const zBar = (zaBar * na + zbBar * nb) / n;

  const numer = (n - 2) * (na * (zaBar - zBar) ** 2 + nb * (zbBar - zBar) ** 2);
  let denom = 0;
  for (const z of za) denom += (z - zaBar) ** 2;
  for (const z of zb) denom += (z - zbBar) ** 2;
  if (denom === 0) return { w: 0, p: 1 };

  const w = numer / denom;
  // F(1, n-2) two-sided tail == t-test tail with t = sqrt(W)
  return { w, p: tDistTwoSided(Math.sqrt(w), n - 2) };
}

// ---------------------------------------------------------------------------
// Multiplicity control
// ---------------------------------------------------------------------------

/**
 * Benjamini-Hochberg FDR correction.
 *
 * We run dozens of probes × metrics per cycle. Without this, at α=0.05 we would
 * manufacture roughly one "drift event" per twenty comparisons purely by
 * chance, which is the fastest way to train users to ignore our alerts.
 *
 * Returns adjusted p-values in the caller's original ordering, with the
 * standard monotonicity enforcement (step-up cumulative minimum).
 */
export function benjaminiHochberg(pValues) {
  const m = pValues.length;
  if (m === 0) return [];
  const indexed = pValues.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p);
  const adjusted = new Array(m);
  let runningMin = 1;
  for (let k = m - 1; k >= 0; k--) {
    const rank = k + 1;
    const value = Math.min(1, (indexed[k].p * m) / rank);
    runningMin = Math.min(runningMin, value);
    adjusted[indexed[k].i] = runningMin;
  }
  return adjusted;
}

/**
 * Wilson score interval for a binomial proportion. Used for reporting measured
 * false-alarm rates honestly — a naive Wald interval is badly wrong at the low
 * rates we care about (e.g. 0/500).
 */
export function wilsonInterval(successes, trials, z = Z_95) {
  if (trials === 0) return { lower: 0, upper: 1, point: 0 };
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const centre = p + z2 / (2 * trials);
  const spread = z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  return {
    point: p,
    lower: Math.max(0, (centre - spread) / denom),
    upper: Math.min(1, (centre + spread) / denom),
  };
}

/**
 * Exact one-sided binomial tail: P(X >= successes) for X ~ Binomial(trials, p0).
 *
 * This is the test that makes cross-tenant corroboration mean anything. The
 * naive rule "alert when at least K tenants agree" gets WORSE as the network
 * grows: if each tenant independently throws a chance flag at rate p0, the
 * expected number of chance flags is p0 * trials, so a fixed K is eventually
 * cleared by noise alone on every cycle. The right question is not "how many
 * tenants agree" but "do more tenants agree than chance would produce at this
 * fleet size", which is exactly this tail probability.
 *
 * Computed via the regularised incomplete beta identity
 *   P(X >= k) = I_{p0}(k, n - k + 1)
 * rather than by summing terms, so it stays exact deep in the tail where a
 * naive summation of binomial pmf terms underflows to zero.
 */
export function binomialTailP(successes, trials, p0) {
  if (trials <= 0) return 1;
  if (successes <= 0) return 1;
  if (successes > trials) return 0;
  if (p0 <= 0) return 0;
  if (p0 >= 1) return 1;
  return incompleteBeta(p0, successes, trials - successes + 1);
}

/** Deterministic seeded PRNG (mulberry32) — reproducible simulations & tests. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller normal sample from a uniform generator. */
export function gaussian(rng, mu = 0, sigma = 1) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
