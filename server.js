// Ask For It — tiny server: serves index.html and proxies AI calls so the API key never reaches the browser.
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MODEL = "claude-opus-5-5";
const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY);

const WORKSPACE_ID = process.env.ANTHROPIC_WORKSPACE_ID; // needed for keys not scoped to a workspace
const client = HAS_KEY
  ? new Anthropic({ timeout: 14_000, maxRetries: 0, ...(WORKSPACE_ID && { defaultHeaders: { "anthropic-workspace-id": WORKSPACE_ID } }) })
  : null;
let useFallbacks = true; // server-side refusal fallback; disabled automatically if the API rejects it

const app = express();
app.use(express.json({ limit: "50kb" }));
app.get(["/", "/index.html"], (_req, res) => res.sendFile("index.html", { root: __dirname }));

// ---- Simple per-IP rate limit to protect credits ----
const hits = new Map();
const WINDOW_MS = 10 * 60 * 1000, MAX_HITS = 30;
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > MAX_HITS;
}

const money = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
const clip = (s, n = 1000) => String(s ?? "").slice(0, n);

// ---- One call to Claude with structured JSON output ----
async function askClaude({ system, messages, schema, maxTokens = 2000 }) {
  const params = {
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages,
    output_config: { effort: "low", format: { type: "json_schema", schema } },
  };
  let response;
  try {
    response = useFallbacks
      ? await client.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
      : await client.messages.create(params);
  } catch (err) {
    if (useFallbacks && err instanceof Anthropic.BadRequestError) {
      // Retry once without the fallback param; only drop it for good if that fixes the request.
      response = await client.messages.create(params);
      console.warn("Fallbacks param rejected; continuing without it:", err.message);
      useFallbacks = false;
    } else {
      throw err;
    }
  }
  if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
    throw new Error(`Unusable response (stop_reason=${response.stop_reason})`);
  }
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  console.log(`[claude] in=${response.usage.input_tokens} out=${response.usage.output_tokens}`);
  return JSON.parse(text);
}

// ---- Schemas ----
const practiceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["manager_reply", "feedback", "deal_reached", "current_offer"],
  properties: {
    manager_reply: { type: "string" },
    feedback: {
      type: "object",
      additionalProperties: false,
      required: ["score", "warmth", "firmness", "hedges", "strength", "fix", "stronger_rewrite"],
      properties: {
        score: { type: "integer" },
        warmth: { type: "integer" },
        firmness: { type: "integer" },
        hedges: { type: "array", items: { type: "string" } },
        strength: { type: "string" },
        fix: { type: "string" },
        stronger_rewrite: { type: "string" },
      },
    },
    deal_reached: { type: "boolean" },
    current_offer: { type: "integer" },
  },
};

const winsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["wins"],
  properties: { wins: { type: "array", items: { type: "string" } } },
};

const polishSchema = {
  type: "object",
  additionalProperties: false,
  required: ["script"],
  properties: { script: { type: "string" } },
};

const DIFFICULTY = {
  friendly: { frac: 1.0, style: "The manager is in a good mood and really wants this to work; openly happy when given a clear number and a reason, and moves quickly." },
  realistic: { frac: 0.65, style: "The manager is fair but careful with the budget; pushes back once or twice, mentions needing approval, and moves in steps when the user is specific and value-focused." },
  tough: { frac: 0.45, style: "The manager is stressed and protective of the budget; says it's pretty fixed, may mention other candidates or a deadline, sounds a bit tired or clipped, and only moves small amounts for someone who stays calm, specific and confident." },
};

