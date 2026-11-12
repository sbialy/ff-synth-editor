// FROZEN. The knob position <-> parameter value maps the randomizer uses, written so that every JS engine gives the same bits.
// Once released it is never edited: a change is a new file used by a new algorithm version. test/frozen-files.test.ts fails when a
// byte of it changes, test/randomize-golden.test.ts pins what it computes.
//
// Why it exists: Math.exp, Math.log, Math.pow and friends are "implementation-approximated" in the language definition, so the
// last bit differs between V8, JavaScriptCore and SpiderMonkey and between operating systems. The firmware's own edit curve
// (open_cold.cpp curveToValue) uses powf for an exponential parameter, which has the same problem in C++. So the randomizer does
// not call either. It works on a knob position K in the integer space 0..65535 (K = 65535 is the end of the knob) and maps it to
// a value here, using only + - * / on doubles (IEEE 754 binary64, round to nearest even: the language fixes these bit for bit),
// Math.round / Math.floor / Math.fround (exact by definition) and one fixed series for ln and exp. No Math.exp / log / pow / sqrt.
//
// The curve kinds are those of the firmware (meta.params[i].curve), n = K / 65535 (one division, correctly rounded):
//   linear      value = min + (max - min) * n
//   power       value = min + (max - min) * (n * n)
//   expSteep    value = min + (max - min) * (n * n * n)
//   exp         min > 0: value = min * (max / min) ^ n, computed as min * exp(n * ln(max / min)) with the series below.
//               min <= 0: the firmware falls back to the power curve, so does this.
// The result is rounded to float32 (Math.fround, the format of the .patch file) and clamped to [min, max]. K = 0 is exactly min and
// K = 65535 exactly max. It agrees with the firmware's own curve to a float32 unit in the last place or two (tested against the
// host), it is not claimed to be bit-identical to it: it is bit-identical to ITSELF everywhere, which is the point.

export const K_MAX = 65535

const LN2 = 0.6931471805599453
const SQRT2 = 1.4142135623730951
const f32 = Math.fround

// 1 / (2k + 1) for the atanh series, 1 / i for the exp series: each one division, correctly rounded
const ODD = Array.from({ length: 14 }, (_, k) => 1 / (2 * k + 1))
const dv = new DataView(new ArrayBuffer(8)) // big endian reads and writes, whatever the machine is

/** x = m * 2^e with m in [1, 2), x a positive normal double. Reads the bits, no Math function. */
function frexp1(x) {
  dv.setFloat64(0, x)
  const hi = dv.getUint32(0)
  const e = ((hi >>> 20) & 0x7ff) - 1023
  dv.setUint32(0, ((hi & 0x800fffff) | 0x3ff00000) >>> 0)
  return [dv.getFloat64(0), e]
}
/** 2^k exactly, k an integer in -1000..1000. */
function pow2(k) {
  dv.setUint32(0, ((k + 1023) << 20) >>> 0)
  dv.setUint32(4, 0)
  return dv.getFloat64(0)
}

/** Natural logarithm of a positive normal double: ln(m) = 2 atanh((m-1)/(m+1)) on m in [1/sqrt2, sqrt2), plus e ln 2. About 1e-16 off. */
export function ln(x) {
  let [m, e] = frexp1(x)
  if (m > SQRT2) { m /= 2; e += 1 }
  const s = (m - 1) / (m + 1), s2 = s * s
  let r = 0
  for (let k = ODD.length - 1; k >= 0; k--) r = r * s2 + ODD[k]
  return 2 * s * r + e * LN2
}

/** e^x for |x| below about 600: x = k ln 2 + f, e^f by the Taylor series (18 terms, |f| <= 0.35), times 2^k exactly. */
export function exp(x) {
  const k = Math.round(x / LN2)
  const f = x - k * LN2
  let r = 1
  for (let i = 18; i >= 1; i--) r = 1 + (f * r) / i
  return r * pow2(k)
}

const clampv = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

/** The value (float32) at knob position K (an integer 0..65535) of a parameter { min, max, curve }. */
export function knobValue(p, K) {
  const min = f32(p.min), max = f32(p.max)
  if (K <= 0) return min
  if (K >= K_MAX) return max
  const n = K / K_MAX
  let v
  if (p.curve === "exp" && min > 0) v = min * exp(n * ln(max / min))
  else {
    const shaped = p.curve === "expSteep" ? n * n * n : p.curve === "power" || p.curve === "exp" ? n * n : n
    v = min + (max - min) * shaped
  }
  return clampv(f32(v), min, max)
}

/** The knob position (integer 0..65535) whose value is nearest to `value` (ties go to the lower position). Binary search over knobValue. */
export function knobOf(p, value) {
  const min = f32(p.min), max = f32(p.max)
  const v = clampv(Number.isFinite(value) ? value : min, min, max)
  let lo = 0, hi = K_MAX // smallest K with knobValue(K) >= v
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (knobValue(p, mid) >= v) hi = mid
    else lo = mid + 1
  }
  if (lo > 0 && v - knobValue(p, lo - 1) <= knobValue(p, lo) - v) return lo - 1
  return lo
}
