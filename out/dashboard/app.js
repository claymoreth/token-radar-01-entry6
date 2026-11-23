"use strict";
var R = window.RADAR;
var $ = function (id) { return document.getElementById(id); };
function money(v) {
  if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
  return "$" + Math.round(v);
}
function pct(v, d) { return (v * 100).toFixed(d == null ? 1 : d) + "%"; }
function num(v, d) { return v.toFixed(d == null ? 2 : d); }
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;"); }
function fnv1a(str) {
  var bytes = new TextEncoder().encode(str), h = 2166136261;
  for (var i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 16777619) >>> 0; }
  return ("0000000" + h.toString(16)).slice(-8);
}
function rowsSorted() { return R.rows.slice().sort(function (a, b) { return a.rank - b.rank; }); }
function totalImplied() { return R.rows.reduce(function (s, r) { return s + r.impliedValueUsd; }, 0); }
function tierOf(r) {
  if (r.watchlist) return "Watchlist";
  if (r.parentFactor && r.parentFactor < 1) return "Off-list";
  return r.tvlUsd < R.floorUsd ? "Early" : "Off-list";
}

var state = { verdict: "All", tier: "All", q: "", cat: "", chain: "", sort: "rank" };

function kpi(label, value, sub) {
  return '<article class="kpi"><span>' + label + '</span><b>' + value + '</b><i>' + sub + '</i></article>';
}
function renderKpis() {
  var ev = R.evidence, farm = R.rows.filter(function (r) { return r.verdict === "FARM"; }).length;
  var vKept = ev.value.terms.filter(function (t) { return t.kept === "kept"; }).length;
  var oKept = ev.odds.terms.filter(function (t) { return t.kept === "kept"; }).length;
  var rng = ev.range.rows[0];
  $("badge-model").textContent = R.model;
  $("badge-asof").textContent = "snapshot " + R.as_of;
  $("kpis").innerHTML =
    kpi("Walk-forward miss", num(ev.value.finalWf) + "×", "flat baseline " + num(ev.value.baselineWf) + "× · " + Math.round((1 - ev.value.finalWf / ev.value.baselineWf) * 100) + "% lower") +
    kpi("Range honesty", pct(rng.wf, 0) + " in P25–P75", "stated 50% · LOO " + pct(rng.loo, 0)) +
    kpi("Token odds Brier", num(ev.odds.finalWfBrier, 3), "walk-forward · baseline " + num(ev.odds.baselineWfBrier, 3)) +
    kpi("Terms survived", vKept + " of " + ev.value.terms.length + " value · " + oKept + " of " + ev.odds.terms.length + " odds", "kept only if they help out of sample") +
    kpi("Worth farming", farm + " of " + R.rows.length, "net beats T-bill + $25 / hour") +
    kpi("Watchlist ranked", R.integrity.watchlistCovered + " / " + R.integrity.watchlistTotal, "of the tracked watchlist · " + R.accounting.ranked + " rows ranked");
}

var PALETTE = ["#d9a441", "#5aa9e6", "#4cc38a", "#e26d5a", "#9b7ede", "#4db6ac", "#c9d4de", "#7a8a99"];
function renderAccounting() {
  var a = R.accounting, bar = "", leg = "";
  a.groups.forEach(function (g, i) {
    var w = a.total ? (g.count / a.total * 100) : 0, c = PALETTE[i % PALETTE.length];
    bar += '<div style="width:' + w.toFixed(2) + '%;background:' + c + '" title="' + esc(g.label) + '"></div>';
    leg += '<span><i style="background:' + c + '"></i>' + esc(g.label) + ' — ' + g.count + '</span>';
  });
  $("stackbar").innerHTML = bar;
  $("legend").innerHTML = leg;
  $("acct-note").textContent = "Total protocols accounted for: " + a.total + ". Groups sum to the total; a gap here would mean rows went missing between the ledger and the board.";
}

