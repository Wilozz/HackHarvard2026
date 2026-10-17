// Orbit through the Photon loop: brief → "ship it" → build → link → v2.
// Photon, Claude, the browser check and the host are all fakes.
import assert from "node:assert/strict";
import { test } from "node:test";

const { mkdtempSync: mkTmp } = await import("node:fs");
const { tmpdir: tmp } = await import("node:os");
const { join: joinPath } = await import("node:path");
Object.assign(process.env, {
  // Image cache and app files go to a temp folder, never data/.
  ORBIT_APPS_DIR: joinPath(mkTmp(joinPath(tmp(), "orbit-test-")), "apps"),
  PLATFORM: "terminal",
  PHOTON_AGENT_USER_ID: "",
  AGENT_NAME: "Orbit",
  PGLITE_DIR: "memory://",
  DATABASE_URL: "",
  DEBUG_PORT: "0",
  ORBIT_ALLOWED: "",
  ORBIT_CONFIRM_EDITS: "false",
});

const { PhotonAgent } = await import("../src/photon/agent");
const { GroupRegistry } = await import("../src/photon/groups");
const { OrbitService, parseOrbitCommand, isShipIt } = await import("../src/orbit/service");
const { OrbitStore } = await import("../src/orbit/store");
const { extractHtml } = await import("../src/orbit/builder");
const { mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
type Member = import("../src/members").Member;
type PhotonApi = import("../src/photon/api").PhotonApi;
type PhotonMessage = import("../src/photon/api").PhotonMessage;
type SendTextArgs = import("../src/photon/api").SendTextArgs;
type GenerateArgs = import("../src/orbit/builder").GenerateArgs;
type Project = import("../src/orbit/store").Project;

const WILSON: Member = { name: "Wilson", handles: ["+61452598886"], startBalance: 0 };
const HARSH: Member = { name: "Harsh", handles: ["+15513318011"], startBalance: 0 };
const STRANGER = { name: "Stranger", handles: ["+19995550123"] };

class FakePhoton implements PhotonApi {
  messages: PhotonMessage[] = [];
  sent: SendTextArgs[] = [];
  private clock = 0;
  private next = 0;
  addPhoto(from: { name: string; handles: string[] }, id: string, data: Buffer): PhotonMessage {
    const m = this.add(from, "");
    m.content = { type: "attachment", attachmentId: id };
    this.attachments.set(id, data);
    return m;
  }
  add(from: { name: string; handles: string[] }, text: string): PhotonMessage {
    this.clock = Math.max(this.clock + 1000, Date.now());
    const m: PhotonMessage = {
      id: `pho_msg_${++this.next}`,
      platform: "imessage",
      status: "received",
      createdAt: new Date(this.clock).toISOString(),
      space: { id: "pho_spc_group", kind: "group", participantIds: ["pho_usr_agent"] },
      sentBy: { id: `pho_usr_${from.name}`, kind: "human", handle: from.handles[0]! },
      content: { type: "text", format: "plain", text },
    };
    this.messages.push(m);
    return m;
  }
  async *listMessages(q: { createdSince?: string }) {
    yield* this.messages.filter((m) => !q.createdSince || m.createdAt >= q.createdSince);
  }
  async getMessage(id: string) {
    return this.messages.find((m) => m.id === id)!;
  }
  async listAgents() {
    return [{ id: "pho_usr_agent", kind: "agent", handle: "+16285550000", details: { type: "dedicated" } }];
  }
  async createUser(): Promise<never> {
    throw new Error("unused");
  }
  async createSpace(): Promise<never> {
    throw new Error("unused");
  }
  async sendText(args: SendTextArgs) {
    this.sent.push(args);
    // Photon stamps our sends on the same clock as everything else.
    this.clock = Math.max(this.clock + 1000, Date.now());
    return { id: `pho_msg_out${this.sent.length}`, status: "dispatched", createdAt: new Date(this.clock).toISOString() } as PhotonMessage;
  }
  async setTyping() {}
  async downloadAttachment(id: string) {
    const data = this.attachments.get(id);
    if (!data) throw new Error(`no attachment ${id}`);
    return { contentType: "image/png", data };
  }
  attachments = new Map<string, Buffer>();
}

function setup(opts: { qualityErrors?: string[][]; failBuild?: boolean; repos?: ConstructorParameters<typeof OrbitService>[5]; repoPlan?: (request: string) => Awaited<ReturnType<typeof import("../src/orbit/repoPlan").writeRepoPlan>> } = {}) {
  const api = new FakePhoton();
  const generated: GenerateArgs[] = [];
  const specs: { title: string; brief: string; transcript: string; images?: { label: string }[] }[] = [];
  const briefImages: string[][] = [];
  const briefTranscripts: string[] = [];
  const published: { project: string; n: number; html: string }[] = [];
  const qualityRuns = [...(opts.qualityErrors ?? [])];
  const store = new OrbitStore(null, mkdtempSync(join(tmpdir(), "orbit-")));
  const orbit = new OrbitService(
    store,
    {
      name: "local",
      async publish(project: Project, n: number, html: string) {
        published.push({ project: project.id, n, html });
        return { url: `https://3000-sbx.example/v${n}/` };
      },
    },
    [WILSON, HARSH],
    new GroupRegistry(),
    {
      writeBrief: async ({ request, apps, images, transcript }) => {
        briefImages.push((images ?? []).map((i) => i.label));
        briefTranscripts.push(transcript);
        if (/joke/i.test(request)) return { action: "reply", title: "", projectId: "", brief: "", reply: "I build small web apps." };
        const named = apps?.find((a) => request.toLowerCase().includes(a.title.toLowerCase().split(" ")[0]!));
        const current = apps?.find((a) => a.current);
        if (/\bnew\b/i.test(request) || !(named ?? current)) {
          return { action: "build", title: /snake/i.test(request) ? "Neon Snake" : "Cat Flap", projectId: "", brief: `A flappy game: ${request}`, reply: "" };
        }
        const t = named ?? current!;
        return { action: "edit", title: t.title, projectId: t.id, brief: `Change: ${request}`, reply: "" };
      },
      writeSpec: async ({ title, brief, transcript, images }) => {
        specs.push({ title, brief, transcript, images });
        return `SPEC for ${title}: ${brief}`;
      },
      generateApp: async (args) => {
        generated.push(args);
        if (opts.failBuild) throw new Error("model declined the request");
        // Like the real builder: refer to photos only by their placeholders, and keep any that were already there.
        const photos = (args.images ?? []).map((_, i) => `<img src="ORBIT_IMAGE_${i + 1}">`).join("");
        const kept = args.previousHtml?.match(/<img src="ORBIT_IMAGE_\d+">/g)?.join("") ?? "";
        return `<!doctype html><html><body>${args.brief}${args.errors ? " (fixed)" : ""}${args.previousHtml ? kept : photos}</body></html>`;
      },
      checkApp: async () => ({ ran: true, errors: qualityRuns.shift() ?? [] }),
      writeRepoPlan: async ({ request }) => opts.repoPlan!(request),
    },
    opts.repos,
  );
  const agent = new PhotonAgent(api, [WILSON, HARSH], {
    brain: { suggestTrip: async () => "unused" },
    memory: { store: async () => {}, context: async () => ({ transcript: "", debug: [] }), forget: async () => {}, cutoffs: async () => new Map() },
    replySpaces: new Map(),
    groups: new GroupRegistry(),
    orbit,
  });
  const step = async () => {
    await agent.poll();
    await agent.idle();
    await orbit.idle();
  };
  const texts = () => api.sent.map((s) => s.text);
  return { api, agent, orbit, store, generated, published, specs, briefImages, briefTranscripts, step, texts };
}

test("parses Orbit commands", () => {
  assert.deepEqual(parseOrbitCommand("ship it!"), { kind: "ship" });
  assert.deepEqual(parseOrbitCommand("versions"), { kind: "versions" });
  assert.deepEqual(parseOrbitCommand("never mind"), { kind: "cancel" });
  assert.deepEqual(parseOrbitCommand(""), { kind: "help" });
  assert.deepEqual(parseOrbitCommand("make snake"), { kind: "request", text: "make snake" });
  assert.ok(isShipIt("Ship it."));
  assert.ok(!isShipIt("ship it to my mom later"));
  assert.equal(extractHtml("Sure!\n```html\n<!doctype html><html>x</html>\n```"), "<!doctype html><html>x</html>");
  assert.throws(() => extractHtml("no html here"));
});

test("brief, ship it, link, then an edit posts v2 at its own link", async () => {
  const { api, agent, store, generated, published, specs, step, texts } = setup();
  await agent.start();

  api.add(HARSH, "lol we need a game");
  api.add(WILSON, "@Orbit make flappy bird with a cat");
  await step();
  assert.equal(texts().length, 1);
  assert.match(texts()[0]!, /^Here's the plan for Cat Flap \(v1\):\n\nA flappy game: make flappy bird with a cat\n\nReply "ship it"/);
  assert.equal(generated.length, 0, "nothing builds before ship it");

  api.add(HARSH, "ship it");
  await step();
  assert.match(texts()[1]!, /^Building Cat Flap/);
  assert.match(texts()[2]!, /^v1 of Cat Flap is live: https:\/\/3000-sbx\.example\/v1\//);
  assert.equal(published[0]!.n, 1);
  // v1 is built from a design spec written from the whole chat, not just the brief.
  assert.equal(specs.length, 1);
  assert.match(specs[0]!.transcript, /Harsh: lol we need a game/);
  // It was started from the request, before anyone said ship it.
  assert.doesNotMatch(specs[0]!.transcript, /ship it/);
  assert.equal(generated[0]!.spec, "SPEC for Cat Flap: A flappy game: make flappy bird with a cat");

  api.add(HARSH, "@Orbit make the cat faster");
  await step();
  assert.match(texts()[3]!, /^On it: v2 of Cat Flap\. Change: make the cat faster/);
  assert.match(texts()[4]!, /^v2 of Cat Flap is live: https:\/\/3000-sbx\.example\/v2\//);
  // The edit was made on top of v1's HTML, without a new spec.
  assert.match(generated[1]!.previousHtml!, /A flappy game/);
  assert.equal(generated[1]!.spec, undefined);
  assert.equal(specs.length, 1);

  api.add(WILSON, "@Orbit versions");
  await step();
  assert.equal(texts()[5], "Cat Flap v1: https://3000-sbx.example/v1/\nCat Flap v2: https://3000-sbx.example/v2/");

  const chat = store.chat("imessage:pho_spc_group");
  assert.deepEqual(chat.projects[0]!.versions.map((v) => [v.n, v.status, v.requestedBy]), [[1, "live", "Wilson"], [2, "live", "Harsh"]]);
  // Every reply has its own idempotency key.
  assert.equal(new Set(api.sent.map((s) => s.idempotencyKey)).size, api.sent.length);
});

test("ignores people who aren't on the roster, and stray ship-its", async () => {
  const { api, agent, generated, step, texts } = setup();
  await agent.start();
  api.add(STRANGER, "@Orbit make a game");
  api.add(WILSON, "ship it"); // nothing pending, no mention: ordinary chatter
  await step();
  assert.deepEqual(texts(), []);

  api.add(WILSON, "@Orbit make a game");
  api.add(STRANGER, "ship it");
  await step();
  assert.equal(texts().length, 1);
  assert.equal(generated.length, 0, "a stranger can't approve a build");

  api.add(WILSON, "@Orbit cancel");
  await step();
  assert.equal(texts()[1], "Okay, scrapped that plan.");
  api.add(WILSON, "@Orbit ship it");
  await step();
  assert.match(texts()[2]!, /nothing waiting to build/);
});

test("console errors from the check go back to Claude once", async () => {
  const { api, agent, store, generated, published, step, texts } = setup({ qualityErrors: [["uncaught: x is not defined"]] });
  await agent.start();
  api.add(WILSON, "@Orbit make a game");
  api.add(WILSON, "ship it");
  await step();
  assert.deepEqual(generated[1]!.errors, ["uncaught: x is not defined"]);
  assert.match(published.at(-1)!.html, /\(fixed\)/);
  assert.match(texts().at(-1)!, /is live/);
  assert.equal(store.chat("imessage:pho_spc_group").projects[0]!.versions[0]!.fixedErrors, 1);
});

test("a failed build says so and keeps the chat usable", async () => {
  const { api, agent, step, texts } = setup({ failBuild: true });
  await agent.start();
  api.add(WILSON, "@Orbit make a game");
  api.add(WILSON, "ship it");
  await step();
  assert.match(texts().at(-1)!, /^v1 didn't build \(model declined the request\)/);
  api.add(WILSON, "@Orbit tell me a joke");
  await step();
  assert.equal(texts().at(-1), "I build small web apps.");
});

test("photos from the chat reach Claude and end up inside the app", async () => {
  const sharp = (await import("sharp")).default;
  const red = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#ff0000" } }).png().toBuffer();
  const { api, agent, store, generated, published, specs, briefImages, step } = setup();
  await agent.start();

  // The photo arrives on its own, then someone asks.
  api.addPhoto(HARSH, "pho_att_face", red);
  api.add(WILSON, "@Orbit make space invaders where this is the boss");
  await step();
  assert.deepEqual(briefImages[0], ["Photo sent by Harsh:"]);
  api.add(WILSON, "ship it");
  await step();

  assert.equal(specs[0]!.images?.[0]?.label, "Image 1, sent by Harsh (use it as ORBIT_IMAGE_1):");
  assert.equal(generated[0]!.images?.length, 1);
  // The published app has the real photo (a JPEG data URI), not the placeholder.
  const v1 = published.at(-1)!.html;
  assert.match(v1, /<img src="data:image\/jpeg;base64,[A-Za-z0-9+/=]{100,}">/);
  assert.doesNotMatch(v1, /ORBIT_IMAGE_1/);
  const project = store.chat("imessage:pho_spc_group").projects[0]!;
  assert.deepEqual(project.images, [{ id: "pho_att_face", sentBy: "Harsh" }]);

  // An edit sends Claude placeholders, not base64, and the photo stays in its slot.
  api.add(WILSON, "@Orbit make the boss bigger");
  await step();
  assert.match(generated[1]!.previousHtml!, /<img src="ORBIT_IMAGE_1">/);
  assert.doesNotMatch(generated[1]!.previousHtml!, /base64/);
  assert.match(published.at(-1)!.html, /<img src="data:image\/jpeg;base64,/);
});

test("repo mode: paste a link, change on a branch after ship it, ask, roll back with confirmation", async () => {
  const calls: string[] = [];
  const branch = { name: "ensemble/dark-mode-ab12", title: "Add dark mode", base: "main", createdBy: "Harsh", commits: [] as { sha: string; message: string; by: string; at: string }[] };
  const repos = {
    async attach(ref: { owner: string; name: string; url: string }) {
      calls.push(`attach ${ref.owner}/${ref.name}`);
      return { ...ref, defaultBranch: "main", canPush: true, sandboxId: "sbx", dir: "/repo", summary: "A small Vite app.", branches: [], currentBranch: undefined };
    },
    async ask(_state: unknown, question: string) {
      calls.push(`ask ${question}`);
      return "Last commit: 1a2b3c4 Add dark mode (asked by Harsh).";
    },
    async change(state: { branches: typeof branch[]; currentBranch?: string }, args: { brief: string; requestedBy: string }) {
      calls.push(`change ${args.brief} by ${args.requestedBy}`);
      branch.commits.push({ sha: "1a2b3c4", message: "Add dark mode toggle", by: args.requestedBy, at: "" });
      state.branches.push(branch);
      state.currentBranch = branch.name;
      Object.assign(branch, { prUrl: "https://github.com/o/r/pull/7", prNumber: 7 });
      return { changed: true, branch, commit: branch.commits[0], stat: "2 files changed, 30 insertions(+)", report: "Added a toggle. Tests pass.", pushed: true };
    },
    async rollback(_s: unknown, args: { mode: string; branch?: { name: string } }) {
      calls.push(`rollback ${args.mode} on ${args.branch?.name}`);
      const commit = { sha: "9f8e7d6", message: 'Revert "Add dark mode toggle"', by: "Wilson", at: "" };
      branch.commits.push(commit); // the real worker records every commit it makes on the branch
      return { changed: true, branch, commit, stat: "2 files changed", report: "Undid 1a2b3c4.", pushed: true };
    },
  };
  const plans: Record<string, Awaited<ReturnType<typeof import("../src/orbit/repoPlan").writeRepoPlan>>> = {
    "add a dark mode toggle": { action: "change", title: "Add dark mode", brief: "Add a dark mode toggle to the header.", rollbackMode: "none", rollbackCommit: "", branch: "" },
    "what was the last commit?": { action: "question", title: "", brief: "What was the last commit?", rollbackMode: "none", rollbackCommit: "", branch: "" },
    "undo that": { action: "rollback", title: "Undo dark mode", brief: "", rollbackMode: "undo", rollbackCommit: "", branch: "" },
    "we're done with the repo": { action: "leave", title: "", brief: "", rollbackMode: "none", rollbackCommit: "", branch: "" },
  };
  const { api, agent, generated, step, texts } = setup({ repos: repos as never, repoPlan: (r) => plans[r]! });
  await agent.start();

  api.add(WILSON, "@Orbit work on https://github.com/o/r");
  await step();
  assert.match(texts()[0]!, /^Cloning o\/r into a sandbox/);
  assert.match(texts()[1]!, /^Cloned o\/r \(main\)\. A small Vite app\./);

  api.add(HARSH, "@Orbit add a dark mode toggle");
  await step();
  assert.match(texts()[2]!, /Add a dark mode toggle to the header\.\n\nI'll do it on a new branch off main and open a pull request\. Reply "ship it"/);
  assert.equal(calls.filter((c) => c.startsWith("change")).length, 0, "nothing changes before ship it");
  api.add(STRANGER, "ship it");
  await step();
  assert.equal(calls.filter((c) => c.startsWith("change")).length, 0, "a stranger can't approve it");
  api.add(WILSON, "ship it");
  await step();
  assert.equal(calls.at(-1), "change Add a dark mode toggle to the header. by Harsh");
  assert.match(texts().at(-1)!, /^Done on ensemble\/dark-mode-ab12: 2 files changed, 30 insertions\(\+\) \(commit 1a2b3c4, "Add dark mode toggle"\)\.\n\nAdded a toggle\. Tests pass\.\n\nPull request: https:\/\/github\.com\/o\/r\/pull\/7/);

  api.add(HARSH, "@Orbit what was the last commit?");
  await step();
  assert.equal(texts().at(-1), "Last commit: 1a2b3c4 Add dark mode (asked by Harsh).");

  api.add(WILSON, "@Orbit undo that");
  await step();
  assert.match(texts().at(-1)!, /I'll undo the latest commit on ensemble\/dark-mode-ab12 \(https:\/\/github\.com\/o\/r\/pull\/7\), as a new commit/);
  api.add(WILSON, "ship it");
  await step();
  assert.equal(calls.at(-1), "rollback undo on ensemble/dark-mode-ab12");
  assert.match(texts().at(-1)!, /Undid 1a2b3c4\./);

  api.add(WILSON, "@Orbit versions");
  await step();
  assert.equal(texts().at(-1), "o/r\nAdd dark mode: ensemble/dark-mode-ab12 https://github.com/o/r/pull/7 (2 commits)");

  api.add(WILSON, "@Orbit we're done with the repo");
  await step();
  assert.equal(texts().at(-1), "Done with o/r. Back to building apps.");
  assert.equal(generated.length, 0, "repo mode never built an app");
});

test("each app only sees its own part of the chat, and going back to an old app edits that one", async () => {
  const sharp = (await import("sharp")).default;
  const photo = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#00ff00" } }).png().toBuffer();
  const { api, agent, store, generated, specs, briefImages, briefTranscripts, step, texts } = setup();
  await agent.start();

  // Game 1: a cat game, with a photo.
  api.add(HARSH, "cats are cute, use my cat");
  api.addPhoto(HARSH, "pho_att_cat", photo);
  api.add(WILSON, "@Orbit make flappy bird with a cat");
  await step();
  api.add(HARSH, "ship it");
  await step();
  assert.match(texts().at(-1)!, /^v1 of Cat Flap is live/);

  // Game 2: snakes. Its brief, spec and photos must not include any of the cat talk.
  api.add(HARSH, "now let's do snakes");
  api.add(HARSH, "neon green snake pls");
  api.add(WILSON, "@Orbit make a new snake game");
  await step();
  assert.match(briefTranscripts.at(-1)!, /neon green snake pls/);
  assert.doesNotMatch(briefTranscripts.at(-1)!, /cats are cute/);
  assert.deepEqual(briefImages.at(-1), [], "the cat photo isn't offered to the snake game");
  api.add(WILSON, "ship it");
  await step();
  assert.match(texts().at(-1)!, /^v1 of Neon Snake is live/);
  const snakeSpec = specs.at(-1)!;
  assert.equal(snakeSpec.title, "Neon Snake");
  assert.match(snakeSpec.transcript, /now let's do snakes/);
  assert.doesNotMatch(snakeSpec.transcript, /cat/i);
  assert.equal(snakeSpec.images?.length ?? 0, 0);

  // Back to game 1 by name: it edits the cat game (not the snake), from the cat game's code.
  api.add(WILSON, "@Orbit go back to the cat game and make it faster");
  await step();
  assert.match(texts().at(-2)!, /^On it: v2 of Cat Flap\./);
  assert.match(texts().at(-1)!, /^v2 of Cat Flap is live/);
  assert.match(generated.at(-1)!.previousHtml!, /make flappy bird with a cat/);
  assert.doesNotMatch(generated.at(-1)!.previousHtml!, /snake/i);
  // The brief for that edit didn't re-read the snake discussion either.
  assert.doesNotMatch(briefTranscripts.at(-1)!, /snake/i);

  const chat = store.chat("imessage:pho_spc_group");
  const [cat, snake] = chat.projects;
  assert.deepEqual([cat!.title, cat!.versions.length, snake!.title, snake!.versions.length], ["Cat Flap", 2, "Neon Snake", 1]);
  assert.equal(chat.currentProjectId, cat!.id);
  assert.deepEqual(chat.segments!.map((x) => x.projectId), [cat!.id, snake!.id, cat!.id, null]);
});
