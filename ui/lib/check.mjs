// Rote answer checking: Claude lists {id, kind, expr, claimed} and fixed sympy code does the checking, so no model
// writes or reads verification code. Used by the check_answers tool and by the app's own check of each reply's
// ```json {"checks": [...]} block (server.mjs), which runs with no model at all and reports only failures.
// It runs through runCas (local sandbox, or the hosted /api/cas function), so it needs nothing new deployed.

// Python, appended after tools.mjs's PRELUDE (sympy is already star-imported). @@PROBLEMS@@ becomes a JSON string.
export const CHECK_PY = String.raw`
import json, re, signal, random
from sympy.core.relational import Relational
from sympy.parsing.sympy_parser import parse_expr, standard_transformations, implicit_multiplication_application, convert_xor

TR = standard_transformations + (implicit_multiplication_application, convert_xor)
# Every single letter is a real variable (so N, S, E, I, Q are variables, not sympy objects).
LOC = {ch: Symbol(ch, real=True) for ch in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"}
LOC.update({"abs": Abs, "ln": log, "sqrt": sqrt, "pi": pi, "oo": oo})

def clean(s):
    s = str(s).strip().strip("$").strip()
    for a, b in [("\\left", ""), ("\\right", ""), ("\\pm", "±"), ("\\cup", "∪"), ("\\leq", "<="), ("\\geq", ">="), ("\\le", "<="), ("\\ge", ">="),
                 ("\\cdot", "*"), ("\\times", "*"), ("\\div", "/"), ("\\pi", "pi"), ("\\infty", "oo"), ("\\,", ""),
                 ("\\!", ""), ("\\ ", " "), ("≤", "<="), ("≥", ">="), ("−", "-"), ("·", "*"), ("×", "*"), ("÷", "/"), ("∞", "oo")]:
        s = s.replace(a, b)
    prev = None
    while prev != s:
        prev = s
        s = re.sub(r"\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}", r"((\1)/(\2))", s)
        s = re.sub(r"\\sqrt\[([^\]]*)\]\{([^{}]*)\}", r"root(\2, \1)", s)
        s = re.sub(r"\\sqrt\{([^{}]*)\}", r"sqrt(\1)", s)
        s = re.sub(r"\|([^|]*)\|", r"Abs(\1)", s)
    return s.replace("{", "(").replace("}", ")").replace("\\", "")

def ex(s):
    v = parse_expr(s.strip(), local_dict=LOC, transformations=TR)
    return Tuple(*v) if isinstance(v, tuple) else v

OPS = {"<=": Le, ">=": Ge, "<": Lt, ">": Gt, "=": Eq, "==": Eq}
def rel(s):
    parts = re.split(r"(<=|>=|==|=|<|>)", clean(s))
    if len(parts) == 1: return ex(parts[0])
    terms, ops = [ex(p) for p in parts[0::2]], parts[1::2]
    rs = [OPS[o](terms[i], terms[i + 1], evaluate=False) for i, o in enumerate(ops)]
    return rs[0] if len(rs) == 1 else And(*rs)

def split_top(s, seps=",;"):
    out, depth, cur = [], 0, ""
    for ch in s:
        depth += ch in "([" ; depth -= ch in ")]"
        if depth == 0 and ch in seps: out.append(cur); cur = ""
        else: cur += ch
    out.append(cur)
    return [p.strip() for p in out if p.strip()]

def eqv(a, b):
    try:
        if simplify(a - b) == 0: return True
    except Exception: pass
    fs = sorted((a - b).free_symbols, key=str)
    try:
        for _ in range(4):
            d = (a - b).subs({s: Rational(random.randint(-90, 90), random.randint(1, 9)) for s in fs})
            if abs(complex(N(d))) > 1e-9: return False
        return True
    except Exception: return False

def fmt(v):
    if v == S.EmptySet: return "no solution"
    if v == S.Reals: return "all real numbers"
    if isinstance(v, FiniteSet): return "{" + ", ".join(fmt(x) for x in v) + "}"
    return sstr(v).replace("**", "^")

NONE = re.compile(r"no( real)? solution|^none$|empty|∅|emptyset|varnothing", re.I)
ALL = re.compile(r"all real|every real|any real|infinitely many|identity|mathbb\(?r\)?|ℝ", re.I)

def solve1(r, v):
    if isinstance(r, And):
        out = S.Reals
        for a in r.args: out = out & solve1(a, v)
        return out
    others = r.free_symbols - {v}
    if others:  # a literal equation: solve for v in terms of the others
        return FiniteSet(*solve(r, v))
    return solveset(r, v, S.Reals)

def claimed_set(c, v):
    if NONE.search(c): return S.EmptySet
    if ALL.search(c): return S.Reals
    c = clean(c)
    out = S.EmptySet
    parts = []
    for part in split_top(re.sub(r"\bor\b|∪|\bU\b", ";", c)):
        pm = re.split(r"±", part, maxsplit=1)
        parts += [pm[0] + "+" + pm[1], pm[0] + "-" + pm[1]] if len(pm) == 2 else [part]
    for part in parts:
        # One variable, so a bracketed pair is interval notation: (-oo, 2], [1, 3)
        m = re.fullmatch(r"([\[\(])(.+),(.+)([\]\)])", part)
        if m and not re.search(r"\b%s\b" % re.escape(str(v)), part):
            lo, hi = ex(m.group(2)), ex(m.group(3))
            out = out | Interval(lo, hi, m.group(1) == "(", m.group(4) == ")"); continue
        r = rel(part)
        if isinstance(r, Eq) and r.lhs == v: out = out | FiniteSet(r.rhs)
        elif isinstance(r, (Relational, And)): out = out | solve1(r, v)
        else: out = out | FiniteSet(r)
    return out

def same_set(A, B):
    if isinstance(A, FiniteSet) and isinstance(B, FiniteSet):
        return all(any(eqv(x, y) for y in B) for x in A) and all(any(eqv(x, y) for x in A) for y in B)
    try: return Complement(A, B) == S.EmptySet and Complement(B, A) == S.EmptySet
    except Exception: return A == B

def check_solve(p):
    rels = [rel(r) for r in split_top(clean(p["expr"]), ";")]
    vs = [LOC.get(x.strip(), Symbol(x.strip(), real=True)) for x in split_top(p.get("vars") or "")]
    if not vs: vs = sorted(set().union(*[r.free_symbols for r in rels]), key=str)
    if not vs: raise ValueError("no variable to solve for")
    if len(rels) == 1 and len(vs) == 1:
        A = solve1(rels[0], vs[0])
        if p.get("claimed") is None: return "info", "%s: %s" % (vs[0], fmt(A))
        B = claimed_set(p["claimed"], vs[0])
        if same_set(A, B): return "ok", ""
        msg = "claimed %s; CAS gets %s" % (fmt(B), fmt(A))
        if isinstance(A, FiniteSet) and isinstance(B, FiniteSet):
            extra = [y for y in B if not any(eqv(x, y) for x in A)]
            if extra: msg += " (%s doesn't satisfy it)" % ", ".join("%s=%s" % (vs[0], fmt(y)) for y in extra)
        return "wrong", msg
    if any(not isinstance(r, Eq) for r in rels): raise ValueError("systems of inequalities aren't supported; use cas")
    sols = solve(rels, vs, dict=True)
    inf = any(len(s) < len(vs) or any(s[v].free_symbols & set(vs) for v in s) for s in sols)
    A = "inf" if inf else [tuple(s[v] for v in vs) for s in sols]
    showA = "infinitely many" if inf else (", ".join("(" + ", ".join(fmt(x) for x in t) + ")" for t in A) or "no solution")
    names = "(" + ", ".join(map(str, vs)) + ")"
    if p.get("claimed") is None: return "info", "%s = %s" % (names, showA)
    c = p["claimed"]
    if ALL.search(c): B = "inf"
    elif NONE.search(c): B = []
    else:
        B = []
        for sol in re.split(r"\bor\b|;", clean(c)):
            if "=" in sol:
                d = {}
                for a in split_top(sol, ","):
                    l, r = a.split("=", 1); d[ex(l)] = ex(r)
                B.append(tuple(d.get(v) for v in vs))
            else:
                B += [tuple(ex(t)) for t in split_top(sol, ",")]
    if A == "inf" or B == "inf": ok = A == B
    else: ok = len(A) == len(B) and all(any(all(y is not None and eqv(x, y) for x, y in zip(a, b)) for b in B) for a in A)
    return ("ok", "") if ok else ("wrong", "claimed %s; CAS gets %s = %s" % (c, names, showA))

def nfactors(e):
    n = 0
    for f in Mul.make_args(e):
        b, k = f.as_base_exp()
        if b.free_symbols: n += int(k) if k.is_Integer and k > 0 else 1
    return n

def check_equal(p):
    e1 = ex(clean(p["expr"]))
    form = (p.get("form") or "").lower()
    if p.get("claimed") is None:
        return "info", fmt(factor(e1) if form == "factored" else expand(e1) if form == "expanded" else simplify(e1))
    e2 = ex(clean(p["claimed"]))
    if not eqv(e1, e2): return "wrong", "%s is not equal to %s (CAS: %s)" % (fmt(e2), fmt(e1), fmt(simplify(e1)))
    if form == "factored":
        full = sum(m for f, m in factor_list(expand(e2))[1] if f.free_symbols)
        if nfactors(e2) < full: return "wrong", "not completely factored (CAS: %s)" % fmt(factor(e2))
    if form == "expanded" and expand(e2) != e2: return "wrong", "not expanded (CAS: %s)" % fmt(expand(e2))
    return "ok", ""

def _alarm(*_): raise TimeoutError("took over 4 s")
signal.signal(signal.SIGALRM, _alarm)
for p in json.loads(@@PROBLEMS@@):
    signal.alarm(4)
    try: st, msg = (check_equal if p.get("kind") == "equal" else check_solve)(p)
    except Exception as e: st, msg = "error", "%s: %s" % (type(e).__name__, str(e)[:200])
    finally: signal.alarm(0)
    print("@@" + json.dumps({"id": p["id"], "status": st, "msg": msg}), flush=True)
`;

