#!/usr/bin/env python3
"""Generate the server-migration v2 audit-register HTML report.

Reads migration-findings-v2.json (the workflow result) and emits a self-contained
HTML report following ~/.claude/html-templates/24-audit-register.html styling.
"""
import json, html, datetime

ROOT = "/root/robot-islands/docs/reports"
data = json.load(open(f"{ROOT}/migration-findings-v2.json"))["result"]
confirmed = data["confirmed"]
refuted = data.get("refutedOrUnconfirmed", [])

# finding index -> (batch label, commit sha or None for defer)
FIX = {
 0:("B1","633156b"),1:("B7","d5c7b3a"),2:("B7","d5c7b3a"),3:("B7","d5c7b3a"),4:("B7","d5c7b3a"),
 5:("B2","f5ee639"),6:("B7","d5c7b3a"),7:("B7","d5c7b3a"),8:("B6a","42369eb"),9:("B7","d5c7b3a"),
 10:("B1","633156b"),11:("B7","d5c7b3a"),12:("B1","633156b"),13:("B1","633156b"),14:("B7","d5c7b3a"),
 15:("B7","d5c7b3a"),16:("B1","633156b"),17:("B3","d464ee3"),18:("B1","633156b"),19:("B2","f5ee639"),
 20:("B2","f5ee639"),21:("B6b","cef14da"),22:("B6a","42369eb"),23:("B7","d5c7b3a"),24:("B3","d464ee3"),
 25:("B3","d464ee3"),26:("B3","d464ee3"),27:("B6a","42369eb"),28:("B3","d464ee3"),29:("B7","d5c7b3a"),
 30:("B7","d5c7b3a"),31:("B5","b77e207"),32:("B4","2e2ab39"),33:("B1","633156b"),34:("B4","2e2ab39"),
 35:("B1","633156b"),36:("DEFER",None),37:("B4","2e2ab39"),38:("B7","d5c7b3a"),39:("B2","f5ee639"),
 40:("B2","f5ee639"),41:("B8","00fb9f3"),42:("B8","00fb9f3"),43:("B8","00fb9f3"),44:("B1","633156b"),
 45:("B1","633156b"),46:("B8","00fb9f3"),
}
BATCH = {
 "B1":"Server intent contract/validation parity (8 fixes)",
 "B2":"WS/auth security + read-path checkpoint (5 fixes)",
 "B3":"REMOTE clock-domain rebase — epoch vs performance.now (5 findings, 1 fix)",
 "B4":"REMOTE snapshot/render-staleness (3 fixes)",
 "B5":"Island-merge dangling-reference fixup",
 "B6a":"Gateway-bypass → new server intents: rename / edit-biome / construct-island",
 "B6b":"Servitor pure-extraction + convert-to-servitor intent",
 "B7":"Authoritative server world-system catch-up (global ticks, bounded-stepped)",
 "B8":"SPEC-drift reconciliation + draining-route guard + sever transitive pixi import",
 "DEFER":"Accepted / deferred (minor, borderline)",
}
# clusters for grouping the register (root-cause view)
CLUSTERS = [
 ("A","Frozen world systems in REMOTE (the dominant cluster)",
  "The authoritative server only advanced the economy, never the global transport/exploration/"
  "orbital/merge ticks (the client runs them but behind <code>if (!isRemote)</code>). So in the "
  "default REMOTE mode every time-driven system was frozen and resources were consumed on dispatch "
  "with no effect. Fixed by a shared, bounded-stepped <code>advanceWorldSystems</code> the server "
  "runs during catch-up.",
  [1,2,3,4,6,7,9,11,14,15,23,29,30,38]),
 ("B","Cross-layer intent contract/validation parity",
  "Fields the client sends that the server dropped, over-strict guards rejecting valid wire values, "
  "or LOCAL/REMOTE validation divergence — the exact class the prior by-area audit missed. Includes "
  "the critical default-route rejection and the crystal-skill graft being unbuyable in REMOTE.",
  [0,10,12,13,16,18,33,35,44,45,43]),
 ("C","REMOTE clock-domain mismatch",
  "The server stamps wall-epoch timestamps; the client UI compared them against "
  "<code>performance.now()</code>, producing garbage ETAs/countdowns and a permanently-locked "
  "tier-reset. One <code>deserializeWorld</code> perf-arg fix rebases the whole class.",
  [17,24,25,26,28]),
 ("D","Client actions bypassing the mutation-gateway",
  "Construction, Convert-to-Servitor, Universe-Editor biome reassignment and island rename mutated "
  "local state directly and were reverted by the next ~1s authoritative snapshot in REMOTE. Each now "
  "routes through a server-validated intent (ids minted server-side).",
  [8,21,22,27]),
 ("E","REMOTE snapshot / render staleness",
  "The inspector cached orphaned objects across snapshot swaps; the rebuild gate both missed real "
  "geometry changes and over-rebuilt on non-visual toggles.",
  [32,34,37]),
 ("F","Security & resource-exhaustion on the new trust surface",
  "The new WebSocket and auth surface: Cross-Site WebSocket Hijacking, unbounded sockets/sessions, "
  "an idle-socket CPU leak from the read-path, and a signup timing oracle.",
  [5,19,20,39,40]),
 ("G","State-integrity & spec drift",
  "A merge leaving dangling orbital/lattice references, plus SPEC.md claims that the migration left "
  "false (trustProxy, rebuild-on-every-snapshot, trade-offers-live).",
  [31,41,42,46]),
]
SEVCLS = {"critical":"crit","important":"high","minor":"low"}
SEVLABEL = {"critical":"CRITICAL","important":"IMPORTANT","minor":"MINOR"}

