
import { GoogleGenAI, Type } from "@google/genai";
import { ChatMessage, WorkspaceType, AIProvider, GenerationMode, GenerationResult } from "../types";
import { Logger } from "./Logger";

const BASE_ROLE = `You are a "Lovable-style" Autonomous AI Full-Stack App Builder.
Your goal is to build 100% COMPLETE, functional, and production-ready MOBILE APPLICATIONS. Build WEB ADMIN DASHBOARDS and DATABASE layers ONLY when the user explicitly requests them or the requested feature clearly requires persistent backend data.

IMPORTANT: All generated code MUST be compatible with modern web browsers (Vite/React). DO NOT use Node.js/CommonJS specific features like 'require', 'module.exports', or the global 'process' object in client-side code. NEVER call a React component as a function (e.g., {Component()}); ALWAYS use JSX syntax (<Component />).`;

const DEEP_THINKING = `### 🧠 DEEP THINKING PROTOCOL (MANDATORY):
Before generating any code, you MUST use the "thought" field to perform a deep analysis:
1. **LOGICAL BREAKDOWN:** Explain the step-by-step logic of how the requested feature will work.
2. **MODULAR STRATEGY:** Explain why you are choosing specific files and folders for this implementation.
3. **ERROR ANTICIPATION:** Identify at least 3 potential errors or edge cases that could occur with this implementation and explain how you will prevent them.
4. **DATABASE SYNC:** Explain how the data will stay synchronized between the Mobile App and the Admin Dashboard.
5. **UI/UX REASONING:** Explain the design choices for both interfaces to ensure they are professional and user-friendly.`;

const FIRST_COMMAND_COMPLETION = `### 🏁 FIRST COMMAND COMPLETION MODE:
If this is a brand-new app generation request (initial scaffold), deliver an almost fully workable app in the first response:
1. Build complete core user flows requested by the user (not placeholders).
2. Include required wiring between UI, state, and services.
3. Avoid TODO-only stubs unless explicitly requested.
4. Keep implementation aligned exactly with the user's instruction scope.`;

const STRICT_SCOPE_EDITING = `### 🎯 STRICT CHANGE BOUNDARY (MANDATORY FOR EDITS):
When editing an existing project:
1. **FIXING ERRORS (PRIORITY):** If the user is asking to fix an error, you MUST do whatever is necessary to resolve it, even if it requires refactoring or structural changes. The fix takes priority over "minimal changes".
2. **FEATURE REQUESTS:** Change ONLY what the user explicitly asked for. Do NOT do extra refactors, styling tweaks, or optimizations unless requested.
3. **NO UNRELATED CHANGES:** Do NOT add new features, dependencies, or architectural changes that were not requested.
4. **STYLE PRESERVATION:** Always respect the existing UI and design unless the request is specifically to change it.`;

const UNIT_TESTING = `### 🧪 UNIT TESTING PROTOCOL (MANDATORY):
For any complex logic, services, or utility functions:
1. **TEST GENERATION:** You MUST create a \`tests/\` directory INSIDE the workspace (e.g., \`app/tests/\` or \`admin/tests/\`) and write unit tests using a simple assertion pattern (e.g., \`if (result !== expected) throw new Error(...)\`).
2. **CRITICAL LOGIC COVERAGE:** Focus on edge cases, data transformations, and database interactions.
3. **SELF-VERIFICATION:** Explain in your "thought" process how these tests verify the correctness of your code.`;

const DEPENDENCY_GRAPH = `### 🧠 DEPENDENCY GRAPH & MEMORY (MANDATORY):
You MUST track and respect the relationship between files:
1. **FLOW:** Component -> Service -> Database.
2. **IMPACT ANALYSIS:** If you change a Database table, you MUST update the corresponding Service and then the Component.
3. **IMPORT CHECK:** Always verify that imports are correct and the file exists in the PROJECT MAP.`;

