#!/usr/bin/env node

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { SSEServerTransport } = require("@modelcontextprotocol/sdk/server/sse.js");
const http = require("http");
const { z } = require("zod");
const fs = require("fs");
const path = require("path");
const { execSync, exec } = require("child_process");
const { XMLParser, XMLBuilder } = require("fast-xml-parser");

// ─── FDX Parsing Helpers ───────────────────────────────────────────────

function readFdxRaw(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  return fs.readFileSync(filePath, "utf-8");
}

function parseFdx(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    preserveOrder: true,
    trimValues: false,
    textNodeName: "#text",
  });
  return parser.parse(xml);
}

function extractTextFromNode(node) {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(extractTextFromNode).join("");
  if (node && node["#text"] !== undefined) return String(node["#text"]);
  if (node && typeof node === "object") {
    let text = "";
    for (const key of Object.keys(node)) {
      if (key === "#text") text += String(node[key]);
      else if (key !== ":@") text += extractTextFromNode(node[key]);
    }
    return text;
  }
  return "";
}

function extractParagraphs(content) {
  const paragraphs = [];

  function walk(nodes) {
    if (!Array.isArray(nodes)) nodes = [nodes];
    for (const node of nodes) {
      if (node.Paragraph !== undefined) {
        const attrs = node[":@"] || {};
        const type = attrs["@_Type"] || "Unknown";
        const textParts = [];

        const paraContent = Array.isArray(node.Paragraph) ? node.Paragraph : [node.Paragraph];
        for (const child of paraContent) {
          if (child === null || child === undefined) continue;
          if (child.Text !== undefined) {
            const textItems = Array.isArray(child.Text) ? child.Text : [child.Text];
            for (const t of textItems) {
              textParts.push(extractTextFromNode(t));
            }
          }
          if (child.SceneProperties !== undefined) {
            // skip scene properties in text extraction
          }
        }

        paragraphs.push({ type, text: textParts.join("").trim() });
      }

      // Recurse into Content
      if (node.Content !== undefined) {
        walk(Array.isArray(node.Content) ? node.Content : [node.Content]);
      }
      // Recurse into FinalDraft
      if (node.FinalDraft !== undefined) {
        walk(Array.isArray(node.FinalDraft) ? node.FinalDraft : [node.FinalDraft]);
      }
    }
  }

  walk(content);
  return paragraphs;
}

function paragraphsToScenes(paragraphs) {
  const scenes = [];
  let currentScene = null;

  for (const p of paragraphs) {
    if (p.type === "Scene Heading") {
      if (currentScene) scenes.push(currentScene);
      currentScene = {
        heading: p.text,
        elements: [],
      };
    } else {
      if (!currentScene) {
        currentScene = { heading: "(Opening - No Scene Heading)", elements: [] };
      }
      currentScene.elements.push(p);
    }
  }
  if (currentScene) scenes.push(currentScene);
  return scenes;
}

function scenesToReadableText(scenes) {
  const lines = [];
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    lines.push(`\n=== SCENE ${i + 1}: ${scene.heading} ===\n`);
    let lastType = "";
    for (const el of scene.elements) {
      if (el.type === "Character") {
        lines.push(`\n  ${el.text.toUpperCase()}`);
      } else if (el.type === "Parenthetical") {
        lines.push(`  ${el.text}`);
      } else if (el.type === "Dialogue") {
        lines.push(`    ${el.text}`);
      } else if (el.type === "Action") {
        lines.push(`\n${el.text}`);
      } else if (el.type === "Transition") {
        lines.push(`\n${el.text.toUpperCase()}`);
      } else if (el.text) {
        lines.push(el.text);
      }
      lastType = el.type;
    }
  }
  return lines.join("\n");
}

