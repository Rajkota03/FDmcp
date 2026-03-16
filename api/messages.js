const sseModule = require("./sse.js");

// Re-use the tool definitions and callTool from sse.js
// We need to import them — but since they're in the same module scope on Vercel,
// let's duplicate the minimal needed parts

function parseFdxContent(xmlText) {
  const paragraphs = [];
  const paraRegex = /<Paragraph\s+Type="([^"]*)"[^>]*>([\s\S]*?)<\/Paragraph>/g;
  let match;
  while ((match = paraRegex.exec(xmlText)) !== null) {
    const type = match[1];
    const content = match[2];
    let text = "";
    const textRegex = /<Text[^>]*>([\s\S]*?)<\/Text>/g;
    let tm;
    while ((tm = textRegex.exec(content)) !== null) {
      text += tm[1].replace(/<[^>]*>/g, "");
    }
    paragraphs.push({ type, text: text.trim() });
  }
  return paragraphs;
}

function paragraphsToScenes(paragraphs) {
  const scenes = [];
  let cur = null;
  for (const p of paragraphs) {
    if (p.type === "Scene Heading") {
      if (cur) scenes.push(cur);
      cur = { heading: p.text, elements: [] };
    } else {
      if (!cur) cur = { heading: "(Opening)", elements: [] };
      cur.elements.push(p);
    }
  }
  if (cur) scenes.push(cur);
  return scenes;
}

function scenesToText(scenes) {
  const lines = [];
  for (let i = 0; i < scenes.length; i++) {
    lines.push(`\n=== SCENE ${i + 1}: ${scenes[i].heading} ===\n`);
    for (const el of scenes[i].elements) {
      if (el.type === "Character") lines.push(`\n  ${el.text.toUpperCase()}`);
      else if (el.type === "Parenthetical") lines.push(`  ${el.text}`);
      else if (el.type === "Dialogue") lines.push(`    ${el.text}`);
      else if (el.type === "Action") lines.push(`\n${el.text}`);
      else if (el.type === "Transition") lines.push(`\n${el.text.toUpperCase()}`);
      else if (el.text) lines.push(el.text);
    }
  }
  return lines.join("\n");
}

function analyzeStructure(scenes) {
  const characters = new Map();
  let dialogueCount = 0, actionCount = 0, totalWords = 0;
  for (const scene of scenes) {
    let cur = null;
    for (const el of scene.elements) {
      if (el.type === "Character") {
        const n = el.text.toUpperCase().trim();
        if (n && !characters.has(n)) characters.set(n, { dc: 0, tw: 0, sc: new Set() });
        cur = n;
        if (n) characters.get(n).sc.add(scene.heading);
      } else if (el.type === "Dialogue") {
        dialogueCount++;
        const w = el.text.split(/\s+/).filter(Boolean).length;
        totalWords += w;
        if (cur && characters.has(cur)) { characters.get(cur).dc++; characters.get(cur).tw += w; }
      } else if (el.type === "Action") { actionCount++; cur = null; }
    }
  }
  const stats = [];
  for (const [n, s] of characters) stats.push({ name: n, dialogueCount: s.dc, totalWords: s.tw, sceneCount: s.sc.size });
  stats.sort((a, b) => b.dialogueCount - a.dialogueCount);
  return { totalScenes: scenes.length, totalDialogueBlocks: dialogueCount, totalActionBlocks: actionCount, totalDialogueWords: totalWords, characters: stats };
}

function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildSceneXml(heading, elements) {
  let xml = `    <Paragraph Type="Scene Heading">\n      <SceneProperties Length="" Page="" Title="">\n      </SceneProperties>\n      <Text>${escapeXml(heading)}</Text>\n    </Paragraph>`;
  for (const el of elements) xml += `\n    <Paragraph Type="${escapeXml(el.type)}">\n      <Text>${escapeXml(el.text)}</Text>\n    </Paragraph>`;
  return xml;
}

// In-memory store (shared across warm invocations on same instance)
const scripts = new Map();

const TOOLS = [
  { name: "load_script", description: "Load a Final Draft .fdx script by pasting its XML content. Call this first.", inputSchema: { type: "object", properties: { script_name: { type: "string", description: "A name for this script" }, fdx_content: { type: "string", description: "The full XML content of the .fdx file" } }, required: ["script_name", "fdx_content"] } },
  { name: "read_script", description: "Read the full screenplay as formatted text.", inputSchema: { type: "object", properties: { script_name: { type: "string", description: "Name of the loaded script" } }, required: ["script_name"] } },
  { name: "read_scene", description: "Read a specific scene by number.", inputSchema: { type: "object", properties: { script_name: { type: "string", description: "Name of the loaded script" }, scene_number: { type: "number", description: "Scene number (1-indexed)" } }, required: ["script_name", "scene_number"] } },
  { name: "analyze_script", description: "Analyze screenplay structure — characters, scenes, dialogue stats.", inputSchema: { type: "object", properties: { script_name: { type: "string", description: "Name of the loaded script" } }, required: ["script_name"] } },
  { name: "get_character_dialogue", description: "Get all dialogue for a specific character.", inputSchema: { type: "object", properties: { script_name: { type: "string", description: "Name of the loaded script" }, character_name: { type: "string", description: "Character name" } }, required: ["script_name", "character_name"] } },
  { name: "search_script", description: "Search for text across the screenplay.", inputSchema: { type: "object", properties: { script_name: { type: "string", description: "Name of the loaded script" }, query: { type: "string", description: "Search text" } }, required: ["script_name", "query"] } },
  { name: "generate_scene_fdx", description: "Generate a new scene as Final Draft XML that you can paste into your .fdx file.", inputSchema: { type: "object", properties: { scene_heading: { type: "string", description: "Scene heading e.g. 'INT. OFFICE - DAY'" }, elements: { type: "array", items: { type: "object", properties: { type: { type: "string", enum: ["Character", "Dialogue", "Action", "Parenthetical", "Transition"] }, text: { type: "string" } }, required: ["type", "text"] } } }, required: ["scene_heading", "elements"] } },
  { name: "list_scenes", description: "List all scenes with numbers and headings.", inputSchema: { type: "object", properties: { script_name: { type: "string", description: "Name of the loaded script" } }, required: ["script_name"] } },
];