def esc(s): return html.escape(s or "")

counts = {"critical":0,"important":0,"minor":0}
for f in confirmed: counts[f["severity"]] = counts.get(f["severity"],0)+1
n_fixed = sum(1 for i in range(len(confirmed)) if FIX.get(i,("",None))[0] != "DEFER")
n_defer = len(confirmed) - n_fixed

def fix_badge(i):
    b,sha = FIX.get(i,("?",None))
    if b == "DEFER":
        return '<span class="badge accepted">accept / defer</span>'
    return f'<span class="badge fixed">fixed · {esc(b)} · {esc(sha)}</span>'

def finding_card(i, f):
    sev = f["severity"]
    b,sha = FIX.get(i,("?",None))
    decided = "accept" if b=="DEFER" else "fix"
    fix_note = ("<strong>Deferred (accepted).</strong> Minor, borderline (1 of 2 verifiers refuted). "
                "Edge case: only a route batch in flight <em>across</em> an island merge. Left untouched "
                "rather than risk the perf-optimized recompute path; recorded for follow-up."
                ) if b=="DEFER" else esc(f["suggestedFix"])
    v = f.get("verify") or {}
    vtxt = f'verify r{v.get("refuted","?")}/s{v.get("survives","?")}'
    return f"""
      <article class="finding" id="F-{i:02d}">
        <div class="f-head">
          <span class="f-id">F-{i:02d}</span>
          <span class="f-title">{esc(f['title'])}</span>
          <span class="sev {SEVCLS[sev]}">{SEVLABEL[sev]}</span>
          {fix_badge(i)}
        </div>
        <div class="f-body">
          <div class="f-block">
            <div class="bk">Evidence · <span class="cite">{esc(f['file'])}</span> · {esc(f.get('kind',''))} · {vtxt}</div>
            <div class="bv">{esc(f['description'])}</div>
            <pre class="evidence">{esc(f['evidence'])}</pre>
          </div>
          <div class="f-block">
            <div class="bk">Remediation</div>
            <div class="bv">{fix_note}</div>
          </div>
        </div>
        <div class="f-decide" data-picker="F-{i:02d}">
          <label class="opt"><input type="radio" name="F-{i:02d}" value="fix"{' checked' if decided=='fix' else ''}>applied</label>
          <label class="opt"><input type="radio" name="F-{i:02d}" value="accept"{' checked' if decided=='accept' else ''}>accept / defer</label>
          <label class="opt"><input type="radio" name="F-{i:02d}" value="reopen">reopen</label>
        </div>
      </article>"""

# build cluster sections
sections = []
secnum = 2
for cid, ctitle, cintro, idxs in CLUSTERS:
    cards = "\n".join(finding_card(i, confirmed[i]) for i in idxs)
    sections.append(f"""
    <section>
      <div class="sec-head"><span class="num">{secnum}{cid}</span><h2>{esc(ctitle)}</h2></div>
      <p class="sec-intro">{cintro}</p>
      {cards}
    </section>""")

refuted_rows = "\n".join(
    f'<tr><td class="mono">{esc(r["title"][:90])}</td><td>{esc(r["severity"])}</td>'
    f'<td class="mono">r{(r.get("verify") or {}).get("refuted","?")}/s{(r.get("verify") or {}).get("survives","?")}</td></tr>'
    for r in refuted)