function analyzeStructure(scenes) {
  const characters = new Map();
  let dialogueCount = 0;
  let actionCount = 0;
  let totalDialogueWords = 0;

  for (const scene of scenes) {
    let currentChar = null;
    for (const el of scene.elements) {
      if (el.type === "Character") {
        const name = el.text.toUpperCase().trim();
        if (!characters.has(name)) {
          characters.set(name, { dialogueCount: 0, totalWords: 0, scenes: new Set() });
        }
        currentChar = name;
        characters.get(name).scenes.add(scene.heading);
      } else if (el.type === "Dialogue") {
        dialogueCount++;
        const words = el.text.split(/\s+/).filter(Boolean).length;
        totalDialogueWords += words;
        if (currentChar && characters.has(currentChar)) {
          characters.get(currentChar).dialogueCount++;
          characters.get(currentChar).totalWords += words;
        }
      } else if (el.type === "Action") {
        actionCount++;
        currentChar = null;
      }
    }
  }

  const characterStats = [];
  for (const [name, stats] of characters) {
    characterStats.push({
      name,
      dialogueCount: stats.dialogueCount,
      totalWords: stats.totalWords,
      sceneCount: stats.scenes.size,
      scenes: [...stats.scenes],
    });
  }
  characterStats.sort((a, b) => b.dialogueCount - a.dialogueCount);

  return {
    totalScenes: scenes.length,
    totalDialogueBlocks: dialogueCount,
    totalActionBlocks: actionCount,
    totalDialogueWords,
    characters: characterStats,
    sceneList: scenes.map((s, i) => ({
      number: i + 1,
      heading: s.heading,
      elementCount: s.elements.length,
    })),
  };
}

// ─── FDX Writing Helpers ───────────────────────────────────────────────

function buildParagraphXml(type, text, options = {}) {
  let xml = `    <Paragraph Type="${escapeXml(type)}">`;
  if (type === "Scene Heading" && options.sceneProps) {
    xml += `\n      <SceneProperties Length="" Page="" Title="">\n      </SceneProperties>`;
  }
  xml += `\n      <Text>${escapeXml(text)}</Text>`;
  xml += `\n    </Paragraph>`;
  return xml;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function sceneToFdxXml(heading, elements) {
  const parts = [];
  parts.push(buildParagraphXml("Scene Heading", heading, { sceneProps: true }));
  for (const el of elements) {
    parts.push(buildParagraphXml(el.type, el.text));
  }
  return parts.join("\n");
}

function insertSceneIntoFdx(fdxContent, sceneXml, position) {
  // position: "end" | "start" | number (after scene N, 1-indexed)
  const contentCloseTag = "</Content>";
  const contentOpenTag = "<Content>";

  if (position === "end" || position === undefined) {
    // Use the FIRST </Content> (main script), not the last (could be TitlePage)
    const idx = fdxContent.indexOf(contentCloseTag);
    if (idx === -1) throw new Error("Could not find </Content> in FDX");
    return fdxContent.slice(0, idx) + "\n" + sceneXml + "\n  " + fdxContent.slice(idx);
  }

  if (position === "start") {
    const idx = fdxContent.indexOf(contentOpenTag);
    if (idx === -1) throw new Error("Could not find <Content> in FDX");
    const insertAt = idx + contentOpenTag.length;
    return fdxContent.slice(0, insertAt) + "\n" + sceneXml + "\n" + fdxContent.slice(insertAt);
  }

  // Insert after scene N
  const sceneRegex = /<Paragraph Type="Scene Heading">/g;
  let match;
  let count = 0;
  let lastSceneEnd = -1;

  // Find the Nth+1 scene heading (or end of content)
  while ((match = sceneRegex.exec(fdxContent)) !== null) {
    count++;
    if (count === position + 1) {
      // Insert before this scene heading's <Paragraph
      const insertPoint = fdxContent.lastIndexOf("<Paragraph", match.index - 1);
      if (insertPoint > 0) {
        // Back up to find the right spot - find the previous line
        const lineStart = fdxContent.lastIndexOf("\n", insertPoint);
        return fdxContent.slice(0, lineStart + 1) + sceneXml + "\n" + fdxContent.slice(lineStart + 1);
      }
    }
  }

  // If position > total scenes, append at end
  const idx = fdxContent.lastIndexOf(contentCloseTag);
  return fdxContent.slice(0, idx) + "\n" + sceneXml + "\n  " + fdxContent.slice(idx);
}

// ─── AppleScript Helpers ───────────────────────────────────────────────

function runAppleScript(script) {
  try {
    const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: "utf-8",
      timeout: 10000,
    });
    return result.trim();
  } catch (err) {
    throw new Error(`AppleScript error: ${err.message}`);
  }
}