function check(ok, label) {
  return '<span class="chk ' + (ok ? "ok" : "bad") + '">' + (ok ? "✓ " : "✗ ") + label + "</span>";
}
function renderIntegrity() {
  var s = rowsSorted(), ig = R.integrity, tot = totalImplied();
  var seq = s.every(function (r, i) { return r.rank === i + 1; }) &&
    s.every(function (r, i) { return i === 0 || r.impliedValueUsd <= s[i - 1].impliedValueUsd; });
  var sig = s.map(function (r) { return r.slug + "|" + r.rank + "|" + r.impliedValueUsd; }).join("\n");
  var wl = R.rows.filter(function (r) { return r.watchlist; }).length;
  $("checks").innerHTML =
    check(R.rows.length === ig.rows, "table = ledger · " + R.rows.length + " rows") +
    check(seq, "ranks 1–" + R.rows.length + " in order · implied never rises") +
    check(Math.abs(tot - ig.totalImplied) < 1, "total implied matches · " + money(tot)) +
    check(fnv1a(sig) === ig.checksum, "checksum FNV-1a matches · " + ig.checksum) +
    check(wl === ig.watchlistCovered, "watchlist covered · " + wl + " / " + ig.watchlistTotal) +
    check(R.accounting.total === ig.ledgerTotal, "ledger total matches · " + ig.ledgerTotal + " protocols");
}

function statusLabel(k) {
  return { kept: "kept", tested: "tested — not kept", baseline: "baseline", "must-not-help": "must not help" }[k] || k;
}
function renderEvidence() {
  var ev = R.evidence;
  $("ev-value").innerHTML = ev.value.terms.map(function (t) {
    return "<tr><td>" + esc(t.name) + "</td><td>" + num(t.loo) + "</td><td>" + num(t.wf) + "</td><td>" + statusLabel(t.kept) + "</td></tr>";
  }).join("");
  $("ev-value-note").textContent = "Fitted on " + ev.value.n + " priced peers. Final model LOO miss " + num(ev.value.finalLoo) + ", walk-forward " + num(ev.value.finalWf) + " — against a flat baseline of " + num(ev.value.baselineLoo) + " / " + num(ev.value.baselineWf) + ". Walk-forward is the honest number: the model never sees the future it prices.";
  $("ev-odds").innerHTML = ev.odds.terms.map(function (t) {
    return "<tr><td>" + esc(t.name) + "</td><td>" + num(t.brier, 3) + "</td><td>" + num(t.wfBrier, 3) + "</td><td>" + statusLabel(t.kept) + "</td></tr>";
  }).join("");
  $("ev-odds-note").textContent = "Fitted on " + ev.odds.n + " tracked protocols, base rate of traded tokens " + pct(ev.odds.baseRate, 0) + ". Final Brier " + num(ev.odds.finalBrier, 3) + " ten-fold, " + num(ev.odds.finalWfBrier, 3) + " walk-forward (" + pct(ev.odds.walkForwardCorrect, 0) + " of walk-forward calls right), vs baseline " + num(ev.odds.baselineBrier, 3) + " / " + num(ev.odds.baselineWfBrier, 3) + ". Read the target honestly: these odds are the chance the token trades, not the chance DefiLlama writes a ticker down. Protocols whose ticker is recorded but whose token does not trade were left out of training, so the base rate here (" + pct(ev.odds.baseRate, 0) + ") is lower than a ticker-based model's — and the walk-forward score is steadier for it.";
  $("ev-range").innerHTML = ev.range.rows.map(function (r) {
    return "<tr><td>" + esc(r.label) + "</td><td>" + pct(r.stated, 0) + "</td><td>" + pct(r.loo, 0) + "</td><td>" + pct(r.wf, 0) + "</td></tr>";
  }).join("");
  $("ev-range-note").textContent = ev.range.note;
}

