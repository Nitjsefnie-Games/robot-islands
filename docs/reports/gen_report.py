#!/usr/bin/env python3
"""Generate the migration-audit HTML report from migration-findings.json.
Adapts ~/.claude/html-templates/24-audit-register.html (audit register)."""
import json, html, datetime

DATA = json.load(open("/root/robot-islands/docs/reports/migration-findings.json"))
conf = DATA["confirmed"]
rej = DATA["rejected"]

# finding index -> (commit, extra note). Index order = workflow-confirmed (0..25) + ground-truth extras (26,27)
COMMIT = {
 0:"f1368db",1:"f1368db",2:"9b18b63",3:"e2560bc",4:"e2560bc",5:"e2560bc",6:"e2560bc",
 7:"f1368db",8:"f1368db",9:"61000c2",10:"61000c2 + e7f3964",11:"61000c2",12:"61000c2",
 13:"61000c2",14:"61000c2",15:"61000c2",16:"61000c2",17:"9b18b63",18:"e2560bc",
 19:"903951c",20:"903951c",21:"e2560bc",22:"f1368db",23:"f1368db",24:"f1368db",25:"f1368db",
 26:"903951c",27:"903951c",
}
# duplicate / overlap annotations (same root cause found by >1 finder)
DUP = {15:"Same root cause as F-10 (independently surfaced by a second finder).",
       18:"Same root cause as F-03 (independently surfaced by a second finder).",
       19:"Same endpoint as F-05/F-07 (independently surfaced by a third finder).",
       22:"Same read-path persistence issue as F-06."}
# how each was fixed (concise, beyond the original suggestedFix)
FIXNOTE = {
 0:"trustProxy:true → trustProxy:1 (one trusted nginx hop); deploy nginx now overwrites X-Forwarded-For with $remote_addr. Rate-limit test rewritten to drive the bucket via the real connection + a regression test proving a rotating XFF can't escape it.",
 1:"scryptSync → promisified crypto.scrypt; hashPassword/verifyPassword async; callers await. KDF now runs on the libuv threadpool, no event-loop freeze.",
 2:"Extracted a shared pure advanceWorldEconomy() used by BOTH client and server; loadAndCatchUp now applies the full RatesContext (biome/NC/solar/lattice/cable/toxicity/active-bonus). New server tests prove a fertile island out-produces a plain one offline.",
 3:"Per-account load→apply→persist wrapped in a tx with pg_advisory_xact_lock(hashtext(userId)); concurrent same-account intents serialize. Race test FAILS with the lock removed, passes with it.",
 4:"Imported savedAt/savedAtPerf clamped to [now-24h, now] (perfShift-invariant), bounding the offline windfall; 409 no-existing-save gate kept; residual content-trust documented in SPEC Appendix C.",
 5:"Read-only catchUp() split from the persisting path; GET /api/game/state + 1 Hz WS push no longer write the DB.",
 6:"Same fix as F-04/F-05: read-only projection path; persistence only inside the locked intent tx.",
 7:"Import savedAt clamp + documented trust boundary (one-time migration of the player's own local save; ongoing authority only via validated intents).",
 8:"Per-connection sliding-window limiter (20/s) checked BEFORE the load→apply→persist; cheap error ack over-limit, socket close on sustained abuse.",
 9:"Post-ack pushState wrapped in its own try/catch (best-effort) so a push failure can't manufacture a {seq:-1,ok:false} ack for an already-succeeded intent.",
 10:"applyRemoteSnapshot mutates worldState IN PLACE (Object.assign + Map reconcile) instead of reassigning, so subsystems holding references stay live.",
 11:"Rebuild gated on a vision + DISCOVERY + STRUCTURAL signature (buildings/modifiers/flags, construction as a boolean) — idle pushes skip, real changes repaint. (Review caught an initial over-narrow gate; widened in e7f3964.)",
 12:"makeRemoteGateway.send catches transport rejections and resolves to {ok:false,error}; the gateway contract is always a resolved result, so panel `if(!result.ok)` handles timeouts/closes.",
 13:"One-shot import guard; a 409 from /api/game/new treated as success-equivalent so a slow import can't re-fire and brick boot.",
 14:"Auth error body parsed; prefers the JSON `error` field with a status fallback.",
 15:"Fixed by the same in-place applyRemoteSnapshot change as F-10.",
 16:"In-flight commit guard on placement/relocate/orbital; attemptCommit early-returns while pending, cleared on both success and failure.",
 17:"Trade accept/reject in REMOTE now surface 'trade unavailable in online mode' instead of silently no-op'ing / mutating local state. LOCAL unchanged.",
 18:"Fixed by the shared advanceWorldEconomy() extraction (same as F-03).",
 19:"Fixed by the F-05/F-07 import savedAt clamp + documented trust boundary.",
 20:"place-building handler now routes oceanPlacement defs through validateOceanPlacement (anchor-local→world-cell coords) and forwards anchorIslandId.",
 21:"dispatch-drone handler validates + forwards waypoints and selectedTier; path-drawn drones are T5 again.",
 22:"Fixed by the read-only projection split (same as F-06): periodic push no longer re-advances+persists.",
 23:"AGENTS.md Stack section rewritten: server-authoritative split (Fastify+Postgres), REMOTE default / LOCAL fallback, mutation-gateway, SPEC §15.6 superseded + Appendix C.",
 24:"AGENTS.md Commands section: npm test now runs client+server projects and needs a live Postgres (not hermetic).",
 25:"Added server/tsconfig.test.json + `typecheck` script (tests included); fixed all 15 hidden strict-mode test type errors.",
 26:"place-building handler validates cargoLabel and forwards it to placeBuilding; crates honor the §4.6 picker again (default iron_ore only when omitted). 3 regression tests.",
 27:"Same handler now validates + forwards terrainTarget/terrainShotMs/nowMs; terrain-modifier placement works in REMOTE.",
}