function isFinalDraftRunning() {
  const candidates = ["Final Draft 12", "Final Draft 11", "Final Draft 10", "Final Draft"];
  for (const name of candidates) {
    try {
      const result = runAppleScript(
        `tell application "System Events" to (name of processes) contains "${name}"`
      );
      if (result === "true") return true;
    } catch {}
  }
  return false;
}

function findFinalDraftApp() {
  const candidates = ["Final Draft 12", "Final Draft 11", "Final Draft 10", "Final Draft"];
  for (const name of candidates) {
    try {
      const check = runAppleScript(
        `tell application "System Events" to (name of processes) contains "${name}"`
      );
      if (check === "true") return name;
    } catch {}
  }
  // If none running, try to find installed
  for (const name of candidates) {
    try {
      const exists = execSync(
        `test -d "/Applications/${name}.app" && echo "yes" || echo "no"`,
        { encoding: "utf-8" }
      ).trim();
      if (exists === "yes") return name;
    } catch {}
  }
  return "Final Draft 12";
}

function pushToFinalDraft(filePath) {
  const absPath = path.resolve(filePath);
  const appName = findFinalDraftApp();
  const script = `
    tell application "${appName}"
      activate
      open POSIX file "${absPath}"
    end tell
  `;
  return runAppleScript(script);
}

function getFinalDraftFrontDoc() {
  const appName = findFinalDraftApp();
  const script = `
    tell application "${appName}"
      set docPath to file of front document as text
      return POSIX path of docPath
    end tell
  `;
  return runAppleScript(script);
}

// ─── MCP Server ────────────────────────────────────────────────────────

const server = new McpServer({
  name: "final-draft-connector",
  version: "1.0.0",
});

// Tool: Read the full script
server.tool(
  "read_script",
  "Read and parse a Final Draft .fdx script file. Returns the full script as formatted text.",
  {
    file_path: z.string().describe("Absolute path to the .fdx file"),
  },
  async ({ file_path }) => {
    const xml = readFdxRaw(file_path);
    const parsed = parseFdx(xml);
    const paragraphs = extractParagraphs(parsed);
    const scenes = paragraphsToScenes(paragraphs);
    const text = scenesToReadableText(scenes);
    return {
      content: [{ type: "text", text: `Script: ${path.basename(file_path)}\nTotal scenes: ${scenes.length}\n${text}` }],
    };
  }
);

// Tool: Read a specific scene
server.tool(
  "read_scene",
  "Read a specific scene from a Final Draft script by scene number.",
  {
    file_path: z.string().describe("Absolute path to the .fdx file"),
    scene_number: z.number().describe("Scene number (1-indexed)"),
  },
  async ({ file_path, scene_number }) => {
    const xml = readFdxRaw(file_path);
    const parsed = parseFdx(xml);
    const paragraphs = extractParagraphs(parsed);
    const scenes = paragraphsToScenes(paragraphs);

    if (scene_number < 1 || scene_number > scenes.length) {
      return { content: [{ type: "text", text: `Invalid scene number. Script has ${scenes.length} scenes.` }] };
    }

    const scene = scenes[scene_number - 1];
    const text = scenesToReadableText([scene]);
    return {
      content: [{ type: "text", text: `Scene ${scene_number} of ${scenes.length}\n${text}` }],
    };
  }
);

// Tool: Analyze script structure
server.tool(
  "analyze_script",
  "Analyze the structure of a Final Draft script — characters, scene count, dialogue stats, etc.",
  {
    file_path: z.string().describe("Absolute path to the .fdx file"),
  },
  async ({ file_path }) => {
    const xml = readFdxRaw(file_path);
    const parsed = parseFdx(xml);
    const paragraphs = extractParagraphs(parsed);
    const scenes = paragraphsToScenes(paragraphs);
    const analysis = analyzeStructure(scenes);

    let report = `=== SCRIPT ANALYSIS: ${path.basename(file_path)} ===\n\n`;
    report += `Total Scenes: ${analysis.totalScenes}\n`;
    report += `Total Dialogue Blocks: ${analysis.totalDialogueBlocks}\n`;
    report += `Total Action Blocks: ${analysis.totalActionBlocks}\n`;
    report += `Total Dialogue Words: ${analysis.totalDialogueWords}\n\n`;

    report += `--- CHARACTERS (by dialogue count) ---\n`;
    for (const c of analysis.characters) {
      report += `  ${c.name}: ${c.dialogueCount} lines, ${c.totalWords} words, in ${c.sceneCount} scenes\n`;
    }

    report += `\n--- SCENE LIST ---\n`;
    for (const s of analysis.sceneList) {
      report += `  Scene ${s.number}: ${s.heading} (${s.elementCount} elements)\n`;
    }

    return { content: [{ type: "text", text: report }] };
  }
);