const SURGICAL_EDITING = `### ✂️ SURGICAL EDITING & MIGRATION (STRICT):
1. **MINIMAL CHANGES:** For feature requests, only change the specific lines required. For error fixes, apply the most robust solution.
2. **REACT HOOKS (CRITICAL):** Ensure hooks are ONLY called inside functional components or custom hooks. NEVER render a component by calling it as a function (e.g., use \`<Component />\`, NOT \`Component()\`).
3. **STYLE PRESERVATION:** You MUST respect the existing UI, layout, and design of the file you are editing. DO NOT change colors, spacing, or fonts unless explicitly asked.
4. **DATABASE MIGRATIONS:** If the database schema changes, do NOT overwrite \`database.sql\`. Instead, create a new file \`migrations/YYYYMMDD_description.sql\`.
6. **STRICT REACT HOOKS & COMPONENTS (CRITICAL):**
   - NEVER call a React component as a function (e.g., \`{MyComponent()}\`). ALWAYS use JSX syntax (e.g., \`<MyComponent />\`). Calling components as functions causes "Cannot read properties of null (reading 'useContext')" errors.
   - Ensure all hooks (\`useContext\`, \`useRef\`, \`useState\`, etc.) are called at the top level of functional components.
   - If using a Context, ensure the component is properly wrapped in its \`Provider\`.
   - Avoid dynamic \`require()\` calls; use ESM \`import\` statements exclusively to prevent "Dynamic require not supported" errors.
5. **NO DELETIONS:** Never delete existing features or styles unless explicitly asked.`;

const MANDATORY_RULES = `### 🛠 MANDATORY RULES:
1. **MANDATORY TYPESCRIPT ENFORCEMENT (CRITICAL):**
   - You MUST use **TypeScript** for ALL logic and component files.
   - Avoid using \`any\`. Use strict typing.

2. **MODULAR CODE ARCHITECTURE:**
   - Break down code into small, manageable files.
   - Folder structure: \`components/\`, \`hooks/\`, \`services/\`, \`utils/\`, \`styles/\`.

3. **ADMIN DASHBOARD POLICY:**
   - DO NOT create an \`admin/\` dashboard by default, even if the app seems to need one (e.g., for multi-user management or inventory).
   - ONLY create an \`admin/\` dashboard if the user EXPLICITLY requests it in their prompt.
   - Focus all coding efforts on the primary \`app/\` interface unless an admin panel is specifically requested.

4. **DATABASE FILE POLICY (CRITICAL):**
   - DO NOT create or modify \`database.sql\` by default.
   - ONLY include \`database.sql\` or migration files when the user explicitly requests database/backend/auth/storage work, or when persistence is mandatory for the requested feature.
   - If the task is only UI/UX/frontend behavior, return NO database file changes.

5. **VITE ENVIRONMENT SAFETY (CRITICAL):**
   - In browser/client code, NEVER use \`process.env\`.
   - ALWAYS use \`import.meta.env.VITE_*\` for public environment variables.
   - Guard env usage with a safe fallback/check and show a clear error message instead of crashing.

6. **SUPABASE QUESTION POLICY (CRITICAL):**
   - Ask for Supabase credentials (question type \`supabase_credentials\`) ONLY AFTER the user explicitly asks to create/build an admin dashboard.
   - If user request is not explicitly about creating/admin dashboard, do NOT ask for Supabase credentials.

7. **REACT COMPONENT INTEGRITY (CRITICAL):**
   - NEVER call a React component as a function (e.g., \`{MyComponent()}\` or \`const x = MyComponent()\`).
   - ALWAYS use JSX syntax: \`<MyComponent />\`.
   - Calling components as functions breaks React's hook system and causes "Cannot read properties of null (reading 'useContext')" errors. This is a non-negotiable rule.

8. **HALLUCINATION GUARD:**
   - ONLY use packages already listed in \`package.json\`.
   - If a new package is absolutely necessary, you MUST add it to the \`dependencies\` section of \`package.json\` in the same response.
   - For icons, ONLY use valid exports from \`lucide-react\`. Do not invent icon names (e.g., use 'Delete' or 'Trash2' instead of 'Backspace').

9. **STRICT DIRECTORY ENFORCEMENT:**
   - **Mobile App:** \`app/\`.
   - **Admin Dashboard:** \`admin/\`.
   - **Root:** ONLY \`database.sql\`, \`migrations/\`, \`package.json\`, \`README.md\`.`;

