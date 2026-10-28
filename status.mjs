// The status label on the composer's top border: what the assistant is doing now, in a few
// words. Plain ECMAScript with no Node APIs: Client.qml imports it (import "status.mjs" as Status)
// and node:test checks it.
//
// Every text is one of a fixed set: tool names, titles, arguments (detail) and results
// (output) only pick the words, they are never shown, so no host, path or secret can leak.

// The ODD phases the agent announces with the gentle_odd_phase tool ("clear" ends the phase).
export const PHASES = ["authorizing", "exploring", "researching", "deciding", "planning", "implementing", "checking", "closing"];

const SERVICES = { slack: "Slack", linear: "Linear", gmail: "Gmail", notion: "Notion", atlassian: "Atlassian", discord: "Discord" };

const known = phase => (PHASES.indexOf(phase) >= 0 || phase === "clear" ? phase : "");

function isPhaseCall(a) {
  return /(^|_)gentle_odd_phase$/.test(String(a.tool || "")) || /gentle_odd_phase|\bodd phase\b/i.test(String(a.title || ""));
}

// The phase a gentle_odd_phase activity announces: one of PHASES, "clear", or "" (not such a
// call, or no phase it knows). The patched daemon sends the arguments as `detail`, a JSON preview
// that may be cut at 200 characters; a title can carry the phase too.
export function phaseOf(activity) {
  const a = activity || {};
  if (!isPhaseCall(a)) return "";
  let detail = a.detail;
  if (typeof detail === "string") {
    try { detail = JSON.parse(detail); } catch (e) {
      const match = /"phase"\s*:\s*"([A-Za-z]+)"/.exec(detail);
      detail = match ? { phase: match[1] } : null;
    }
  }
  if (detail && typeof detail === "object" && typeof detail.phase === "string")
    return known(detail.phase.trim().toLowerCase());
  const words = String(a.title || "").toLowerCase().match(/[a-z]+/g) || [];
  for (let i = words.length - 1; i >= 0; i--) if (known(words[i])) return words[i];
  return "";
}

// A running tool call in a few words: from its tool and source (patched daemon), otherwise from
// its kind and title (every daemon).
export function activityLabel(activity) {
  const a = activity || {};
  const tool = String(a.tool || "").toLowerCase();
  const kind = String(a.kind || "");
  const title = String(a.title || "");
  switch (a.source) {
    case "engram":
      return /^mem_save|^mem_update$|^mem_session_summary$/.test(tool) ? "saving a note" : "reading memory";
    case "shell": return "running command";
    case "files":
      if (tool === "read") return "reading files";
      if (tool === "write" || tool === "edit") return "editing";
      if (/^(grep|find|ls)$|^codegraph/.test(tool)) return "exploring";
      break;
    case "web": return "searching the web";
    case "subagent": return "delegating";
    case "rdd": return "reviewing";
    case "mcp": return "using a connector";
    case "other": return "working";
    default:
      if (SERVICES[a.source]) return "checking " + SERVICES[a.source];
  }
  switch (kind) {
    case "memory": return /\bsav/i.test(title) ? "saving a note" : "reading memory";
    case "run": case "shell": case "command": return "running command";
    case "read": return "reading files";
    case "edit": case "write": return "editing";
    case "search": return /online|web/i.test(title) ? "searching the web" : "exploring";
    case "web": return "searching the web";
    case "delegate": case "subagent": return "delegating";
    case "mcp": return "using a connector";
  }
  return "working";
}

// {text, tone} for the composer label. Tone: accent while busy, urgent when the user is needed
// or the daemon is unreachable, dim otherwise. Strongest first: connection > waiting for you >
// voice / upload > running activity > ODD phase (while busy) > answering > thinking > ready.
//   connection: connecting | open | reconnecting | fatal | stopped; ready: hello answered
//   agentState: the daemon's agent_state; asks: pending ask count; voice: Voice.state
//   uploading: files on their way; streaming: reply text arriving (until its message_done)
//   activity: the latest running activity (not a phase call); phase: the last phase seen
export function label(state) {
  const s = state || {};
  const busy = (text) => ({ text, tone: "accent" });
  if (!s.connection || s.connection === "fatal" || s.connection === "stopped") return { text: "offline", tone: "urgent" };
  if (s.connection === "reconnecting") return { text: "reconnecting…", tone: "urgent" };
  if (s.connection !== "open" || !s.ready) return { text: "connecting…", tone: "dim" };
  if (s.asks > 0 || s.agentState === "needs_you") return { text: "waiting for you", tone: "urgent" };
  if (s.voice === "recording" || s.voice === "loading") return busy("recording");
  if (s.voice === "transcribing" || s.voice === "cancelling") return busy("transcribing");
  if (s.uploading) return busy("uploading");
  if (s.activity) return busy(activityLabel(s.activity));
  const working = s.streaming || s.agentState === "thinking" || s.agentState === "working";
  const phase = PHASES.indexOf(s.phase) >= 0 ? s.phase : "";
  if (working && phase) return busy(phase);
  // The daemon reports "thinking" while the reply streams too: text arriving reads as answering.
  if (s.streaming) return busy("answering");
  if (s.agentState === "thinking") return busy("thinking");
  if (s.agentState === "working") return busy("working");
  if (s.agentState === "starting" || s.agentState === "restarting") return { text: "starting…", tone: "dim" };
  if (s.agentState === "error") return { text: "error", tone: "urgent" };
  return { text: "ready", tone: "dim" };
}