// Tool: List characters
server.tool(
  "list_characters",
  "List all characters in a Final Draft script with their dialogue counts.",
  {
    file_path: z.string().describe("Absolute path to the .fdx file"),
  },
  async ({ file_path }) => {
    const xml = readFdxRaw(file_path);
    const parsed = parseFdx(xml);
    const paragraphs = extractParagraphs(parsed);
    const scenes = paragraphsToScenes(paragraphs);
    const analysis = analyzeStructure(scenes);

    let text = "Characters:\n";
    for (const c of analysis.characters) {
      text += `  ${c.name} — ${c.dialogueCount} dialogue lines, ${c.totalWords} words, appears in ${c.sceneCount} scenes\n`;
      text += `    Scenes: ${c.scenes.join(", ")}\n`;
    }
    return { content: [{ type: "text", text }] };
  }
);

// Tool: Get character dialogue
server.tool(
  "get_character_dialogue",
  "Get all dialogue lines for a specific character in the script.",
  {
    file_path: z.string().describe("Absolute path to the .fdx file"),
    character_name: z.string().describe("Character name (case insensitive)"),
  },
  async ({ file_path, character_name }) => {
    const xml = readFdxRaw(file_path);
    const parsed = parseFdx(xml);
    const paragraphs = extractParagraphs(parsed);
    const scenes = paragraphsToScenes(paragraphs);
    const target = character_name.toUpperCase().trim();

    const dialogues = [];
    for (const scene of scenes) {
      let isTarget = false;
      for (const el of scene.elements) {
        if (el.type === "Character") {
          isTarget = el.text.toUpperCase().trim() === target;
        } else if (el.type === "Dialogue" && isTarget) {
          dialogues.push({ scene: scene.heading, text: el.text });
          isTarget = false;
        } else if (el.type !== "Parenthetical") {
          isTarget = false;
        }
      }
    }

    if (dialogues.length === 0) {
      return { content: [{ type: "text", text: `No dialogue found for character "${character_name}".` }] };
    }

    let text = `Dialogue for ${target} (${dialogues.length} lines):\n\n`;
    for (const d of dialogues) {
      text += `  [${d.scene}]\n    ${d.text}\n\n`;
    }
    return { content: [{ type: "text", text }] };
  }
);

// Tool: Add a new scene
server.tool(
  "add_scene",
  "Add a new scene to a Final Draft .fdx script. Provide the scene heading and elements (Character, Dialogue, Action, Parenthetical, Transition).",
  {
    file_path: z.string().describe("Absolute path to the .fdx file"),
    scene_heading: z.string().describe("Scene heading, e.g. 'INT. OFFICE - DAY'"),
    elements: z.array(z.object({
      type: z.enum(["Character", "Dialogue", "Action", "Parenthetical", "Transition"]),
      text: z.string(),
    })).describe("Array of script elements in order"),
    position: z.union([z.literal("start"), z.literal("end"), z.number()])
      .optional()
      .describe("Where to insert: 'start', 'end' (default), or scene number to insert after"),
    push_to_app: z.boolean().optional().describe("If true, open/reload the file in Final Draft app (default: true)"),
  },
  async ({ file_path, scene_heading, elements, position, push_to_app }) => {
    let fdxContent = readFdxRaw(file_path);
    const sceneXml = sceneToFdxXml(scene_heading, elements);
    fdxContent = insertSceneIntoFdx(fdxContent, sceneXml, position || "end");
    fs.writeFileSync(file_path, fdxContent, "utf-8");

    let result = `Added scene "${scene_heading}" to ${path.basename(file_path)}`;

    if (push_to_app !== false) {
      try {
        pushToFinalDraft(file_path);
        result += "\nPushed to Final Draft app.";
      } catch (err) {
        result += `\nNote: Could not push to Final Draft app: ${err.message}`;
      }
    }

    return { content: [{ type: "text", text: result }] };
  }
);