export const CHECK_ITEM_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "Your label, e.g. P1.3 (part 1, item 3) or C4 for a candidate" },
    kind: { type: "string", enum: ["solve", "equal"], description: "solve: an equation, inequality or system; equal: an expression and its simplified/factored/expanded/evaluated answer" },
    expr: { type: "string", description: "Plain math (2x^2 - 3x = 5, sqrt(x+3) = x - 3, 1 < 2x + 1 <= 7). Separate a system's equations with ';'. Simple LaTeX (\\frac, \\sqrt, \\le) is accepted." },
    vars: { type: "string", description: "Optional: the variable(s) to solve for, comma-separated, e.g. 'x' or 'x, y'. Default: every letter in expr." },
    claimed: { type: "string", description: "The answer key's answer: 'x = 2, x = -3', 'no solution', 'all real numbers', 'x < 2', '(-oo, 2]', '(1, 2)' or 'x = 1, y = 2' for a system, an expression for equal. Leave it out to get the CAS's answer instead." },
    form: { type: "string", enum: ["factored", "expanded"], description: "equal only: also require the answer be completely factored / fully expanded" },
  },
  required: ["id", "expr"],
};

const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

// Normalizes model-written items; anything non-object is dropped.
export function normChecks(list) {
  return (Array.isArray(list) ? list : []).filter((p) => p && typeof p === "object").slice(0, 80).map((p, i) => ({
    id: String(p.id ?? `#${i + 1}`), kind: p.kind === "equal" ? "equal" : "solve", expr: String(p.expr ?? ""),
    vars: p.vars == null ? "" : Array.isArray(p.vars) ? p.vars.join(", ") : String(p.vars),
    claimed: p.claimed == null || p.claimed === "" ? null : String(p.claimed), form: typeof p.form === "string" ? p.form : "",
  }));
}