function filtered() {
  var list = R.rows.filter(function (r) {
    if (state.verdict !== "All" && r.verdict !== state.verdict) return false;
    if (state.tier !== "All" && tierOf(r) !== state.tier) return false;
    if (state.cat && r.category !== state.cat) return false;
    if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
    if (state.q) { var q = state.q.toLowerCase(); if ((r.name + " " + r.slug).toLowerCase().indexOf(q) < 0) return false; }
    return true;
  });
  var s = state.sort;
  list.sort(function (a, b) {
    if (s === "implied") return b.impliedValueUsd - a.impliedValueUsd;
    if (s === "tvl") return b.tvlUsd - a.tvlUsd;
    if (s === "net") return b.netPerHour - a.netPerHour;
    return a.rank - b.rank;
  });
  return list;
}
function renderBoard() {
  var list = filtered();
  var totTvl = list.reduce(function (s, r) { return s + r.tvlUsd; }, 0);
  var totImp = list.reduce(function (s, r) { return s + r.impliedValueUsd; }, 0);
  $("board-summary").textContent = list.length + " of " + R.rows.length + " rows · total TVL " + money(totTvl) + " · total implied " + money(totImp);
  var fl = $("farm-label");
  if (state.verdict === "FARM") {
    fl.hidden = false;
    fl.textContent = "Filtered to FARM verdict · sorted by net/hour · " + list.length + " rows · total TVL " + money(totTvl) + " · total implied " + money(totImp);
  } else fl.hidden = true;
  $("rows").innerHTML = list.map(function (r) {
    var d7 = r.change7d === null ? "—" : (r.change7d >= 0 ? "+" + num(r.change7d, 1) + "%" : num(r.change7d, 1) + "%");
    return '<tr data-slug="' + esc(r.slug) + '"><td>' + r.rank + '</td><td>' + money(r.bootstrapLow) + "–" + money(r.bootstrapHigh) + "</td><td><b>" + esc(r.name) + "</b><br><span style=\"color:#8fa1b3\">" + esc(r.category) + " · " + esc(r.chains.join(", ")) + "</span>" + (r.parentFactor ? ' <span class="parent-tag">Off-List · Parent ×0.48</span>' : "") + "</td><td>" + money(r.tvlUsd) + "</td><td class=\"" + (r.change7d === null ? "" : (r.change7d >= 0 ? "pos" : "neg")) + "\">" + d7 + "</td><td>" + (r.ageDays === null ? "—" : r.ageDays + "d") + "</td><td>" + pct(r.tokenOdds, 0) + "</td><td>" + money(r.valueIfLaunches) + "</td><td><b>" + money(r.impliedValueUsd) + "</b></td><td>" + money(r.p25) + " – " + money(r.p75) + "</td><td><span class=\"v" + r.verdict + "\">" + r.verdict + "</span> · " + money(r.netFees) + " net</td><td>" + money(r.netPerHour) + " / h</td></tr>";
  }).join("") || '<tr><td colspan="12">No rows match these filters.</td></tr>';
  document.querySelectorAll("#rows tr[data-slug]").forEach(function (tr) {
    tr.addEventListener("click", function () { openModal(tr.getAttribute("data-slug")); });
  });
}

