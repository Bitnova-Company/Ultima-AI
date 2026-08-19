#!/usr/bin/env python3
"""
Regenerate packages/core/test/fixtures/scipy-reference.json.

Ultima's alerting decisions rest entirely on packages/core/src/stats.js, which
is written from scratch with zero dependencies. To make sure "from scratch"
never means "subtly wrong", every function in it is pinned against SciPy --
the reference implementation the statistics literature is written against.

This script is the provenance of that fixture. It is NOT run by `npm test`
(the test suite is dependency-free and reads the committed JSON), but it must
be re-runnable so a reviewer can independently confirm the numbers.

    pip install scipy numpy statsmodels
    python3 scripts/gen-stats-reference.py

Any change to the fixture should come from re-running this script, never from
editing the JSON by hand.
"""
import json
import os

import numpy as np
from scipy import special, stats
from statsmodels.stats.multitest import multipletests
from statsmodels.stats.proportion import proportion_confint

OUT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "packages", "core", "test", "fixtures", "scipy-reference.json",
)

rng = np.random.default_rng(20260819)
two_sample = []


def add(name, a, b):
    """Record every two-sample statistic for one scenario."""
    a = [float(x) for x in a]
    b = [float(x) for x in b]
    na, nb = len(a), len(b)

    t = stats.ttest_ind(a, b, equal_var=False)
    va, vb = np.var(a, ddof=1) / na, np.var(b, ddof=1) / nb
    df = (va + vb) ** 2 / (va ** 2 / (na - 1) + vb ** 2 / (nb - 1)) if (va + vb) > 0 else 0.0

    mw = stats.mannwhitneyu(a, b, alternative="two-sided", method="asymptotic", use_continuity=True)
    ks = stats.ks_2samp(a, b, method="asymp")
    lev = stats.levene(a, b, center="median")

    two_sample.append(dict(
        name=name, a=a, b=b,
        welch_t=float(t.statistic), welch_p=float(t.pvalue), welch_df=float(df),
        mw_u=float(mw.statistic), mw_p=float(mw.pvalue),
        ks_d=float(ks.statistic), ks_p=float(ks.pvalue),
        lev_w=float(lev.statistic), lev_p=float(lev.pvalue),
    ))


# Each scenario mirrors a failure mode Sentinel probes actually see.
add("normal_shift", rng.normal(100, 15, 60), rng.normal(118, 15, 60))
add("normal_same", rng.normal(50, 8, 40), rng.normal(50, 8, 40))
add("variance_change", rng.normal(0, 1, 50), rng.normal(0, 3, 50))
add("heavy_ties_binary", rng.binomial(1, 0.9, 80), rng.binomial(1, 0.55, 80))
add("skewed", rng.exponential(2, 45), rng.exponential(3.4, 45))
add("small_n", rng.normal(10, 2, 8), rng.normal(13, 2, 9))
add("tiny_effect_bign", rng.normal(0, 1, 300), rng.normal(0.08, 1, 300))
add("latency_tail",
    np.concatenate([rng.normal(200, 20, 55), rng.normal(210, 18, 5)]),
    np.concatenate([rng.normal(200, 20, 50), rng.normal(600, 120, 10)]))


def cliffs_delta_bruteforce(a, b):
    """O(n*m) definition of Cliff's delta; stats.js uses an O(n log n) form."""
    gt = sum(1 for x in a for y in b if x > y)
    lt = sum(1 for x in a for y in b if x < y)
    return (gt - lt) / (len(a) * len(b))


cliffs = [dict(name=c["name"], delta=cliffs_delta_bruteforce(c["a"], c["b"]))
          for c in two_sample]

bh = []
for ps in (
    [0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074,
     0.205, 0.212, 0.216, 0.222, 0.451, 0.6, 0.79, 0.99],
    [0.04, 0.04, 0.04, 0.04],                       # all-tied
    [0.5],                                          # single hypothesis
    [0.0001, 0.9, 0.03, 0.45, 0.002, 0.6, 0.011],   # unsorted input
):
    _, adj, _, _ = multipletests(ps, alpha=0.05, method="fdr_bh")
    bh.append(dict(p=list(ps), adj=[float(x) for x in adj]))

