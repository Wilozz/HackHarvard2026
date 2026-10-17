const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** A JSON literal that's safe inside <script>. */
const scriptValue = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

/** The signup page: everyone's name and number in, one iMessage group chat out. */
export function signupPage(agentName: string, maxMembers: number): string {
  const name = escapeHtml(agentName);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} · Start a trip chat</title>
<style>
:root {
  --bg: #f4f3ef;
  --card: #ffffff;
  --text: #1c1c1e;
  --muted: #6b6b70;
  --line: #e2e0da;
  --field: #fafaf8;
  --accent: #0a7cff;
  --accent-hover: #0064d6;
  --on-accent: #ffffff;
  --error: #c4291c;
  --error-bg: #fdecea;
  --ok: #1d7a35;
  --ok-bg: #e9f6ec;
  --focus: rgba(10, 124, 255, 0.28);
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
    --accent-hover: #5ca6ff;
    --on-accent: #ffffff;
    --error: #ff8a80;
    --error-bg: #3a1a18;
    --ok: #7ddc92;
    --ok-bg: #16281b;
    --focus: rgba(58, 147, 255, 0.35);
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
main { max-width: 560px; margin: 0 auto; padding: 56px 16px 72px; }
.brand { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; color: var(--accent); margin-bottom: 20px; }
.brand svg { width: 22px; height: 22px; }
h1 { font-size: 32px; line-height: 1.15; letter-spacing: -0.02em; margin: 0 0 10px; }
.lede { color: var(--muted); margin: 0 0 28px; font-size: 17px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 24px; }
.field { display: block; margin-bottom: 24px; }
.label { display: block; font-weight: 600; margin-bottom: 6px; }
.label em { font-style: normal; font-weight: 400; color: var(--muted); }
input[type="text"], input[type="tel"] {
  width: 100%;
  font: inherit;
  color: inherit;
  background: var(--field);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px 12px;
  min-width: 0;
}
input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--focus); }
fieldset { border: 0; margin: 0 0 20px; padding: 0; }
legend { padding: 0; }
.hint { color: var(--muted); font-size: 14px; margin: 0 0 12px; }
.person { display: grid; grid-template-columns: 1fr 1.3fr 36px; gap: 8px; margin-bottom: 8px; }
.remove {
  border: 0; background: transparent; color: var(--muted); font-size: 22px; line-height: 1;
  border-radius: 8px; cursor: pointer;
}
.remove:hover { background: var(--field); color: var(--text); }
.link { border: 0; background: transparent; color: var(--accent); font: inherit; font-weight: 600; padding: 6px 0; cursor: pointer; }
.link:hover { color: var(--accent-hover); }
.check { display: flex; gap: 10px; align-items: flex-start; margin: 4px 0 20px; font-size: 15px; }
.check input { width: 18px; height: 18px; margin: 2px 0 0; accent-color: var(--accent); flex: none; }
.primary {
  width: 100%; border: 0; border-radius: 12px; padding: 13px 16px;
  background: var(--accent); color: var(--on-accent); font: inherit; font-weight: 600; cursor: pointer;
}
.primary:hover { background: var(--accent-hover); }
.primary:disabled { opacity: 0.6; cursor: progress; }
.error { background: var(--error-bg); color: var(--error); border-radius: 10px; padding: 10px 12px; margin: 0 0 16px; font-size: 15px; }
.done { text-align: center; padding: 36px 24px; }
.done .tick { width: 52px; height: 52px; border-radius: 50%; background: var(--ok-bg); color: var(--ok); display: grid; place-items: center; margin: 0 auto 16px; }
.done h2 { margin: 0 0 8px; font-size: 24px; }
.done p { margin: 0 0 12px; }
[hidden] { display: none !important; }
@media (max-width: 480px) {
  main { padding-top: 32px; }
  h1 { font-size: 27px; }
  .card { padding: 18px; }
  .person { grid-template-columns: 1fr 36px; }
  .person .name { grid-column: 1 / -1; }
  .person .phone { grid-column: 1; }
  .person { padding-bottom: 8px; border-bottom: 1px solid var(--line); margin-bottom: 12px; }
}
</style>
</head>
<body>
<main>
  <div class="brand">
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3C6.5 3 2 6.9 2 11.6c0 2.6 1.4 4.9 3.6 6.5-.2 1.3-.8 2.6-1.8 3.6 2 0 3.8-.8 5-1.9 1 .3 2.1.4 3.2.4 5.5 0 10-3.9 10-8.6S17.5 3 12 3Z"/></svg>
    ${name}
  </div>
  <h1>Start your trip chat</h1>
  <p class="lede">Add everyone who's coming. ${name} starts an iMessage group with all of you and suggests a trip that works for the whole group.</p>

  <form id="signup" class="card" novalidate>
    <label class="field">
      <span class="label">What are you planning? <em>Optional</em></span>
      <input type="text" id="title" maxlength="80" placeholder="Spring break 2027" autocomplete="off">
    </label>

    <fieldset>
      <legend class="label">Who's in?</legend>
      <p class="hint">Include the country code, like +61 for Australia. US and Canadian numbers can skip the +1.</p>
      <div id="people"></div>
      <button type="button" id="add" class="link">+ Add someone</button>
    </fieldset>

    <label class="check">
      <input type="checkbox" id="consent">
      <span>Everyone on this list agreed to be added to a group chat with ${name}.</span>
    </label>

    <p id="error" class="error" role="alert" hidden></p>
    <button type="submit" id="submit" class="primary">Start the group chat</button>
  </form>

  <section id="done" class="card done" hidden aria-live="polite">
    <div class="tick"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
    <h2>Check your Messages</h2>
    <p id="done-text"></p>
    <p class="hint">Mention @${name} in the chat whenever you want a trip idea.</p>
    <button type="button" id="again" class="link">Start another group</button>
  </section>