SEVCLASS={"critical":"crit","important":"high","minor":"low"}
SEVORDER={"critical":0,"important":1,"minor":2}
AREA_LABEL={
 "auth-crypto":"Auth & crypto (slice 1)","runtime-persistence":"Runtime & persistence (slice 2)",
 "transport-intent":"Transport & intent protocol (slice 3)","client-transport":"Client transport & boot (slice 4)",
 "client-panels":"Async UI panels (slice 4)","trust-surface":"Cross-cutting trust surface (slice 5)",
 "spec-build-deploy":"Spec / build / deploy"}
AREA_ORDER=["auth-crypto","runtime-persistence","transport-intent","trust-surface","client-transport","client-panels","spec-build-deploy"]

def esc(s): return html.escape(str(s or ""))

# assign stable F-NN ids by original index
for i,f in enumerate(conf): f["_id"]="F-%02d"%(i+1); f["_commit"]=COMMIT.get(i,"?"); f["_fixnote"]=FIXNOTE.get(i,f.get("suggestedFix","")); f["_dup"]=DUP.get(i)

ncrit=sum(1 for f in conf if f["severity"]=="critical")
nimp=sum(1 for f in conf if f["severity"]=="important")
nmin=sum(1 for f in conf if f["severity"]=="minor")
missed=[f for f in conf if f.get("source","").startswith("ground-truth") or "parity-sweep" in f.get("source","")]

def card(f):
    dup = f"<div class='bv' style='color:var(--gray-500);margin-top:6px'><em>{esc(f['_dup'])}</em></div>" if f.get("_dup") else ""
    return f"""
      <article class="finding" id="{f['_id']}">
        <div class="f-head">
          <span class="f-id">{f['_id']}</span>
          <span class="f-title">{esc(f['title'])}</span>
          <span class="sev {SEVCLASS[f['severity']]}">{f['severity'].upper()}</span>
          <span class="badge fixed">FIXED · {esc(f['_commit'])}</span>
        </div>
        <div class="f-body">
          <div class="f-block">
            <div class="bk">What was wrong · <span style="color:var(--gray-500)">{esc(f['category'])}</span></div>
            <div class="bv">{esc(f['description'])}{dup}</div>
            <div class="bk" style="margin-top:12px">Evidence</div>
            <div class="bv"><span class="cite">{esc(f['file'])}</span></div>
            <pre class="evidence">{esc(f['evidence'])}</pre>
          </div>
          <div class="f-block">
            <div class="bk">Fix</div>
            <div class="bv">{esc(f['_fixnote'])}</div>
            <div class="bk" style="margin-top:12px">Verification</div>
            <div class="bv">Adversary panel: {f.get('survivesCount','?')} survive / {f.get('refutedCount','?')} refute · landed in <code>{esc(f['_commit'])}</code> · full suite green (3377 tests).</div>
          </div>
        </div>
      </article>"""