wilson = []
for s, n in [(0, 500), (10, 500), (1, 20), (37, 100), (500, 500)]:
    lo, hi = proportion_confint(s, n, alpha=0.05, method="wilson")
    wilson.append(dict(s=s, n=n, lower=float(lo), upper=float(hi)))

rng2 = np.random.default_rng(4242)

qd = [float(x) for x in rng2.normal(10, 3, 37)]
qs = [0, 0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 1]
quantile = dict(data=qd, qs=qs,
                vals=[float(np.quantile(qd, q, method="linear")) for q in qs])

# Includes deep-tail z values: a strong drift signal lands there, and a naive
# 1-erf(x) formulation loses every significant digit past about z=-6.
zs = [-40, -10, -6, -3.5, -1.959963984540054, -1, -0.5,
      0, 0.3, 1, 2.5, 4, 6, 10, 40]
normal_cdf = dict(z=zs, v=[float(stats.norm.cdf(z)) for z in zs])

erf_x = [-4, -2, -1, -0.5, 0, 0.1, 0.5, 1, 2, 3, 5]
erf_ref = dict(x=erf_x, v=[float(special.erf(x)) for x in erf_x])

# Values below 0.5 exercise the reflection formula branch of logGamma.
lg_x = [0.01, 0.1, 0.25, 0.4, 0.5, 0.75, 1, 1.5, 2, 5, 10, 100, 1000]
log_gamma = dict(x=lg_x, v=[float(special.gammaln(x)) for x in lg_x])

erfc_x = [-2, 0, 0.5, 1, 2, 3, 5, 10, 20]
erfc_ref = dict(x=erfc_x, v=[float(special.erfc(x)) for x in erfc_x])

tdist = dict(cases=[[float(t), float(df), float(2 * stats.t.sf(abs(t), df))]
                    for t, df in [(0.5, 5), (2.0, 10), (2.5, 3), (1.96, 1000),
                                  (0.0, 7), (6.0, 12), (15.0, 2), (3.1, 27.4)]])

a = [float(x) for x in rng2.normal(0, 1, 40)]
b = [float(x) for x in rng2.normal(0.7, 1.2, 45)]
sp = np.sqrt(((len(a) - 1) * np.var(a, ddof=1) + (len(b) - 1) * np.var(b, ddof=1))
             / (len(a) + len(b) - 2))
cohens_d = dict(a=a, b=b, d=float((np.mean(a) - np.mean(b)) / sp))

# Exact one-sided binomial tail P(X >= k), the corroboration test in the
# consensus engine. Cases span the deep tail (where a naive pmf summation
# underflows) and the degenerate edges.
binom_cases = [(2, 3, 0.09), (2, 10, 0.09), (5, 50, 0.09), (10, 50, 0.09),
               (25, 50, 0.09), (1, 1, 0.5), (1, 500, 0.001), (40, 50, 0.09),
               (3, 300, 0.005), (150, 300, 0.5), (2, 4, 0.25), (7, 20, 0.2),
               (50, 50, 0.09), (1, 1000, 0.09), (300, 1000, 0.25)]
binomial_tail = dict(cases=[[int(k), int(n), float(p0),
                             float(stats.binom.sf(k - 1, n, p0))]
                            for k, n, p0 in binom_cases])

payload = dict(
    _generator="scripts/gen-stats-reference.py",
    _note=("Ground truth produced by scipy %s / numpy %s / statsmodels. "
           "Do not hand-edit." % (__import__("scipy").__version__, np.__version__)),
    twoSample=two_sample, cliffs=cliffs, benjaminiHochberg=bh, wilson=wilson,
    quantile=quantile, normalCdf=normal_cdf, erf=erf_ref, erfc=erfc_ref, logGamma=log_gamma, tdist=tdist, cohensD=cohens_d, binomialTail=binomial_tail,
)

with open(OUT, "w") as fh:
    json.dump(payload, fh, indent=1)

print("wrote %s (%d two-sample scenarios)" % (OUT, len(two_sample)))