</main>

<template id="row">
  <div class="person">
    <input type="text" class="name" maxlength="40" placeholder="Name" autocomplete="off" aria-label="Name">
    <input type="tel" class="phone" placeholder="+1 617 555 0101" autocomplete="off" aria-label="Phone number">
    <button type="button" class="remove" aria-label="Remove this person">&times;</button>
  </div>
</template>

<script>
(function () {
  var AGENT = ${scriptValue(agentName)};
  var MAX = ${scriptValue(maxMembers)};
  var form = document.getElementById("signup");
  var people = document.getElementById("people");
  var template = document.getElementById("row");
  var addButton = document.getElementById("add");
  var submit = document.getElementById("submit");
  var errorBox = document.getElementById("error");
  var done = document.getElementById("done");

  function sync() {
    var rows = people.children;
    for (var i = 0; i < rows.length; i++) rows[i].querySelector(".name").placeholder = i === 0 ? "Your name" : "Name";
    addButton.hidden = rows.length >= MAX;
  }

  function addRow() {
    if (people.children.length >= MAX) return null;
    var row = template.content.firstElementChild.cloneNode(true);
    row.querySelector(".remove").addEventListener("click", function () {
      if (people.children.length > 2) row.remove();
      else {
        row.querySelector(".name").value = "";
        row.querySelector(".phone").value = "";
      }
      sync();
    });
    people.appendChild(row);
    sync();
    return row;
  }

  function reset() {
    form.reset();
    people.innerHTML = "";
    for (var i = 0; i < 3; i++) addRow();
  }

  function listNames(names) {
    return names.length <= 1 ? names.join("") : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  addButton.addEventListener("click", function () {
    var row = addRow();
    if (row) row.querySelector(".name").focus();
  });

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    errorBox.hidden = true;
    var members = Array.prototype.map.call(people.children, function (row) {
      return { name: row.querySelector(".name").value, phone: row.querySelector(".phone").value };
    });
    submit.disabled = true;
    submit.textContent = "Starting the chat…";
    fetch("/api/groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: document.getElementById("title").value, consent: document.getElementById("consent").checked, members: members })
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");
          return data;
        });
      })
      .then(function (data) {
        var text = AGENT + (data.agentPhone ? " (" + data.agentPhone + ")" : "") + " just texted " + listNames(data.names) + ".";
        if (data.existing) text = "You already have a group chat with " + listNames(data.names) + ", so " + AGENT + " didn't send a second welcome. Names are updated.";
        document.getElementById("done-text").textContent = text;
        form.hidden = true;
        done.hidden = false;
      })
      .catch(function (err) {
        showError(err instanceof TypeError ? "Couldn't reach the server. Is the agent running?" : err.message);
      })
      .finally(function () {
        submit.disabled = false;
        submit.textContent = "Start the group chat";
      });
  });

  document.getElementById("again").addEventListener("click", function () {
    reset();
    done.hidden = true;
    form.hidden = false;
  });

  reset();
})();
</script>
</body>
</html>
`;
}