batch_rows = "\n".join(
    f'<tr><td class="mono">{esc(k)}</td><td>{esc(v)}</td>'
    f'<td class="mono">{esc(sorted({(FIX[i][1] or "—") for i in FIX if FIX[i][0]==k})[0])}</td></tr>'
    for k,v in BATCH.items())

today = "2026-06-14"
HTML = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Server-migration bug hunt — audit register (v2)</title>
<style>
:root{{--ivory:#1B1A17;--slate:#F5F3EC;--clay:#D97757;--oat:#3A352B;--olive:#8FA56E;--rust:#E08B7F;
--warn:#E0B47F;--gray-150:#2E2C27;--gray-300:#3A3833;--gray-500:#8F8D82;--gray-700:#CFCCC2;--white:#252420;
--code-bg:#121110;--serif:ui-serif,Georgia,serif;--sans:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
--mono:ui-monospace,'SF Mono',Menlo,monospace;--radius:12px;--border:1.5px solid var(--gray-300);}}
*{{margin:0;padding:0;box-sizing:border-box;}}
body{{font-family:var(--sans);background:var(--ivory);color:var(--gray-700);line-height:1.58;padding:56px 32px 120px;-webkit-font-smoothing:antialiased;}}
.page{{margin:0 auto;max-width:1080px;}}
header.page-head{{margin-bottom:40px;max-width:980px;}}
.eyebrow{{font-family:var(--mono);font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--gray-500);margin-bottom:12px;}}
h1{{font-family:var(--serif);font-weight:500;font-size:38px;line-height:1.14;color:var(--slate);margin-bottom:18px;letter-spacing:-.01em;}}
.context-box{{background:var(--gray-150);border:var(--border);border-radius:var(--radius);padding:16px 20px;font-size:14.5px;}}
.context-box .label{{font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--gray-500);display:block;margin-bottom:6px;}}
.summary{{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin-bottom:36px;}}
@media(max-width:900px){{.summary{{grid-template-columns:repeat(2,1fr);}}}}
.summary .cell{{background:var(--white);border:var(--border);border-radius:var(--radius);padding:16px 18px;}}
.summary .k{{font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--gray-500);margin-bottom:6px;}}
.summary .v{{font-size:17px;color:var(--slate);font-weight:600;}}
.summary .v.bad{{color:var(--rust);}}.summary .v.warn{{color:var(--warn);}}.summary .v.ok{{color:var(--olive);}}
.verdict{{background:var(--white);border:var(--border);border-left:4px solid var(--olive);border-radius:var(--radius);padding:22px 26px;margin-bottom:48px;}}
.verdict .vt{{font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--olive);margin-bottom:8px;}}
.verdict .vh{{font-family:var(--serif);font-size:22px;font-weight:500;color:var(--slate);margin-bottom:10px;letter-spacing:-.01em;}}
.verdict .vb{{font-size:14.5px;max-width:860px;}}
section{{margin-bottom:56px;}}
.sec-head{{display:flex;align-items:baseline;gap:14px;margin-bottom:8px;}}
.sec-head .num{{font-family:var(--mono);font-size:12px;background:var(--oat);color:var(--slate);padding:3px 9px;border-radius:8px;}}
.sec-head h2{{font-family:var(--serif);font-weight:500;font-size:25px;color:var(--slate);letter-spacing:-.01em;}}
.sec-intro{{font-size:14.5px;color:var(--gray-500);max-width:880px;margin-bottom:24px;}}
code{{font-family:var(--mono);font-size:.88em;background:var(--gray-150);border:1px solid var(--gray-300);border-radius:5px;padding:1px 5px;color:#C9B98A;}}
.scope{{display:grid;grid-template-columns:1fr 1fr;gap:20px;max-width:980px;}}
@media(max-width:820px){{.scope{{grid-template-columns:1fr;}}}}
.scope .col{{background:var(--white);border:var(--border);border-radius:var(--radius);overflow:hidden;}}
.scope .col-head{{padding:12px 18px;font-family:var(--mono);font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;border-bottom:var(--border);}}
.scope .col.in .col-head{{background:#232A1C;color:var(--olive);}}
.scope .col.out .col-head{{background:var(--gray-150);color:var(--gray-500);}}
.scope .col-body{{padding:14px 18px;font-size:13.5px;}}
.scope ul{{list-style:none;}}.scope li{{margin:6px 0;padding-left:16px;position:relative;}}
.scope li::before{{content:'';position:absolute;left:0;top:9px;width:6px;height:6px;border-radius:2px;background:var(--gray-500);}}
.scope .in li::before{{background:var(--olive);}}
.finding{{background:var(--white);border:var(--border);border-radius:var(--radius);margin-bottom:18px;overflow:hidden;}}
.f-head{{display:flex;align-items:center;gap:12px;padding:14px 20px;background:var(--gray-150);border-bottom:var(--border);flex-wrap:wrap;}}
.f-id{{font-family:var(--mono);font-size:12px;color:var(--gray-500);}}
.f-title{{font-family:var(--serif);font-size:16.5px;color:var(--slate);flex:1;min-width:220px;}}
.sev{{display:inline-block;font-family:var(--mono);font-size:11px;padding:2px 8px;border-radius:6px;font-weight:600;}}
.sev.crit{{background:#54231A;color:#F2A28E;}}.sev.high{{background:#4A2A1C;color:#F0B79C;}}.sev.low{{background:#2D3A24;color:#B6CC96;}}
.badge{{display:inline-block;font-family:var(--mono);font-size:10.5px;padding:2px 8px;border-radius:6px;letter-spacing:.04em;}}
.badge.fixed{{background:#2D3A24;color:var(--olive);}}.badge.accepted{{background:var(--oat);color:var(--warn);}}
.f-body{{padding:16px 20px;display:grid;grid-template-columns:1fr 1fr;gap:16px 28px;}}
@media(max-width:820px){{.f-body{{grid-template-columns:1fr;}}}}
.f-block .bk{{font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--gray-500);margin-bottom:6px;}}
.f-block .bv{{font-size:13.5px;}}.f-block .bv strong{{color:var(--slate);}}
.cite{{display:inline-block;font-family:var(--mono);font-size:10.5px;background:var(--oat);color:var(--clay);border-radius:6px;padding:1px 7px;}}
pre.evidence{{font-family:var(--mono);font-size:11.5px;background:var(--code-bg);border:1px solid var(--gray-300);border-radius:8px;padding:10px 12px;margin-top:8px;overflow-x:auto;color:#C9B98A;line-height:1.55;white-space:pre-wrap;word-break:break-word;}}
.f-decide{{display:flex;gap:10px;padding:0 20px 16px;flex-wrap:wrap;}}
.f-decide .opt{{background:var(--ivory);border:var(--border);border-radius:8px;padding:6px 13px;cursor:pointer;font-family:var(--mono);font-size:11.5px;color:var(--gray-700);position:relative;user-select:none;}}
.f-decide .opt input{{position:absolute;opacity:0;pointer-events:none;}}
.f-decide .opt:hover{{border-color:var(--clay);}}
.f-decide .opt[data-selected="true"]{{border-color:var(--clay);color:var(--clay);background:#1F1D1A;box-shadow:0 0 0 1px var(--clay) inset;}}
.tbl{{width:100%;border:var(--border);border-radius:var(--radius);border-collapse:separate;border-spacing:0;overflow:hidden;font-size:13.5px;}}
.tbl th,.tbl td{{text-align:left;padding:10px 14px;border-bottom:1px solid var(--gray-300);vertical-align:top;}}
.tbl th{{font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--gray-500);background:var(--gray-150);font-weight:600;}}
.tbl tr:last-child td{{border-bottom:none;}}.tbl td.mono{{font-family:var(--mono);font-size:12px;}}
.selections{{background:var(--white);border:var(--border);border-left:4px solid var(--clay);border-radius:var(--radius);padding:22px 26px;margin-top:40px;position:sticky;bottom:22px;}}
.selections h3{{font-family:var(--serif);font-size:20px;color:var(--slate);margin-bottom:12px;}}
.sel-grid{{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px 18px;font-size:12px;margin-bottom:16px;}}
@media(max-width:720px){{.sel-grid{{grid-template-columns:1fr;}}}}
.sel-row{{display:flex;justify-content:space-between;gap:10px;}}.sel-row .k{{color:var(--gray-500);font-family:var(--mono);}}.sel-row .v{{color:var(--slate);font-weight:600;}}
.actions{{display:flex;gap:10px;flex-wrap:wrap;}}
button.action{{font-family:var(--mono);font-size:12px;padding:9px 16px;background:var(--ivory);color:var(--clay);border:1.5px solid var(--clay);border-radius:8px;cursor:pointer;}}
button.action:hover{{background:#2A2521;}}
.toast{{font-family:var(--mono);font-size:11.5px;color:var(--olive);margin-left:8px;opacity:0;transition:opacity .2s;}}.toast.show{{opacity:1;}}
.footer{{color:var(--gray-500);font-size:13px;margin-top:64px;padding-top:22px;border-top:1px solid var(--gray-300);}}
.callout{{background:#2A211C;border:1.5px solid #5a3b2c;border-radius:var(--radius);padding:16px 20px;font-size:14px;margin:18px 0;}}
.callout .ct{{font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--warn);margin-bottom:6px;}}
</style></head>
<body><div class="page">
<header class="page-head">
  <div class="eyebrow">Audit · server-authoritative migration · {today}</div>
  <h1>Server-migration bug hunt — found &amp; fixed (v2)</h1>
  <div class="context-box"><span class="label">Context</span>
  A second, deliberately re-designed audit of the robot-islands server-authoritative migration
  (range <code>0bf2ed2..HEAD</code>). The prior by-area audit (28 findings, all previously fixed)
  structurally missed cross-layer <em>contract-parity</em> bugs — caught last time only by manual
  sweep. This run replaced the area split with an enumeration-driven harness: a per-intent end-to-end
  contract trace for all 30 intents + 7 orthogonal lenses + adversarial verification + a
  loop-until-dry completeness dredge (157 agents). Every confirmed finding was then fixed and the
  full suite re-run green.</div>
</header>

<div class="summary">
  <div class="cell"><div class="k">Raised → confirmed</div><div class="v">{data['raisedTotal']} → {data['confirmedTotal']}</div></div>
  <div class="cell"><div class="k">Critical / Important / Minor</div><div class="v bad">{counts['critical']}</div><div class="v" style="font-size:13px;color:var(--gray-500)">{counts['important']} imp · {counts['minor']} min</div></div>
  <div class="cell"><div class="k">Fixed</div><div class="v ok">{n_fixed} / {len(confirmed)}</div></div>
  <div class="cell"><div class="k">Accepted / deferred</div><div class="v warn">{n_defer}</div></div>
  <div class="cell"><div class="k">Suite (root npm test)</div><div class="v ok">3428 pass</div><div class="v" style="font-size:13px;color:var(--gray-500)">was 3382 · +46</div></div>
</div>

<div class="verdict">
  <div class="vt">Verdict — fixed &amp; green</div>
  <div class="vh">The migration shipped functionally complete on the trust surface but left the default
  REMOTE mode broadly broken at runtime; all {len(confirmed)} confirmed issues are now fixed (1 minor
  edge case accepted) across 9 commits, suite green at 3428 passing.</div>
  <div class="vb">The dominant defect (cluster A): the authoritative server only advanced the
  <em>economy</em> and never the global transport/exploration/orbital/merge ticks, so in the default
  mode dispatched drones/routes/vehicles/satellites froze and consumed resources with no effect. The
  most severe security hole was Cross-Site WebSocket Hijacking (no Origin check on the WS upgrade,
  F-05). Honest detection-quality note: two owner-supplied canaries on the §9.9 active-play bonus were
  <em>not</em> surfaced by this run (one was even adversarially refuted) — see §1.</div>
</div>

<section>
  <div class="sec-head"><span class="num">1</span><h2>Scope &amp; detection-quality (canary recall)</h2></div>
  <p class="sec-intro">What was audited, how, and an honest accounting of what the harness missed.</p>
  <div class="scope">
    <div class="col in"><div class="col-head">Audited</div><div class="col-body"><ul>
      <li>All 30 server intents — full 4-layer contract trace (gateway REMOTE payload ↔ LOCAL impl ↔ server destructure ↔ pure-fn args)</li>
      <li>7 lenses: LOCAL/REMOTE parity, economy-ctx parity, fix-commit regressions, snapshot round-trip, boot/reconnect/concurrency, auth/security, spec/code sync</li>
      <li>Adversarial verification (2 independent refuters/finding) + loop-until-dry completeness dredge</li>
    </ul></div></div>
    <div class="col out"><div class="col-head">Out of fix-scope (by owner instruction)</div><div class="col-body"><ul>
      <li>Three owner-supplied <strong>canaries</strong> (active-bonus mechanics) — used to measure recall, not as fix targets</li>
      <li>F-36 — deferred (minor, borderline; see register)</li>
      <li>Deeper pure/render decoupling of <code>placement.ts</code> → <code>buildings.ts</code> (pixi) — follow-up</li>
    </ul></div></div>
  </div>
  <div class="callout"><div class="ct">Canary recall — honest signal</div>
  Three real bugs were supplied as canaries to test this harness's recall:
  <strong>C1</strong> (active bonus not applied to recipe rates) — <strong>MISSED</strong>;
  <strong>C2</strong> (active bonus always ticks down — server ignores client presence) —
  <strong>MISSED, and the closest finding was adversarially <em>refuted</em></strong> (the verifier
  killed a finding framed inversely to the real bug);
  <strong>C3</strong> (force-run doesn't render until refreshed) — <strong>partially caught</strong>
  (the REMOTE snapshot render-staleness cluster, F-32/F-37). Per owner instruction these were not
  force-fixed; the recall gap on the §9.9 active-bonus class is the actionable signal for the next
  harness iteration.</div>
</section>
{''.join(sections)}

<section>
  <div class="sec-head"><span class="num">3</span><h2>Remediation map — 9 commits</h2></div>
  <p class="sec-intro">Each fix batch, committed linearly to <code>master</code>; the full root suite
  (both vitest projects) is green at 3428 passing (was 3382).</p>
  <table class="tbl"><thead><tr><th>Batch</th><th>Scope</th><th>Commit</th></tr></thead><tbody>
  {batch_rows}
  </tbody></table>
</section>

<section>
  <div class="sec-head"><span class="num">4</span><h2>Raised but not confirmed (refuted by verification)</h2></div>
  <p class="sec-intro">Findings the adversarial pass refuted — recorded for transparency.</p>
  <table class="tbl"><thead><tr><th>Claim</th><th>Severity</th><th>Verdict</th></tr></thead><tbody>
  {refuted_rows}
  </tbody></table>
</section>

<div class="selections">
  <h3>Disposition</h3>
  <div class="sel-grid" id="selGrid"></div>
  <div class="actions">
    <button class="action" id="copyJson">Copy dispositions as JSON</button>
    <span class="toast" id="toast"></span>
  </div>
</div>

<div class="footer"><p>Audit register v2 · generated {today} · range 0bf2ed2..HEAD · prior audit:
docs/reports/migration-audit-report.html (28 findings, fixed) · findings data:
docs/reports/migration-findings-v2.json</p></div>
</div>
<script>
(function(){{
 const state={{}};const strips=document.querySelectorAll('.f-decide');
 strips.forEach((strip)=>{{const name=strip.dataset.picker;if(!name)return;
  strip.querySelectorAll('input[type=radio]').forEach((r)=>{{if(r.checked)state[name]=r.value;
   r.addEventListener('change',()=>{{if(r.checked){{state[name]=r.value;render();}}}});
   r.closest('.opt').addEventListener('click',(e)=>{{if(e.target.tagName==='INPUT')return;r.checked=true;state[name]=r.value;render();}});}});}});
 function render(){{strips.forEach((strip)=>{{strip.querySelectorAll('.opt').forEach((opt)=>{{const r=opt.querySelector('input');opt.dataset.selected=(r&&r.checked)?'true':'false';}});}});
  const grid=document.getElementById('selGrid');if(!grid)return;grid.innerHTML='';
  Object.entries(state).forEach(([k,v])=>{{const row=document.createElement('div');row.className='sel-row';row.innerHTML='<span class="k">'+k+'</span><span class="v">'+v+'</span>';grid.appendChild(row);}});}}
 const toast=document.getElementById('toast');
 function flash(m){{if(!toast)return;toast.textContent=m;toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),1600);}}
 function clip(t,l){{if(navigator.clipboard&&navigator.clipboard.writeText){{navigator.clipboard.writeText(t).then(()=>flash(l),()=>fb(t,l));}}else fb(t,l);}}
 function fb(t,l){{const ta=document.createElement('textarea');ta.value=t;document.body.appendChild(ta);ta.select();try{{document.execCommand('copy');}}catch(_){{}}document.body.removeChild(ta);flash(l);}}
 document.getElementById('copyJson').addEventListener('click',()=>clip(JSON.stringify(state,null,2),'✓ JSON copied'));
 render();
}})();
</script>
</body></html>"""

open(f"{ROOT}/migration-audit-v2.html","w").write(HTML)
print(f"wrote migration-audit-v2.html ({len(HTML)} bytes); fixed={n_fixed} defer={n_defer} confirmed={len(confirmed)}")