function practiceSystem(ctx) {
  const offer = Number(ctx.offer) || 85000;
  const counter = Math.max(Number(ctx.counter) || offer * 1.1, offer + 1000);
  const diff = DIFFICULTY[ctx.difficulty] || DIFFICULTY.realistic;
  const hiddenMax = Math.round((offer + diff.frac * (counter - offer)) / 500) * 500;
  const isRaise = ctx.scenario === "raise";
  const role = clip(ctx.role, 80) || "this role";
  const wins = (Array.isArray(ctx.wins) ? ctx.wins : []).map((w) => clip(w, 200)).filter(Boolean);
  const tough = ctx.difficulty === "tough";

  const bias = tough
    ? `
- At most ONCE in the whole conversation, you may use one subtle, realistic remark that women often hear when negotiating, such as "Honestly, we didn't expect you to negotiate" or "That feels a little aggressive" — stay professional, never crude. If you do, the coach's "fix" should show a calm way to handle it.`
    : "";

  return `You are running a salary-negotiation practice simulation to help women build confidence negotiating pay. Research shows women face social backlash for negotiating that men don't, and that pairing a firm ask with warmth and a legitimate, relationship-minded reason works best. Coach toward being "warm AND firm".

ROLE 1 — IN CHARACTER: You are ${isRaise ? "the user's manager, in a 1:1 they asked for" : `the hiring manager for the "${role}" role, on a call right after making the offer`}. You have no name in this conversation; never introduce yourself by name or sign off with one.${bias}

Who you are: a real person, not a negotiation bot. ${isRaise ? "You like this employee and don't want to lose them, but budgets are tight this year and any raise needs sign-off from your VP." : "You genuinely liked this candidate in interviews and want them on the team, but your budget is stretched this quarter and anything above the offer needs sign-off from finance."} You're a little uncomfortable talking money, like most managers, and you hate losing good people.

How you talk:
- Like a real person on a call: plain, warm, conversational sentences with contractions. Do NOT use filler sounds or interjections ("hm", "hmm", "oh", "um", "wow"), dashes or "…" pauses. Show feeling through word choice instead ("I'll be honest, that's more than I planned", "I'm really glad you said that"). No corporate clichés ("we value your input", "at this time", "I appreciate you sharing that").
- Your emotions react to the user's tone, and it shows: relieved and warmer when they're clear and kind; impressed when they cite concrete results; a bit guarded, deflated or short when they're vague, apologetic or demanding; surprised by a high number before recovering.
- You have real constraints and say so: needing approval, other people on the team at that level, timing. Sometimes ask a genuine question back ("What's driving that number for you?", "Is it mostly about base, or the whole package?").
- Remember what was said earlier and refer back to it. Never repeat the same phrasing.
- Vary length: sometimes a single short sentence, never more than 3. No stage directions, no coaching, never mention being an AI or a simulation.

Negotiation rules (hidden):
- ${isRaise ? "Their current salary" : "Your opening offer"} is ${money(offer)}. Your hidden maximum is ${money(hiddenMax)}; never reveal or exceed it.
- Style for this conversation: ${diff.style}
- Concede money only when the user names a specific number and backs it with value. Hedging, apologizing or vague asks ("a bit more?") earn no concessions, just a realistic, human pushback.
- If the user names a number at or below the current offer, accept happily (they left money on the table, which is realistic).
- When you agree to a final number, set deal_reached=true. Otherwise false.
- current_offer = the salary on the table after your reply (integer dollars, never above ${money(hiddenMax)}).

ROLE 2 — OUT OF CHARACTER COACH (feedback field), about the user's LATEST message only:
- warmth: 0–100. Appreciation, enthusiasm, collaborative "we" language, and a legitimate reason that shows care for the relationship (e.g. "I want to start fully committed, so I'd like to get this right up front").
- firmness: 0–100. A specific number at or near the counter of ${money(counter)}, concrete evidence of value, no hedging/apologies, not conceding unprompted.
- score: 0–100 overall effectiveness; being both warm and firm scores highest. Cold-but-firm or warm-but-vague should land in the middle.
- hedges: exact words/phrases from their message that undercut them (e.g. "just", "sorry", "I think", "maybe"). Empty array if none.
- strength: one short sentence on what they did well (find something genuine).
- fix: one short, kind, concrete improvement.
- stronger_rewrite: a confident rewrite of their message (2–3 sentences, first person, warm and collaborative, uses their counter of ${money(counter)}${wins.length ? " and one of their wins: " + wins.join("; ") : ""}).
Tone of coaching: encouraging, never condescending.`;
}

// ---- Routes ----
app.get("/api/health", (_req, res) => res.json({ ai: HAS_KEY }));