const DESIGN_SYSTEM = `### 🎨 DESIGN SYSTEM GUIDELINES:
1. **NEW COMPONENTS ONLY:** The following design rules apply ONLY to entirely new components.
2. **EXISTING FILES:** When editing existing files, ALWAYS match the current style of the project.
3. **DEFAULT PALETTE:** Use neutral and modern colors (e.g., Blue, Indigo, or Violet as primary) unless the user specifies a brand color.
4. **SPACING & RADIUS:** Use Tailwind scale. \`rounded-xl\` for cards/buttons, \`rounded-2xl\` for containers.
5. **TYPOGRAPHY:** Inter font. Headings: semibold, tracking-tight. Body: normal, leading-relaxed.`;

const PATCH_MODE_RULE = `### 🔧 PATCH MODE (WHEN EDITING EXISTING FILES):
If the file already exists in the PROJECT MAP:
- DO NOT return the full file.
- Return ONLY a unified diff patch format.
- Use standard unified diff format:

Example:
--- app/components/Button.tsx
+++ app/components/Button.tsx
@@ -12,7 +12,7 @@
- const color = "red";
+ const color = "blue";

If creating a NEW file:
- Return full file normally.`;

const RESPONSE_FORMAT = `### 🚀 RESPONSE FORMAT (JSON ONLY):
{
  "thought": "DETAILED DEEP THINKING ANALYSIS (Logic, Strategy, Errors, Sync, UI/UX) in the User's language.",
  "questions": [], // Use "supabase_credentials" ONLY when user explicitly asked to create admin dashboard.
  "plan": ["Step 1...", "Step 2..."],
  "answer": "Summary of changes.",
  "files": { 
    "app/components/NewComponent.tsx": "...",
    "migrations/20240224_add_field.sql": "..."
  }
}`;

const PLANNING_PROMPT = `You are the "Architect Model". Your task is to create a detailed technical plan for the requested feature.
Focus on:
1. Database schema changes (ONLY if explicitly required by the user request).
2. File structure and modularity.
3. Logic flow between App and Admin (ONLY if admin panel is requested).
4. Potential edge cases.
Output ONLY a JSON object with "thought" and "plan" (array of steps).`;

const CODING_PROMPT = `You are the "Developer Model". Your task is to implement the provided technical plan.
Follow the plan strictly. Use TypeScript and maintain modularity.
Output ONLY a JSON object with "answer" and "files" (Record<string, string>).`;

const REVIEW_PROMPT = `You are the "Reviewer Model". Your task is to review the generated code for errors, bugs, or missing logic.
If you find issues, provide the corrected files.
Output ONLY a JSON object with "thought" (review findings) and "files" (only if corrections are needed).`;

const OPTIMIZATION_PROMPT = `You are the "Security Model". Your task is to ensure the code follows security best practices.
Check for:
1. SQL injection vulnerabilities.
2. Proper authentication/authorization checks.
3. Sensitive data exposure.
4. Secure API communication.
Output ONLY a JSON object with "thought" (security findings) and "files" (only if changes are needed).`;

const PERFORMANCE_PROMPT = `You are the "Performance Audit Model". Your task is to ensure the code is highly performant and free of memory leaks.
Check for:
1. Memory leaks (uncleaned useEffects, event listeners).
2. Unnecessary React re-renders (missing memo, useMemo, useCallback).
3. Heavy computations in the main thread.
4. Efficient data fetching and caching.
Output ONLY a JSON object with "thought" (performance findings) and "files" (only if changes are needed).`;