// results: [{id, status: ok|wrong|error|info, msg}]. Terse on purpose: passing items cost one count, not a line each.
export function formatChecks(results) {
  const n = (s) => results.filter((r) => r.status === s);
  const [ok, wrong, err, info] = ["ok", "wrong", "error", "info"].map(n);
  const lines = [...info.map((r) => `${r.id}: ${r.msg}`), ...wrong.map((r) => `${r.id} WRONG: ${r.msg}`), ...err.map((r) => `${r.id} NOT CHECKED: ${r.msg}`)];
  const checked = results.length - info.length;
  const head = !checked ? "" : !wrong.length && !err.length ? `all ${ok.length} ok` : `${ok.length} ok, ${wrong.length} wrong, ${err.length} not checked`;
  return [head, ...lines].filter(Boolean).join("\n");
}

// runCas is passed in (tools.mjs owns it) so this module has no process or file dependencies.
export async function checkAnswers(problems, runCas, { signal } = {}) {
  const list = normChecks(problems);
  if (!list.length) return { ok: false, text: "problems must be a non-empty array", results: [] };
  const r = await runCas(CHECK_PY.replace("@@PROBLEMS@@", () => JSON.stringify(JSON.stringify(list))), { signal });
  const got = new Map();
  for (const l of (r.text || "").split("\n")) {
    if (!l.startsWith("@@")) continue;
    try { const j = JSON.parse(l.slice(2)); got.set(String(j.id), j); } catch {}
  }
  const why = r.ok ? "no result" : "not run: " + clip((r.text || "").replace(/@@.*\n?/g, "").trim() || "CAS failed", 300);
  const results = list.map((p) => got.get(p.id) || { id: p.id, status: "error", msg: why });
  return { ok: got.size > 0, text: formatChecks(results), results };
}

// The reply's {"checks": [...]} block (the last one), or null.
export function checksFrom(text) {
  const blocks = [...String(text || "").matchAll(/```json\n([\s\S]*?)\n```/gi)].map((m) => m[1]).reverse();
  for (const b of blocks) { try { const o = JSON.parse(b); if (o && !Array.isArray(o) && Array.isArray(o.checks)) return o.checks; } catch {} }
  return null;
}
// The reply without its checks block(s): the teacher sees the app's verdict instead.
export function stripChecks(text) {
  return String(text || "").replace(/\n*```json\n([\s\S]*?)\n```/gi, (all, b) => {
    try { const o = JSON.parse(b); if (o && !Array.isArray(o) && Array.isArray(o.checks)) return ""; } catch {}
    return all;
  }).trimEnd();
}