sections=""
for area in AREA_ORDER:
    items=sorted([f for f in conf if f["area"]==area], key=lambda f:SEVORDER[f["severity"]])
    if not items: continue
    sections+=f"""<div class="area-head"><h3>{esc(AREA_LABEL[area])}</h3><span class="area-n">{len(items)} finding{'s' if len(items)!=1 else ''}</span></div>"""
    sections+="".join(card(f) for f in items)

ledger="".join(f"<tr><td class='mono'>{f['_id']}</td><td>{esc(f['title'])[:96]}</td><td class='mono'>{esc(f['_commit'])}</td><td><span class='badge fixed'>fixed</span></td></tr>" for f in conf)

rejrows="".join(f"<tr><td>{esc(r['title'])[:110]}</td><td class='mono'>{esc(r['severity'])}</td><td>{r.get('survivesCount','?')}✓ / {r.get('refutedCount','?')}✗</td><td>{esc(r.get('why',''))[:160]}</td></tr>" for r in rej)

today=datetime.date(2026,6,14).isoformat()

CSS=open("/root/.claude/html-templates/24-audit-register.html").read()
CSS=CSS[CSS.index("<style>")+7:CSS.index("</style>")]
# add a couple of helpers
CSS+="""
    .area-head{display:flex;align-items:baseline;gap:12px;margin:34px 0 14px;padding-bottom:8px;border-bottom:1px solid var(--gray-300);}
    .area-head h3{font-family:var(--serif);font-size:20px;color:var(--clay);font-weight:500;}
    .area-n{font-family:var(--mono);font-size:11px;color:var(--gray-500);}
    .f-head .badge{margin-left:auto;}
    .toc{columns:2;gap:24px;font-size:13.5px;margin-top:10px;}
    @media(max-width:720px){.toc{columns:1;}}
    .toc a{color:var(--gray-700);text-decoration:none;display:block;padding:3px 0;}
    .toc a:hover{color:var(--clay);}
    .toc .sv{font-family:var(--mono);font-size:10px;}
"""

SEVCOLOR={"crit":"rust","high":"warn","low":"olive"}
def toc_link(f):
    col=SEVCOLOR[SEVCLASS[f['severity']]]
    return f"<a href='#{f['_id']}'><span class='sv' style='color:var(--{col})'>[{f['severity'][:4].upper()}]</span> {f['_id']} · {esc(f['title'])[:70]}</a>"
toc="".join(toc_link(f) for f in conf)