// Tool: Edit a scene
server.tool(
  "edit_scene",
  "Replace the contents of a specific scene in a Final Draft script.",
  {
    file_path: z.string().describe("Absolute path to the .fdx file"),
    scene_number: z.number().describe("Scene number to replace (1-indexed)"),
    new_heading: z.string().optional().describe("New scene heading (or keep existing)"),
    new_elements: z.array(z.object({
      type: z.enum(["Character", "Dialogue", "Action", "Parenthetical", "Transition"]),
      text: z.string(),
    })).describe("New array of script elements to replace scene content"),
    push_to_app: z.boolean().optional().describe("If true, open/reload in Final Draft (default: true)"),
  },
  async ({ file_path, scene_number, new_heading, new_elements, push_to_app }) => {
    let fdxContent = readFdxRaw(file_path);
    const parsed = parseFdx(fdxContent);
    const paragraphs = extractParagraphs(parsed);
    const scenes = paragraphsToScenes(paragraphs);

    if (scene_number < 1 || scene_number > scenes.length) {
      return { content: [{ type: "text", text: `Invalid scene number. Script has ${scenes.length} scenes.` }] };
    }

    const scene = scenes[scene_number - 1];
    const heading = new_heading || scene.heading;

    // Find the scene heading in raw XML and replace until next scene heading
    const sceneHeadingRegex = /<Paragraph Type="Scene Heading">/g;
    let match;
    let count = 0;
    let sceneStart = -1;
    let sceneEnd = -1;

    // For the first "scene" which might not have a heading
    if (scene.heading === "(Opening - No Scene Heading)") {
      // Replace from <Content> to first Scene Heading
      const contentStart = fdxContent.indexOf("<Content>") + "<Content>".length;
      const firstSceneHeading = fdxContent.indexOf('<Paragraph Type="Scene Heading">');
      if (firstSceneHeading === -1) {
        sceneStart = contentStart;
        sceneEnd = fdxContent.indexOf("</Content>");
      } else {
        sceneStart = contentStart;
        sceneEnd = fdxContent.lastIndexOf("\n", firstSceneHeading);
      }
    } else {
      while ((match = sceneHeadingRegex.exec(fdxContent)) !== null) {
        count++;
        if (count === scene_number - (scenes[0].heading === "(Opening - No Scene Heading)" ? 0 : 0)) {
          // Find the <Paragraph that contains this Scene Heading
          sceneStart = fdxContent.lastIndexOf("<Paragraph", match.index);
        }
        if (count === scene_number + 1 - (scenes[0].heading === "(Opening - No Scene Heading)" ? 0 : 0)) {
          sceneEnd = fdxContent.lastIndexOf("<Paragraph", match.index);
          break;
        }
      }

      // Handle edge: count scenes properly
      // Re-do with simpler logic
      const allMatches = [...fdxContent.matchAll(/<Paragraph Type="Scene Heading">/g)];
      const hasOpening = scenes[0].heading === "(Opening - No Scene Heading)";
      const sceneIdx = hasOpening ? scene_number - 1 : scene_number - 1;

      if (sceneIdx < allMatches.length) {
        sceneStart = fdxContent.lastIndexOf("<Paragraph", allMatches[sceneIdx].index);
        if (sceneIdx + 1 < allMatches.length) {
          sceneEnd = fdxContent.lastIndexOf("<Paragraph", allMatches[sceneIdx + 1].index);
          // Back up to newline
          sceneEnd = fdxContent.lastIndexOf("\n", sceneEnd) + 1;
        } else {
          sceneEnd = fdxContent.indexOf("</Content>");
        }
      }
    }

    if (sceneStart === -1) {
      return { content: [{ type: "text", text: "Could not locate scene in FDX XML." }] };
    }
    if (sceneEnd === -1) {
      sceneEnd = fdxContent.indexOf("</Content>");
    }

    const newSceneXml = sceneToFdxXml(heading, new_elements);
    fdxContent = fdxContent.slice(0, sceneStart) + newSceneXml + "\n" + fdxContent.slice(sceneEnd);
    fs.writeFileSync(file_path, fdxContent, "utf-8");

    let result = `Replaced scene ${scene_number} ("${heading}") in ${path.basename(file_path)}`;

    if (push_to_app !== false) {
      try {
        pushToFinalDraft(file_path);
        result += "\nPushed to Final Draft app.";
      } catch (err) {
        result += `\nNote: Could not push to Final Draft app: ${err.message}`;
      }
    }

    return { content: [{ type: "text", text: result }] };
  }
);