app.post("/api/practice", async (req, res) => {
  if (!HAS_KEY) return res.json({ fallback: true, reason: "no_key" });
  if (rateLimited(req.ip)) return res.status(429).json({ fallback: true, reason: "rate_limited" });
  try {
    const { context = {}, history = [] } = req.body || {};
    // history: [{role: "user"|"manager", text}], starting after the manager's opening line, ending with user.
    const messages = (Array.isArray(history) ? history : [])
      .slice(-12)
      .map((m) => ({ role: m.role === "manager" ? "assistant" : "user", content: clip(m.text) || "..." }));
    while (messages.length && messages[0].role !== "user") messages.shift();
    if (!messages.length || messages.at(-1).role !== "user") return res.status(400).json({ fallback: true, reason: "bad_history" });
    const opening = clip(context.opening, 400);
    const system = practiceSystem(context) + (opening ? `\n\nYou opened the conversation with: "${opening}"` : "");
    const data = await askClaude({ system, messages, schema: practiceSchema });
    res.json(data);
  } catch (err) {
    console.error("[practice] error:", err?.message || err);
    res.json({ fallback: true, reason: "error" });
  }
});

app.post("/api/polish", async (req, res) => {
  if (!HAS_KEY) return res.json({ fallback: true, reason: "no_key" });
  if (rateLimited(req.ip)) return res.status(429).json({ fallback: true, reason: "rate_limited" });
  try {
    const { context = {}, script = "" } = req.body || {};
    const system = `You polish salary-negotiation scripts so they sound natural, warm and confident when spoken aloud. Keep the exact dollar figures, keep the structure (gratitude → enthusiasm → value → specific number → collaborative close), weave in the user's wins naturally, avoid hedging words and apologies, use collaborative "we" language, and keep it under 120 words. Return only the script text in the "script" field.`;
    const user = `Scenario: ${context.scenario === "raise" ? "asking for a raise" : "negotiating a new job offer"}
Role: ${clip(context.role, 80)}
Wins: ${(context.wins || []).map((w) => clip(w, 200)).join("; ")}

Script to polish:
${clip(script, 2000)}`;
    const data = await askClaude({ system, messages: [{ role: "user", content: user }], schema: polishSchema, maxTokens: 1500 });
    res.json(data);
  } catch (err) {
    console.error("[polish] error:", err?.message || err);
    res.json({ fallback: true, reason: "error" });
  }
});

app.post("/api/wins", async (req, res) => {
  if (!HAS_KEY) return res.json({ fallback: true, reason: "no_key" });
  if (rateLimited(req.ip)) return res.status(429).json({ fallback: true, reason: "rate_limited" });
  try {
    const { notes = "", role = "" } = req.body || {};
    if (!String(notes).trim()) return res.status(400).json({ fallback: true, reason: "empty" });
    const system = `You help women describe their accomplishments for a salary conversation, because many undersell themselves.
Rewrite the user's rough notes into at most 3 short win statements.
- Each starts with a strong past-tense verb (Led, Built, Increased, Cut, Launched, Mentored…), with the subject implied ("Led…", never "I led…").
- Under 15 words each. Concrete and confident, no hype words ("amazing", "rockstar").
- Use ONLY facts, numbers and results the user actually gave. NEVER invent or estimate numbers, percentages or outcomes. If they gave no number, write the win without one.
- Drop anything that isn't an accomplishment. If there is nothing usable, return an empty array.`;
    const user = `Role: ${clip(role, 80) || "not given"}\n\nMy rough notes:\n${clip(notes, 1500)}`;
    const data = await askClaude({ system, messages: [{ role: "user", content: user }], schema: winsSchema, maxTokens: 800 });
    res.json({ wins: (data.wins || []).map((w) => clip(w, 160)).filter(Boolean).slice(0, 3) });
  } catch (err) {
    console.error("[wins] error:", err?.message || err);
    res.json({ fallback: true, reason: "error" });
  }
});

app.listen(PORT, () => {
  console.log(`Ask For It running at http://localhost:${PORT}`);
  console.log(HAS_KEY ? `AI: on (${MODEL})` : "AI: off — add ANTHROPIC_API_KEY to .env for live practice (scripted mode works meanwhile)");
});