const UI_UX_PROMPT = `You are the "UI/UX Designer Model". Your task is to ensure the code strictly follows the MANDATORY DESIGN SYSTEM.
Check for:
1. Consistent color usage (Emerald/Slate/Zinc).
2. Consistent border radius (rounded-xl/2xl).
3. Proper spacing and alignment.
4. Professional typography (Inter).
Output ONLY a JSON object with "thought" (design findings) and "files" (only if changes are needed).`;

export class GeminiService implements AIProvider {
  private extractBalancedJsonBlock(input: string): string | null {
    const start = input.indexOf('{');
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < input.length; i++) {
      const ch = input[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          return input.slice(start, i + 1);
        }
      }
    }

    return null;
  }

  private parseModelJson(rawText: string): any {
    const text = (rawText || '{}').trim();

    const tryParse = (str: string) => {
      try {
        return JSON.parse(str);
      } catch (e) {
        // Try repairing truncated/broken JSON
        const fixed = str
          .replace(/[\u0000-\u001F]/g, ' ')  // remove control characters
          .replace(/,\s*([}\]])/g, '$1');    // fix trailing commas
        try {
          return JSON.parse(fixed);
        } catch (e2) {
          return null;
        }
      }
    };

    // 1) Direct parse first
    let result = tryParse(text);
    if (result) return result;

    // 2) Parse fenced JSON block if present
    const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i)?.[1]?.trim();
    if (fenced) {
      result = tryParse(fenced);
      if (result) return result;
    }

    // 3) Parse first syntactically balanced JSON object from mixed text
    const balanced = this.extractBalancedJsonBlock(text);
    if (balanced) {
      result = tryParse(balanced);
      if (result) return result;
    }

    // 4) Legacy fallback: first { to last }
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const slice = text.substring(firstBrace, lastBrace + 1);
      result = tryParse(slice);
      if (result) return result;
    }

    // 5) Ultimate Fallback: Extract Markdown Code Blocks
    // If the model completely failed to output JSON, but output markdown code blocks.
    const files: Record<string, string> = {};
    let foundFiles = false;
    
    // Split by code blocks
    const parts = text.split(/```[a-zA-Z]*\n/);
    for (let i = 1; i < parts.length; i++) {
        const codePart = parts[i].split('```')[0];
        if (codePart) {
            // Try to find a filename in the text immediately preceding the code block
            const precedingText = parts[i-1].trim();
            const lines = precedingText.split('\n');
            const lastLine = lines[lines.length - 1].trim();
            
            // Look for something that looks like a file path
            const fileMatch = lastLine.match(/([a-zA-Z0-9_.\-/]+\.[a-zA-Z0-9]+)/);
            const filename = fileMatch ? fileMatch[1] : `extracted_file_${i}.ts`;
            
            files[filename] = codePart.trim();
            foundFiles = true;
        }
    }

    if (foundFiles) {
      return {
        thought: "JSON parsing failed due to truncation or syntax errors. Extracted files from markdown blocks as a fallback.",
        files: files
      };
    }

    // If all else fails, throw the original error to trigger retry
    return JSON.parse(text);
  }

  private isLocalModel(modelName: string): boolean {
    const name = modelName.toLowerCase();
    return name.includes('local') || name.includes('llama') || name.includes('qwen') || name.includes('coder');
  }

  async callPhase(
    phase: 'planning' | 'coding' | 'review' | 'security' | 'performance' | 'uiux',
    input: string,
    modelName: string = 'gemini-3-pro-preview',
    retries: number = 3
  ): Promise<any> {
    // ... (systemInstruction setup remains same)
    let systemInstruction = '';
    switch (phase) {
      case 'planning': 
        systemInstruction = `${BASE_ROLE}\n\n${DEEP_THINKING}\n\n${FIRST_COMMAND_COMPLETION}\n\n${STRICT_SCOPE_EDITING}\n\n${DEPENDENCY_GRAPH}\n\n${MANDATORY_RULES}\n\n${PLANNING_PROMPT}\n\n${RESPONSE_FORMAT}`; 
        break;
      case 'coding': 
        systemInstruction = `${BASE_ROLE}\n\n${DEEP_THINKING}\n\n${FIRST_COMMAND_COMPLETION}\n\n${STRICT_SCOPE_EDITING}\n\n${UNIT_TESTING}\n\n${DEPENDENCY_GRAPH}\n\n${SURGICAL_EDITING}\n\n${PATCH_MODE_RULE}\n\n${MANDATORY_RULES}\n\n${DESIGN_SYSTEM}\n\n${CODING_PROMPT}\n\n${RESPONSE_FORMAT}`; 
        break;
      case 'review': 
        systemInstruction = `${BASE_ROLE}\n\n${STRICT_SCOPE_EDITING}\n\n${SURGICAL_EDITING}\n\n${PATCH_MODE_RULE}\n\n${REVIEW_PROMPT}\n\n${RESPONSE_FORMAT}`; 
        break;
      case 'security': 
        systemInstruction = `${BASE_ROLE}\n\n${STRICT_SCOPE_EDITING}\n\n${SURGICAL_EDITING}\n\n${PATCH_MODE_RULE}\n\n${OPTIMIZATION_PROMPT}\n\n${RESPONSE_FORMAT}`; 
        break;
      case 'performance': 
        systemInstruction = `${BASE_ROLE}\n\n${STRICT_SCOPE_EDITING}\n\n${SURGICAL_EDITING}\n\n${PATCH_MODE_RULE}\n\n${PERFORMANCE_PROMPT}\n\n${RESPONSE_FORMAT}`; 
        break;
      case 'uiux': 
        systemInstruction = `${BASE_ROLE}\n\n${STRICT_SCOPE_EDITING}\n\n${DESIGN_SYSTEM}\n\n${SURGICAL_EDITING}\n\n${PATCH_MODE_RULE}\n\n${UI_UX_PROMPT}\n\n${RESPONSE_FORMAT}`; 
        break;
    }

    if (this.isLocalModel(modelName)) {
      return this.callPhaseWithOllama(modelName, systemInstruction, input);
    }

    const key = process.env.GEMINI_API_KEY || process.env.API_KEY;
    if (!key || key === "undefined") throw new Error("GEMINI_API_KEY not found.");

    const ai = new GoogleGenAI({ apiKey: key });
    const model = modelName.includes('pro') ? 'gemini-3-pro-preview' : 'gemini-3-flash-preview';

    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: [{ parts: [{ text: input }] }],
          config: { 
            systemInstruction: { parts: [{ text: systemInstruction }] },
            responseMimeType: "application/json", 
            temperature: 0.1 
          }
        });
        
        return this.parseModelJson(response.text || '{}');
      } catch (error: any) {
        Logger.warn(`Attempt ${attempt} failed`, { component: 'GeminiService', model, attempt }, error);
        lastError = error;
        if (attempt < retries) {
          const delay = Math.pow(2, attempt) * 1000; // Exponential backoff: 2s, 4s, 8s
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    throw new Error(`Gemini API failed after ${retries} attempts: ${lastError?.message}`);
  }

  private async callPhaseWithOllama(model: string, system: string, prompt: string): Promise<any> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 minute timeout for local models

    try {
      const response = await fetch('http://127.0.0.1:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt }
          ],
          stream: false,
          format: 'json'
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!response.ok) throw new Error(`Ollama error: ${response.statusText}`);
      const data = await response.json();
      
      let content = data.message.content;
      // Sanitize markdown code blocks if present
      content = content.replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
      return JSON.parse(content);
    } catch (e: any) {
      clearTimeout(timeoutId);
      Logger.error("Phase call failed", e, { component: 'GeminiService', model, provider: 'Ollama' });
      throw new Error(`Local model execution failed: ${e.message}. Ensure Ollama is running at http://127.0.0.1:11434 and OLLAMA_ORIGINS="*" is set.`);
    }
  }
}