function testedNotUsed() {
  // Terms tested and not used, kept separate per model: a term can be
  // kept in one model and not the other (7-day growth is kept by the
  // odds model but not by the value model), so one merged list would
  // mislabel it. Each list names only its own model's rejects.
  var value = [], odds = [];
  R.evidence.value.terms.forEach(function (t) {
    if (t.kept === "tested, not kept" && value.indexOf(t.name) < 0) value.push(t.name);
  });
  R.evidence.odds.terms.forEach(function (t) {
    if (t.kept === "tested, not kept" && odds.indexOf(t.name) < 0) odds.push(t.name);
  });
  return { value: value, odds: odds };
}
// Net of fees for a what-if deposit and drop share, from the row's own
// fields: the modelled drop scales with deposit, the fees do not.
function netAt(r, share, deposit) {
  if (r.tvlUsd <= 0) return -r.feesUsd;
  return Math.round(((r.impliedValueUsd * share * deposit) / r.tvlUsd - r.feesUsd) * 100) / 100;
}
function netGrid(r) {
  var shares = [0.035, 0.07, 0.14], deps = [1000, 3000, 10000, 30000];
  var head = "<tr><th>Drop share</th>" + deps.map(function (d) { return "<th>" + (d === r.depositUsd ? "Plan $" : "$") + d.toLocaleString("en-US") + "</th>"; }).join("") + "</tr>";
  var body = shares.map(function (s) {
    var cells = deps.map(function (d) {
      var v = netAt(r, s, d);
      var cls = (s === 0.07 && d === r.depositUsd) ? ' class="on"' : "";
      return "<td" + cls + ">" + money(v) + "</td>";
    }).join("");
    return "<tr><td>" + pct(s, 1) + "</td>" + cells + "</tr>";
  }).join("");
  return '<table class="matrix"><thead>' + head + "</thead><tbody>" + body + "</tbody></table>";
}
function openModal(slug) {
  var r = R.rows.filter(function (x) { return x.slug === slug; })[0];
  if (!r) return;
  var f = r.factors, tnu = testedNotUsed();
  var base = f.multiple / (f.size * f.category);
  var peers = r.peers.map(function (p) {
    return "<tr><td>" + esc(p.name) + "</td><td>" + esc(p.category) + "</td><td>" + money(p.tvl) + "</td><td>" + money(p.mcap) + "</td><td>" + num(p.ratio, 2) + "×</td><td>" + num(p.heldOut, 2) + "×</td></tr>";
  }).join("");
  var steps = r.farmPlan.map(function (s) {
    return "<li><b>" + s.n + ". " + esc(s.title) + "</b><span class=\"ct\">" + esc(s.cost) + " · " + esc(s.time) + "</span><br>" + esc(s.text) + "</li>";
  }).join("");
  var dep = $("dep").value, dr = $("drop").value, hor = $("hor").value;
  var tbill = r.depositUsd * 0.04 * (hor / 52);
  // Benchmarks, all from this row's own numbers: the T-bill on the
  // same deposit, the drop if a token launches (odds not applied),
  // the drop share and the odds above which the fees are covered, and
  // the TVL that triggers the exit rule.
  var dropIfLaunches = r.tvlUsd > 0 ? (r.valueIfLaunches * r.dropShare * r.depositUsd) / r.tvlUsd : 0;
  var shareFloor = r.impliedValueUsd > 0 && r.depositUsd > 0 ? (r.feesUsd * r.tvlUsd) / (r.impliedValueUsd * r.depositUsd) : 0;
  var oddsFloor = r.valueIfLaunches > 0 && r.depositUsd > 0 ? (r.feesUsd * r.tvlUsd) / (r.valueIfLaunches * r.dropShare * r.depositUsd) : 0;
  var exitTvl = 0.83 * r.tvlUsd;
  $("modal-body").innerHTML =
    "<h2>#" + r.rank + " — " + esc(r.name) + "</h2>" +
    "<p class=\"note\">" + esc(r.category) + " · " + esc(r.chains.join(", ")) + " · " + (r.ageDays === null ? "listed date unknown" : "listed " + r.ageDays + " days ago") + " · " + (r.watchlist ? "watchlist" : tierOf(r)) + (r.parentFactor ? " · parent product: " + esc(r.parentName) + " — implied value ×0.48" : "") + "</p>" +
    '<div class="mgrid"><div><span>TVL</span><b>' + money(r.tvlUsd) + '</b></div><div><span>7-day change</span><b>' + (r.change7d === null ? "—" : (r.change7d >= 0 ? "+" : "") + num(r.change7d, 1) + '%') + '</b></div><div><span>Token odds</span><b>' + pct(r.tokenOdds, 0) + '</b></div><div><span>Bootstrap range</span><b>' + money(r.bootstrapLow) + "–" + money(r.bootstrapHigh) + "</b></div></div>" +
    '<p class="big">' + money(r.impliedValueUsd) + ' implied value</p>' +
    "<p>If it launches: " + money(r.valueIfLaunches) + " · P25–P75 " + money(r.p25) + " – " + money(r.p75) + " · P10–P90 " + money(r.p10) + " – " + money(r.p90) + " · rank " + r.bootstrapRankLow + "–" + r.bootstrapRankHigh + " across 200 bootstrap refits.</p>" +
    "<h3>How the figure is made</h3><p>TVL " + money(r.tvlUsd) + " × base multiple " + num(base, 4) + "× × size factor " + num(f.size, 4) + " × category factor " + num(f.category, 2) + " = " + money(r.valueIfLaunches) + " if it launches. Base, size and category multiply once into the fitted multiple " + num(f.multiple, 4) + "× — the fitted multiple already holds all three, so they are never multiplied a second time. Times token odds " + pct(r.tokenOdds, 1) + (r.parentFactor ? " × parent factor 0.48" : "") + " = " + money(r.impliedValueUsd) + " implied" + (r.parentFactor ? ": " + esc(r.name) + " is a line of " + esc(r.parentName) + ", which already records a token, so only part of the launch value belongs to this line" : "") + ". Value terms tested and not used: " + (tnu.value.length ? esc(tnu.value.join(", ")) : "none") + ". Odds terms tested and not used: " + (tnu.odds.length ? esc(tnu.odds.join(", ")) : "none") + " — they did not beat the baseline out of sample in their own model, so they add no value here.</p>" +
    "<h3>Nearest priced peers</h3><table><thead><tr><th>Token</th><th>Category</th><th>TVL</th><th>Market cap</th><th>Cap / TVL</th><th>Model ÷ actual (LOO)</th></tr></thead><tbody>" + peers + "</tbody></table>" +
    '<p class="note">Cap / TVL is each peer\'s own market cap over its TVL — the ratio the model is fitted on. Model ÷ actual is the leave-one-out prediction for that peer over its real ratio: 1.00 means the model priced the peer exactly, 2.00 means it predicted twice the real cap. Peers are the nearest priced protocols in the same category by TVL.</p>' +
    "<h3>Farm verdict — " + r.verdict + "</h3><p>" + verdictText(r, tbill) + "</p>" +
    "<h3>Benchmarks</h3><p>Same " + money(r.depositUsd) + " in a 4% T-bill for " + r.horizonWeeks + " weeks → " + money(r.depositUsd * 0.04 * (r.horizonWeeks / 52)) + ". Drop if a token launches (odds not applied) → " + money(dropIfLaunches) + ". Fees are covered while the drop share stays above " + pct(shareFloor, 1) + " (model 7.0%) and the token odds above " + pct(oddsFloor, 1) + " (peers imply " + pct(r.tokenOdds, 1) + "). Exit if TVL prints below " + money(exitTvl) + " (−17% from today's " + money(r.tvlUsd) + ").</p>" +
    "<h3>Net by drop share × deposit</h3>" + netGrid(r) +
    '<p class="note">Net of fees for each drop share and deposit. Fees stay fixed — the plan\'s transactions do not depend on size — and deposits above the $10,000 plan cap are what-if only. The highlighted cell is this row\'s own plan.</p>' +
    "<h3>Farm plan · 10 steps</h3><ol class=\"steps\">" + steps + "</ol>" +
    "<h3>Exit rule</h3><p>" + esc(r.exitRule) + "</p>" +
    "<p class=\"note\">Scenario shown: $" + dep + " deposit · " + dr + "% drop share · " + hor + " weeks. The verdict above is costed on the row's own plan, not on this scenario selector.</p>";
  $("modal-back").hidden = false;
}
function verdictText(r, tbill) {
  var base = "Deposit " + money(r.depositUsd) + " · expected drop " + money(r.dropUsd) + " · fees " + money(r.feesUsd) + " · net " + money(r.netFees) + " over " + r.handsOnHours + " hands-on hours = " + money(r.netPerHour) + " / hour, vs T-bill on the same deposit (" + money(tbill) + ") plus $25 / hour for your time. ";
  if (r.verdict === "FARM") return base + "Net clears both bars — worth farming.";
  if (r.verdict === "MARGINAL") return base + "Net clears one bar at best — farm only if the hours are already spare.";
  return base + "Net does not clear the bars — skip; the hours earn more elsewhere.";
}
function closeModal() { $("modal-back").hidden = true; }