// Tool: Delete a scene
server.tool(
  "delete_scene",
  "Delete a scene from a Final Draft .fdx script by scene number.",
  {
    file_path: z.string().describe("Absolute path to the .fdx file"),
    scene_number: z.number().describe("Scene number to delete (1-indexed)"),
    push_to_app: z.boolean().optional().describe("If true, open/reload in Final Draft (default: true)"),
  },
  async ({ file_path, scene_number, push_to_app }) => {
    let fdxContent = readFdxRaw(file_path);
    const parsed = parseFdx(fdxContent);
    const paragraphs = extractParagraphs(parsed);
    const scenes = paragraphsToScenes(paragraphs);

    if (scene_number < 1 || scene_number > scenes.length) {
      return { content: [{ type: "text", text: `Invalid scene number. Script has ${scenes.length} scenes.` }] };
    }

    const allMatches = [...fdxContent.matchAll(/<Paragraph Type="Scene Heading">/g)];
    const hasOpening = scenes[0].heading === "(Opening - No Scene Heading)";
    const sceneIdx = hasOpening ? scene_number - 1 : scene_number - 1;

    let sceneStart, sceneEnd;

    if (sceneIdx < allMatches.length) {
      sceneStart = fdxContent.lastIndexOf("<Paragraph", allMatches[sceneIdx].index);
      if (sceneIdx + 1 < allMatches.length) {
        sceneEnd = fdxContent.lastIndexOf("<Paragraph", allMatches[sceneIdx + 1].index);
        sceneEnd = fdxContent.lastIndexOf("\n", sceneEnd) + 1;
      } else {
        sceneEnd = fdxContent.indexOf("</Content>");
      }
    } else {
      return { content: [{ type: "text", text: "Could not locate scene in FDX XML." }] };
    }

    fdxContent = fdxContent.slice(0, sceneStart) + fdxContent.slice(sceneEnd);
    fs.writeFileSync(file_path, fdxContent, "utf-8");

    let result = `Deleted scene ${scene_number} from ${path.basename(file_path)}`;

    if (push_to_app !== false) {
      try {
        pushToFinalDraft(file_path);
        result += "\nPushed to Final Draft app.";
      } catch (err) {
        result += `\nNote: Could not push to Final Draft app: ${err.message}`;
      }
    }

    return { content: [{ type: "text", text: result }] };
  }
);