function callTool(name, args) {
  switch (name) {
    case "load_script": {
      const p = parseFdxContent(args.fdx_content);
      const s = paragraphsToScenes(p);
      scripts.set(args.script_name, { paragraphs: p, scenes: s });
      const a = analyzeStructure(s);
      return { content: [{ type: "text", text: `Loaded "${args.script_name}" — ${a.totalScenes} scenes, ${a.characters.length} characters, ${a.totalDialogueBlocks} dialogue blocks.\nCharacters: ${a.characters.map(c => `${c.name} (${c.dialogueCount} lines)`).join(", ")}` }] };
    }
    case "read_script": {
      const d = scripts.get(args.script_name);
      if (!d) return { content: [{ type: "text", text: `Script "${args.script_name}" not loaded. Use load_script first.` }] };
      return { content: [{ type: "text", text: scenesToText(d.scenes) }] };
    }
    case "read_scene": {
      const d = scripts.get(args.script_name);
      if (!d) return { content: [{ type: "text", text: `Script not loaded.` }] };
      if (args.scene_number < 1 || args.scene_number > d.scenes.length) return { content: [{ type: "text", text: `Invalid. Has ${d.scenes.length} scenes.` }] };
      return { content: [{ type: "text", text: scenesToText([d.scenes[args.scene_number - 1]]) }] };
    }
    case "analyze_script": {
      const d = scripts.get(args.script_name);
      if (!d) return { content: [{ type: "text", text: `Script not loaded.` }] };
      const a = analyzeStructure(d.scenes);
      let r = `Scenes: ${a.totalScenes} | Dialogue: ${a.totalDialogueBlocks} | Action: ${a.totalActionBlocks} | Words: ${a.totalDialogueWords}\n\n`;
      for (const c of a.characters) r += `  ${c.name}: ${c.dialogueCount} lines, ${c.totalWords} words, ${c.sceneCount} scenes\n`;
      return { content: [{ type: "text", text: r }] };
    }
    case "get_character_dialogue": {
      const d = scripts.get(args.script_name);
      if (!d) return { content: [{ type: "text", text: `Script not loaded.` }] };
      const target = args.character_name.toUpperCase().trim();
      const dl = [];
      for (const scene of d.scenes) {
        let on = false;
        for (const el of scene.elements) {
          if (el.type === "Character") on = el.text.toUpperCase().trim() === target;
          else if (el.type === "Dialogue" && on) { dl.push({ s: scene.heading, t: el.text }); on = false; }
          else if (el.type !== "Parenthetical") on = false;
        }
      }
      if (!dl.length) return { content: [{ type: "text", text: `No dialogue for "${args.character_name}".` }] };
      let t = `${target} — ${dl.length} lines:\n\n`;
      for (const x of dl) t += `  [${x.s}] ${x.t}\n\n`;
      return { content: [{ type: "text", text: t }] };
    }
    case "search_script": {
      const d = scripts.get(args.script_name);
      if (!d) return { content: [{ type: "text", text: `Script not loaded.` }] };
      const q = args.query.toLowerCase();
      const res = [];
      for (let i = 0; i < d.scenes.length; i++) {
        if (d.scenes[i].heading.toLowerCase().includes(q)) res.push(`[Scene ${i+1}] ${d.scenes[i].heading}`);
        for (const el of d.scenes[i].elements) if (el.text.toLowerCase().includes(q)) res.push(`[Scene ${i+1}] (${el.type}) ${el.text}`);
      }
      return { content: [{ type: "text", text: res.length ? `${res.length} matches:\n\n${res.join("\n\n")}` : `No results.` }] };
    }
    case "generate_scene_fdx": {
      return { content: [{ type: "text", text: `FDX XML (paste before </Content>):\n\n${buildSceneXml(args.scene_heading, args.elements)}` }] };
    }
    case "list_scenes": {
      const d = scripts.get(args.script_name);
      if (!d) return { content: [{ type: "text", text: `Script not loaded.` }] };
      let t = `${d.scenes.length} scenes:\n`;
      for (let i = 0; i < d.scenes.length; i++) t += `  ${i+1}. ${d.scenes[i].heading}\n`;
      return { content: [{ type: "text", text: t }] };
    }
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}

module.exports = function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  const message = req.body;

  if (message.method === "initialize") {
    return res.json({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "Final Draft Screenwriting Assistant", version: "1.0.0" },
      },
    });
  }

  if (message.method === "notifications/initialized") {
    return res.status(200).json({ jsonrpc: "2.0" });
  }

  if (message.method === "tools/list") {
    return res.json({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
  }

  if (message.method === "tools/call") {
    const { name, arguments: args } = message.params;
    try {
      const result = callTool(name, args);
      return res.json({ jsonrpc: "2.0", id: message.id, result });
    } catch (err) {
      return res.json({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: err.message } });
    }
  }

  res.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unknown method: ${message.method}` } });
};