function download(name, text, type) {
  var b = new Blob([text], { type: type });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(b); a.download = name; a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 500);
}
function exportCSV() {
  var head = "rank,slug,name,category,chains,tvlUsd,change7d,ageDays,tokenOdds,valueIfLaunches,impliedValueUsd,p25,p75,verdict,netFees,netPerHour";
  var lines = filtered().map(function (r) {
    return [r.rank, r.slug, '"' + r.name + '"', r.category, '"' + r.chains.join(";") + '"', r.tvlUsd, r.change7d, r.ageDays, r.tokenOdds, r.valueIfLaunches, r.impliedValueUsd, r.p25, r.p75, r.verdict, r.netFees, r.netPerHour].join(",");
  });
  download("radar-7-board.csv", head + "\n" + lines.join("\n"), "text/csv");
}
function exportJSON() {
  download("radar-7-board.json", JSON.stringify(filtered(), null, 2), "application/json");
}
function scenarioNote() {
  $("scenario-note").textContent = "Scenario: $" + $("dep").value + " deposit · " + $("drop").value + "% drop · " + $("hor").value + " weeks — display only; verdicts are costed on each row's own plan.";
}
function resetAll() {
  state = { verdict: "All", tier: "All", q: "", cat: "", chain: "", sort: "rank" };
  $("q").value = ""; $("cat").value = ""; $("chain").value = ""; $("sort").value = "rank";
  document.querySelectorAll("#seg-verdict button").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-v") === "All"); });
  document.querySelectorAll("#seg-tier button").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-t") === "All"); });
  renderBoard();
}
function init() {
  if (!R || !R.rows) { document.body.innerHTML = "<p>data.js missing or empty — window.RADAR not found.</p>"; return; }
  var cats = [], chains = [];
  R.rows.forEach(function (r) {
    if (cats.indexOf(r.category) < 0) cats.push(r.category);
    r.chains.forEach(function (c) { if (chains.indexOf(c) < 0) chains.push(c); });
  });
  cats.sort().forEach(function (c) { $("cat").add(new Option(c, c)); });
  chains.sort().forEach(function (c) { $("chain").add(new Option(c, c)); });
  document.querySelectorAll("#seg-verdict button").forEach(function (b) {
    b.addEventListener("click", function () {
      state.verdict = b.getAttribute("data-v");
      document.querySelectorAll("#seg-verdict button").forEach(function (x) { x.classList.toggle("on", x === b); });
      if (state.verdict === "FARM") state.sort = "net";
      renderBoard();
    });
  });
  document.querySelectorAll("#seg-tier button").forEach(function (b) {
    b.addEventListener("click", function () {
      state.tier = b.getAttribute("data-t");
      document.querySelectorAll("#seg-tier button").forEach(function (x) { x.classList.toggle("on", x === b); });
      renderBoard();
    });
  });
  $("q").addEventListener("input", function () { state.q = $("q").value; renderBoard(); });
  $("cat").addEventListener("change", function () { state.cat = $("cat").value; renderBoard(); });
  $("chain").addEventListener("change", function () { state.chain = $("chain").value; renderBoard(); });
  $("sort").addEventListener("change", function () { state.sort = $("sort").value; renderBoard(); });
  $("reset").addEventListener("click", resetAll);
  $("csv").addEventListener("click", exportCSV);
  $("json").addEventListener("click", exportJSON);
  ["dep", "drop", "hor"].forEach(function (id) { $(id).addEventListener("change", scenarioNote); });
  $("modal-close").addEventListener("click", closeModal);
  $("modal-back").addEventListener("click", function (e) { if (e.target === $("modal-back")) closeModal(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModal(); });
  scenarioNote();
  renderKpis(); renderAccounting(); renderIntegrity(); renderEvidence(); renderBoard();
}
init();
