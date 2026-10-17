const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The live bank view. It polls /api/nessie every second and animates anything
 * that changed, so a transfer made from the group chat is visible across the
 * room. Every dynamic string is written with textContent, never innerHTML.
 */
export function nessiePage(agentName: string): string {
  const name = escapeHtml(agentName);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} · Live bank</title>
<style>
:root {
  --bg: #f4f3ef;
  --card: #ffffff;
  --text: #1c1c1e;
  --muted: #6b6b70;
  --line: #e2e0da;
  --field: #fafaf8;
  --accent: #0a7cff;
  --accent-soft: #e6f1ff;
  --up: #1d7a35;
  --up-bg: #e9f6ec;
  --down: #c4291c;
  --down-bg: #fdecea;
  --warn: #8a5a00;
  --warn-bg: #fff3d6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #101012;
    --card: #1b1b1e;
    --text: #f2f2f5;
    --muted: #a3a3aa;
    --line: #2f2f35;
    --field: #232328;
    --accent: #3a93ff;
    --accent-soft: #15283f;
    --up: #7ddc92;
    --up-bg: #16281b;
    --down: #ff8a80;
    --down-bg: #3a1a18;
    --warn: #f5c451;
    --warn-bg: #33290f;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
main { max-width: 1040px; margin: 0 auto; padding: 32px 16px 64px; }
header { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px; margin-bottom: 8px; }
.brand { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; color: var(--accent); }
.brand svg { width: 22px; height: 22px; }
.pill { font-size: 13px; font-weight: 600; padding: 3px 10px; border-radius: 999px; background: var(--warn-bg); color: var(--warn); }
.live { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; font-size: 14px; color: var(--muted); }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); }
.live.on .dot { background: var(--up); animation: pulse 2s infinite; }
@keyframes pulse { 50% { opacity: 0.35; } }
a { color: var(--accent); text-decoration: none; font-weight: 600; }
a:hover { text-decoration: underline; }
h1 { font-size: 30px; line-height: 1.15; letter-spacing: -0.02em; margin: 12px 0 4px; }
.sub { color: var(--muted); margin: 0 0 24px; }
.panel { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 18px 20px; }
.banner { margin-bottom: 16px; }
.banner .title { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; font-weight: 600; font-size: 18px; }
.bar { height: 8px; border-radius: 999px; background: var(--field); border: 1px solid var(--line); margin-top: 12px; overflow: hidden; }
.bar > i { display: block; height: 100%; width: 0; background: var(--up); transition: width 0.6s ease; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; margin-bottom: 16px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 18px; transition: box-shadow 0.4s, border-color 0.4s; }
.card.flash-up { border-color: var(--up); box-shadow: 0 0 0 4px var(--up-bg); }
.card.flash-down { border-color: var(--down); box-shadow: 0 0 0 4px var(--down-bg); }
.card .top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.card .who { font-weight: 600; font-size: 18px; overflow-wrap: anywhere; }
.badge { font-size: 12px; font-weight: 700; padding: 2px 8px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); white-space: nowrap; }
.acct { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
.balance { font-size: 40px; line-height: 1.1; font-weight: 700; letter-spacing: -0.02em; margin: 14px 0 4px; font-variant-numeric: tabular-nums; }
.delta { height: 20px; font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
.delta.up { color: var(--up); }
.delta.down { color: var(--down); }
.meta { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); font-size: 14px; color: var(--muted); display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 8px; }
.chip { font-size: 13px; font-weight: 600; padding: 2px 8px; border-radius: 8px; background: var(--field); color: var(--muted); }
.chip.ok { background: var(--up-bg); color: var(--up); }
.chip.bad { background: var(--down-bg); color: var(--down); }
.chip.wait { background: var(--warn-bg); color: var(--warn); }
.cols { display: grid; grid-template-columns: 1fr; gap: 16px; }
@media (min-width: 860px) { .cols { grid-template-columns: 1fr 2fr; } }
h2 { font-size: 17px; margin: 0 0 12px; }
.big { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; }
.note { color: var(--muted); font-size: 14px; margin: 6px 0 0; }
ul.log { list-style: none; margin: 0; padding: 0; max-height: 420px; overflow: auto; }
ul.log li { display: grid; grid-template-columns: 64px 1fr auto; gap: 4px 12px; align-items: baseline; padding: 10px 0; border-top: 1px solid var(--line); }
ul.log li:first-child { border-top: 0; }
ul.log li.new { animation: slide 0.6s ease; }
@keyframes slide { from { opacity: 0; transform: translateY(-8px); background: var(--accent-soft); } }
.time { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
.amt { font-weight: 700; font-variant-numeric: tabular-nums; }
.empty { color: var(--muted); padding: 8px 0; }
[hidden] { display: none !important; }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
@media (max-width: 480px) { h1 { font-size: 25px; } .balance { font-size: 34px; } ul.log li { grid-template-columns: 56px 1fr; } .amt { grid-column: 2; } }
</style>
</head>
<body>
<main>
  <header>
    <span class="brand">
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3C6.5 3 2 6.9 2 11.6c0 2.6 1.4 4.9 3.6 6.5-.2 1.3-.8 2.6-1.8 3.6 2 0 3.8-.8 5-1.9 1 .3 2.1.4 3.2.4 5.5 0 10-3.9 10-8.6S17.5 3 12 3Z"/></svg>
      ${name}
    </span>
    <span class="pill" id="mode">Sandbox · demo money</span>
    <a href="/">Start a group chat</a>
    <span class="live" id="live"><span class="dot"></span><span id="live-text">Connecting…</span></span>
  </header>
  <h1>Live bank</h1>
  <p class="sub">Balances and transfers update the moment ${name} acts in the group chat. Nothing here is real money.</p>

  <section class="panel banner" id="split" hidden>
    <div class="title"><span id="split-title"></span><span id="split-count"></span></div>
    <div class="bar"><i id="split-bar"></i></div>
  </section>

  <section class="grid" id="members" aria-live="polite"></section>

  <div class="cols">
    <section class="panel">
      <h2>Trip budget</h2>
      <div id="budget"><p class="empty">Waiting for balances…</p></div>
    </section>
    <section class="panel">
      <h2>Transfer log</h2>
      <ul class="log" id="log"></ul>
      <p class="empty" id="log-empty">Nothing yet. Ask ${name} in the chat: "@${name} I'll pay 480".</p>
    </section>
  </div>
</main>

<script>
(function () {
  var members = document.getElementById("members");
  var logList = document.getElementById("log");
  var cards = {};
  var shown = {};
  var seenLog = null;
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function usd(n) { return "$" + Math.round(n).toLocaleString("en-US"); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function tween(node, from, to) {
    if (reduced || from === to) { node.textContent = usd(to); return; }
    var start = performance.now(), ms = 900;
    function frame(now) {
      var t = Math.min(1, (now - start) / ms);
      var eased = 1 - Math.pow(1 - t, 3);
      node.textContent = usd(from + (to - from) * eased);
      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function card(m) {
    var c = cards[m.name];
    if (c) return c;
    var root = el("article", "card");
    var top = el("div", "top");
    var who = el("span", "who");
    var badge = el("span", "badge", "Payer");
    top.appendChild(who); top.appendChild(badge);
    var acct = el("div", "acct");
    var bal = el("div", "balance", "$0");
    var delta = el("div", "delta");
    var meta = el("div", "meta");
    var cap = el("span");
    var chip = el("span", "chip");
    meta.appendChild(cap); meta.appendChild(chip);
    [top, acct, bal, delta, meta].forEach(function (n) { root.appendChild(n); });
    members.appendChild(root);
    c = cards[m.name] = { root: root, who: who, badge: badge, acct: acct, bal: bal, delta: delta, cap: cap, chip: chip, timer: null };
    return c;
  }

  function renderMember(m, split) {
    var c = card(m);
    c.who.textContent = m.name;
    c.badge.hidden = !m.isPayer;
    c.acct.textContent = m.account;
    c.cap.textContent = m.cap === null ? "Budget unavailable" : "Can spend up to " + usd(m.cap);
    if (m.isPayer) { c.chip.className = "chip ok"; c.chip.textContent = split && split.phase === "paid" ? "Paid back in full" : "Collecting"; }
    else if (m.share === null) { c.chip.className = "chip"; c.chip.textContent = "Not in a split"; }
    else if (m.sent) { c.chip.className = "chip ok"; c.chip.textContent = "Sent " + usd(m.share); }
    else if (m.canAfford === false) { c.chip.className = "chip bad"; c.chip.textContent = "Owes " + usd(m.share) + " · short"; }
    else { c.chip.className = "chip wait"; c.chip.textContent = "Owes " + usd(m.share); }

    if (m.balance === null) { c.bal.textContent = "—"; return; }
    var before = shown[m.name];
    if (before === undefined) { c.bal.textContent = usd(m.balance); }
    else if (before !== m.balance) {
      tween(c.bal, before, m.balance);
      var diff = m.balance - before;
      c.delta.className = "delta " + (diff > 0 ? "up" : "down");
      c.delta.textContent = (diff > 0 ? "+" : "−") + usd(Math.abs(diff));
      c.root.classList.remove("flash-up", "flash-down");
      void c.root.offsetWidth;
      c.root.classList.add(diff > 0 ? "flash-up" : "flash-down");
      clearTimeout(c.timer);
      c.timer = setTimeout(function () {
        c.root.classList.remove("flash-up", "flash-down");
        c.delta.textContent = "";
      }, 4000);
    }
    shown[m.name] = m.balance;
  }

  function renderSplit(split) {
    var box = document.getElementById("split");
    box.hidden = !split;
    if (!split) return;
    document.getElementById("split-title").textContent =
      split.phase === "paid"
        ? "All settled: everyone paid " + split.payer
        : split.payer + " is paying " + usd(split.total) + " · " + usd(split.perPerson) + " each";
    document.getElementById("split-count").textContent = split.sent + " of " + split.of + " shares sent";
    document.getElementById("split-bar").style.width = (split.of > 0 ? (split.sent / split.of) * 100 : 0) + "%";
  }

  function renderBudget(data) {
    var box = document.getElementById("budget");
    box.textContent = "";
    if (!data.budget) { box.appendChild(el("p", "empty", "Waiting for balances…")); return; }
    box.appendChild(el("div", "big", usd(data.budget.perPerson) + " each"));
    box.appendChild(el("p", "note", usd(data.budget.group) + " for the group, set by " + data.budget.limitedBy + "'s balance."));
    box.appendChild(el("p", "note", "Each person's limit is " + Math.round(data.capFraction * 100) + "% of their balance."));
  }

  function clock(iso) {
    return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
  }

  function renderLog(activity) {
    document.getElementById("log-empty").hidden = activity.length > 0;
    var fresh = seenLog === null ? new Set() : new Set(activity.filter(function (a) { return a.id > seenLog; }).map(function (a) { return a.id; }));
    logList.textContent = "";
    activity.forEach(function (a) {
      var li = el("li", fresh.has(a.id) ? "new" : "");
      li.appendChild(el("span", "time", clock(a.at)));
      li.appendChild(el("span", "", a.detail));
      var right = el("span", "amt");
      if (a.status === "failed") { right.className = "chip bad"; right.textContent = "Failed"; }
      else if (a.kind === "transfer") { right.className = "chip ok"; right.textContent = usd(a.amount || 0); }
      else if (a.amount !== null) right.textContent = usd(a.amount);
      li.appendChild(right);
      logList.appendChild(li);
    });
    if (activity.length > 0) seenLog = Math.max(seenLog || 0, activity[0].id);
    else if (seenLog === null) seenLog = 0;
  }

  function setLive(ok) {
    document.getElementById("live").className = "live" + (ok ? " on" : "");
    document.getElementById("live-text").textContent = ok ? "Live" : "Reconnecting…";
  }

  function render(data) {
    document.getElementById("mode").textContent = (data.bank === "nessie" ? "Capital One Nessie sandbox" : "Mock bank") + " · demo money";
    var names = {};
    data.members.forEach(function (m) { names[m.name] = true; renderMember(m, data.split); });
    Object.keys(cards).forEach(function (n) { if (!names[n]) { cards[n].root.remove(); delete cards[n]; delete shown[n]; } });
    renderSplit(data.split);
    renderBudget(data);
    renderLog(data.activity);
  }

  function tick() {
    fetch("/api/nessie", { cache: "no-store" })
      .then(function (res) { if (!res.ok) throw new Error("bad status"); return res.json(); })
      .then(function (data) { render(data); setLive(true); })
      .catch(function () { setLive(false); })
      .finally(function () { setTimeout(tick, 1000); });
  }
  tick();
})();
</script>
</body>
</html>
`;
}