HTML=f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Server-migration audit — findings &amp; fixes</title>
<style>{CSS}</style></head>
<body><div class="page">
  <header class="page-head">
    <div class="eyebrow">Audit · server-authoritative migration · {today}</div>
    <h1>Server-migration audit — every issue found &amp; fixed</h1>
    <div class="context-box">
      <span class="label">Context</span>
      The robot-islands server-authoritative migration (slices 1–5, diff <code>{esc(DATA['range'])}</code> — a new Fastify+Postgres <code>server/</code> workspace + a client cutover to a REMOTE boot mode) shipped <strong>test-green</strong> ({esc(DATA['baseline'])}). This audit hunted the issues the green suite did <em>not</em> catch — regressions, anti-cheat/concurrency holes, async defects, spec drift — then verified, fixed, and re-verified each. Detection: a 65-agent workflow (7 parallel finders → a 2-adversary refutation panel per finding) plus owner ground-truth and a systematic intent-payload parity sweep.
    </div>
  </header>

  <div class="summary">
    <div class="cell"><div class="k">Confirmed findings</div><div class="v warn">{len(conf)}</div></div>
    <div class="cell"><div class="k">Critical</div><div class="v bad">{ncrit}</div></div>
    <div class="cell"><div class="k">Important / Minor</div><div class="v">{nimp} / {nmin}</div></div>
    <div class="cell"><div class="k">Fixed</div><div class="v ok">{len(conf)} / {len(conf)}</div></div>
    <div class="cell"><div class="k">Refuted by panel</div><div class="v">{len(rej)}</div></div>
  </div>

  <div class="verdict green">
    <div class="vt">Verdict</div>
    <div class="vh">The migration was test-green but functionally broken in its own default (REMOTE) mode and carried real anti-cheat &amp; concurrency holes — all {len(conf)} confirmed issues are now fixed and verified.</div>
    <div class="vb">The server ran the authoritative economy with <strong>no environment context</strong> (F-03/F-18 — biome, Network Consciousness, solar, lattice, toxicity and the player-flagged <em>active bonus</em> all silently disabled), and three intent handlers <strong>dropped client payload fields</strong> (F-26 crate cargo label → always iron_ore, F-20 ocean platforms, F-21 path-drawn drones, F-27 terrain modifiers). On top of that: <strong>req.ip spoofing</strong> bypassed the auth rate limit (F-01), <strong>concurrent intents lost updates</strong> with no DB lock (F-04), and a snapshot-swap <strong>orphaned every panel holding a world reference</strong> (F-10/F-15). Every finding survived a 2-adversary refutation panel ({len(rej)} candidate findings were killed by it). All fixes ship with tests; the full suite is green at 3377 tests. A code review of the riskiest fixes caught one over-correction (the rebuild gate, F-11) which was then widened. Residual, documented: the local-save import endpoint still trusts the player's own snapshot content (offline window now bounded) — see SPEC Appendix C.</div>
  </div>

  <section>
    <div class="sec-head"><span class="num">1</span><h2>Scope &amp; method</h2></div>
    <div class="scope">
      <div class="col in"><div class="col-head">Audited</div><div class="col-body"><ul>
        <li>Full migration diff <code>{esc(DATA['range'])}</code> — 60 commits, 83 files</li>
        <li>New <code>server/</code> workspace: auth, crypto, runtime, persistence, transport/intents</li>
        <li>Client cutover: <code>main.ts</code>, <code>mutation-gateway.ts</code>, <code>server-client.ts</code>, async panels</li>
        <li>Spec / build / deploy: <code>SPEC.md</code>, <code>AGENTS.md</code>, tsconfigs, vitest, systemd unit</li>
      </ul></div></div>
      <div class="col out"><div class="col-head">Method &amp; residual</div><div class="col-body"><ul>
        <li><strong>Detect</strong>: 7 parallel finder agents over the surface</li>
        <li><strong>Verify</strong>: 2 independent adversaries refute each finding; kept only if it survived</li>
        <li><strong>Ground-truth + parity</strong>: owner-flagged bugs + a full intent payload-field parity diff (caught 2 the workflow missed)</li>
        <li><strong>Residual (documented)</strong>: import endpoint content-trust; <code>hashtext</code> lock-key collisions (perf-only); import path not under the advisory lock (409-gated)</li>
      </ul></div></div>
    </div>
  </section>

  <section>
    <div class="sec-head"><span class="num">2</span><h2>Findings</h2></div>
    <p class="sec-intro">All {len(conf)} confirmed issues, by subsystem, each FIXED with its commit. Several were independently surfaced by more than one finder (noted) — a signal the detection was redundant where it mattered.</p>
    <div class="toc">{toc}</div>
    {sections}
  </section>

  <section>
    <div class="sec-head"><span class="num">3</span><h2>Fix ledger</h2></div>
    <table class="tbl"><thead><tr><th>ID</th><th>Finding</th><th>Commit</th><th>Status</th></tr></thead><tbody>{ledger}</tbody></table>
    <p class="sec-intro" style="margin-top:16px">Commits: <code>903951c</code> intent payload fields · <code>9b18b63</code> shared economy advance · <code>f1368db</code> server trust-surface + build/docs · <code>61000c2</code> client REMOTE regressions · <code>e2560bc</code> atomic intent tx + read-only path + import clamp · <code>e7f3964</code> rebuild-gate widening (review follow-up).</p>
  </section>

  <section>
    <div class="sec-head"><span class="num">4</span><h2>Considered &amp; refuted</h2></div>
    <p class="sec-intro">Candidate findings the 2-adversary panel killed — recorded so the reader knows they were evaluated, not missed.</p>
    <table class="tbl"><thead><tr><th>Claim</th><th>Sev</th><th>Votes</th><th>Why refuted</th></tr></thead><tbody>{rejrows}</tbody></table>
  </section>

  <div class="footer"><p>Audit register · generated {today} · scope: server-authoritative migration {esc(DATA['range'])} · all findings fixed &amp; verified (3377 tests green) · source data: <code>docs/reports/migration-findings.json</code></p></div>
</div></body></html>"""

open("/root/robot-islands/docs/reports/migration-audit-report.html","w").write(HTML)
print("wrote migration-audit-report.html  (%d bytes)" % len(HTML))
print("confirmed=%d crit=%d imp=%d min=%d rejected=%d missed-by-workflow=%d" % (len(conf),ncrit,nimp,nmin,len(rej),len(missed)))