// Tool: Push to Final Draft
server.tool(
  "push_to_final_draft",
  "Open or reload an .fdx file in the Final Draft application via AppleScript.",
  {
    file_path: z.string().describe("Absolute path to the .fdx file"),
  },
  async ({ file_path }) => {
    try {
      pushToFinalDraft(file_path);
      return { content: [{ type: "text", text: `Opened ${path.basename(file_path)} in Final Draft.` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}\n\nMake sure Final Draft is installed.` }] };
    }
  }
);

// Tool: Get active document from Final Draft
server.tool(
  "get_active_document",
  "Get the file path of the currently active document in Final Draft.",
  {},
  async () => {
    try {
      const docPath = getFinalDraftFrontDoc();
      return { content: [{ type: "text", text: `Active document: ${docPath}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Could not get active document: ${err.message}\n\nMake sure Final Draft is running with a document open.` }] };
    }
  }
);

// Tool: Check if Final Draft is running
server.tool(
  "check_final_draft_status",
  "Check if Final Draft application is currently running.",
  {},
  async () => {
    const running = isFinalDraftRunning();
    return {
      content: [{ type: "text", text: running ? "Final Draft is running." : "Final Draft is not running." }],
    };
  }
);

// Tool: Create a new empty script
server.tool(
  "create_script",
  "Create a new blank Final Draft .fdx script file.",
  {
    file_path: z.string().describe("Absolute path for the new .fdx file"),
    title: z.string().optional().describe("Script title"),
    author: z.string().optional().describe("Author name"),
    open_in_app: z.boolean().optional().describe("If true, open in Final Draft (default: true)"),
  },
  async ({ file_path, title, author, open_in_app }) => {
    const titleText = title || "Untitled";
    const authorText = author || "";

    const fdx = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<FinalDraft DocumentType="Script" Template="No" Version="5">

  <Content>
    <Paragraph Type="Scene Heading">
      <SceneProperties Length="" Page="1" Title="">
      </SceneProperties>
      <Text>INT. LOCATION - DAY</Text>
    </Paragraph>
    <Paragraph Type="Action">
      <Text></Text>
    </Paragraph>
  </Content>

  <TitlePage>
    <Content>
      <Paragraph Alignment="Center" Type="Title Page">
        <Text>${escapeXml(titleText)}</Text>
      </Paragraph>
      <Paragraph Alignment="Center" Type="Title Page">
        <Text>Written by</Text>
      </Paragraph>
      <Paragraph Alignment="Center" Type="Title Page">
        <Text>${escapeXml(authorText)}</Text>
      </Paragraph>
    </Content>
  </TitlePage>

</FinalDraft>`;

    fs.writeFileSync(file_path, fdx, "utf-8");
    let result = `Created new script: ${file_path}`;

    if (open_in_app !== false) {
      try {
        pushToFinalDraft(file_path);
        result += "\nOpened in Final Draft.";
      } catch (err) {
        result += `\nNote: Could not open in Final Draft: ${err.message}`;
      }
    }

    return { content: [{ type: "text", text: result }] };
  }
);

// Tool: Search script
server.tool(
  "search_script",
  "Search for text in a Final Draft script. Returns matching paragraphs with their scene context.",
  {
    file_path: z.string().describe("Absolute path to the .fdx file"),
    query: z.string().describe("Text to search for (case insensitive)"),
    type_filter: z.enum(["all", "Dialogue", "Action", "Character", "Scene Heading"])
      .optional()
      .describe("Filter by paragraph type (default: all)"),
  },
  async ({ file_path, query, type_filter }) => {
    const xml = readFdxRaw(file_path);
    const parsed = parseFdx(xml);
    const paragraphs = extractParagraphs(parsed);
    const scenes = paragraphsToScenes(paragraphs);
    const q = query.toLowerCase();

    const results = [];
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      // Check heading
      if ((!type_filter || type_filter === "all" || type_filter === "Scene Heading") &&
          scene.heading.toLowerCase().includes(q)) {
        results.push({ scene: i + 1, heading: scene.heading, type: "Scene Heading", text: scene.heading });
      }
      for (const el of scene.elements) {
        if (type_filter && type_filter !== "all" && el.type !== type_filter) continue;
        if (el.text.toLowerCase().includes(q)) {
          results.push({ scene: i + 1, heading: scene.heading, type: el.type, text: el.text });
        }
      }
    }

    if (results.length === 0) {
      return { content: [{ type: "text", text: `No results found for "${query}".` }] };
    }

    let text = `Found ${results.length} matches for "${query}":\n\n`;
    for (const r of results) {
      text += `  [Scene ${r.scene}: ${r.heading}] (${r.type})\n    ${r.text}\n\n`;
    }
    return { content: [{ type: "text", text }] };
  }
);

// ─── Start Server ──────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
const mode = process.argv.includes("--stdio") ? "stdio" : "http";

async function main() {
  if (mode === "stdio") {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } else {
    let sseTransport = null;

    const httpServer = http.createServer(async (req, res) => {
      // CORS headers
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.url === "/sse" && req.method === "GET") {
        sseTransport = new SSEServerTransport("/messages", res);
        await server.connect(sseTransport);
        return;
      }

      if (req.url === "/messages" && req.method === "POST") {
        if (!sseTransport) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No SSE connection. Connect to /sse first." }));
          return;
        }
        await sseTransport.handlePostMessage(req, res);
        return;
      }

      // Health check
      if (req.url === "/" || req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", name: "final-draft-connector", version: "1.0.0" }));
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    httpServer.listen(PORT, () => {
      console.log(`Final Draft MCP server running at http://localhost:${PORT}`);
      console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
    });
  }
}

main().catch(console.error);
