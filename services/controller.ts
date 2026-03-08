
import { GenerationMode, GenerationResult, WorkspaceType, ChatMessage, DependencyNode } from "../types";
import { ModeDetector } from "./ModeDetector";
import { DiffEngine } from "./DiffEngine";
import { Validator } from "./Validator";
import { Orchestrator } from "./Orchestrator";
import { GeminiService } from "./geminiService";

import { Logger } from "./Logger";
import { LRUCache } from "../utils/LRUCache";

export class AIController {
  private modeDetector: typeof ModeDetector;
  private diffEngine: DiffEngine;
  private validator: Validator;
  private orchestrator: Orchestrator;
  
  private dependencyGraph: DependencyNode[] = [];
  private dependencyNodeCache = new Map<string, { hash: string, node: DependencyNode }>();
  private memory = {
    lastPromptHash: "",
    fileHashes: new Map<string, string>(),
    dependencyGraphSnapshot: [] as DependencyNode[],
    lastMode: null as GenerationMode | null,
    phaseCache: new LRUCache<string, any>(50),
    lastResult: null as GenerationResult | null
  };

  constructor(
    diffEngine?: DiffEngine,
    validator?: Validator,
    orchestrator?: Orchestrator,
    gemini?: GeminiService
  ) {
    this.modeDetector = ModeDetector;
    
    try {
      this.diffEngine = diffEngine || new DiffEngine();
      this.validator = validator || new Validator();
      const geminiService = gemini || new GeminiService();
      this.orchestrator = orchestrator || new Orchestrator(this.diffEngine, geminiService);
    } catch (error) {
      Logger.error("Initialization failed", error, { component: 'AIController' });
      throw new Error("Failed to initialize AI Controller dependencies.");
    }
  }

  /**
   * Main entry point for the AI Brain
   */
  async *processRequest(
    prompt: string,
    currentFiles: Record<string, string>,
    history: ChatMessage[] = [],
    activeWorkspace?: WorkspaceType | boolean,
    modelName: string = 'gemini-3-pro-preview'
  ): AsyncIterable<any> {
    const correlationId = crypto.randomUUID();
    const logContext = { component: 'AIController', correlationId, modelName };
    
    // Cache Management handled by LRUCache automatically

    const fileChanged = this.diffEngine.detectFileChanges(currentFiles, this.memory.fileHashes);
    if (fileChanged) {
      Logger.info("Manual file changes detected → invalidating cache", logContext);
      this.memory.phaseCache.clear();
      this.memory.lastPromptHash = "";
      this.memory.lastResult = null;
    }

    // 1. Mode Detection
    const mode = this.modeDetector.detectMode(prompt, currentFiles);
    Logger.info(`Mode Detected: ${mode.toUpperCase()}`, { ...logContext, mode });
    yield { type: 'status', phase: 'PLANNING', message: `Mode Detected: ${mode.toUpperCase()}` };

    const originalPromptHash = this.diffEngine.hashContent(prompt);

    // Smart Skip Logic (Early Exit)
    if (
      originalPromptHash === this.memory.lastPromptHash &&
      mode === this.memory.lastMode &&
      mode !== GenerationMode.FIX &&
      this.memory.lastResult
    ) {
      Logger.info("No changes detected. Returning cached result.", logContext);
      yield { type: 'status', phase: 'PREVIEW_READY', message: "No changes detected. Using cache." };
      yield { type: 'result', ...this.memory.lastResult };
      return;
    }

    // 2. Dependency Mapping (Memory Graph)
    yield { type: 'status', phase: 'PLANNING', message: "Mapping dependencies..." };
    this.updateDependencyGraph(currentFiles);

    // 3. Orchestration Loop
    let attempts = 0;
    const maxAttempts = 5;
    let finalResult: GenerationResult | null = null;
    let failedPatchFiles = new Set<string>();

    // 3.1 Pre-emptive Detection: If files are already broken, force full rewrite
    yield { type: 'status', phase: 'PLANNING', message: "Checking for broken files..." };
    const initialErrors = this.validator.validateTypeScriptSyntax(currentFiles);
    for (const err of initialErrors) {
      const match = err.match(/TS Syntax Error in ([^:]+):/);
      if (match && match[1]) {
        const brokenFile = match[1].trim();
        Logger.warn(`Pre-emptively forcing rewrite for broken file: ${brokenFile}`, logContext);
        failedPatchFiles.add(brokenFile);
      }
    }

    let errorContext = "";

    while (attempts < maxAttempts) {
      try {
        let generatedFilesThisAttempt: Record<string, string> = {};
        let currentContextFiles = { ...currentFiles }; // Files including current project state + generated files
        let accumulatedApplyErrors: string[] = [];
        let thoughts: string[] = [];
        let finalPlan: string[] = [];
        let finalAnswer: string = "Task completed successfully.";

        let currentPrompt = prompt + errorContext;
        if (failedPatchFiles.size > 0) {
          currentPrompt += `\n\n🚨 CRITICAL RECOVERY MODE:\nYou previously failed to generate valid patches for these files:\n${Array.from(failedPatchFiles).map(f => `- ${f}`).join('\n')}\n\nFor these specific files ONLY, DO NOT USE PATCHES. You MUST return the FULL, complete file content.`;
        }

        // Helper to apply files and accumulate errors
        const applyAndValidateGeneratedFiles = (phaseFiles: Record<string, string>) => {
          generatedFilesThisAttempt = { ...generatedFilesThisAttempt, ...phaseFiles };
          const { merged, errors } = this.diffEngine.applyChanges(currentContextFiles, phaseFiles, failedPatchFiles);
          currentContextFiles = merged;
          accumulatedApplyErrors.push(...errors);

          for (const err of errors) {
            const patchMatch = err.match(/Failed to apply patch for ([^\\s:]+)/);
            const fullFileMatch = err.match(/File ([^\\s:]+) was returned as a full file/);
            const target = (patchMatch && patchMatch[1]) || (fullFileMatch && fullFileMatch[1]);
            if (target) {
              const cleanedTarget = target.replace(/[,.]$/, '').trim();
              Logger.warn(`Adding ${cleanedTarget} to failedPatchFiles for recovery.`, logContext);
              failedPatchFiles.add(cleanedTarget);
            }
          }

          this.updateDependencyGraph(currentContextFiles); // Update graph with newly merged files
        };

        const isPatchMode = false; // Disabled: Always use full files for reliability
        let patchInstruction = "\nFULL FILE MODE:\nAlways return the COMPLETE file content for any file you create or modify.\nDO NOT use patches, diffs, or partial snippets.\nDO NOT start the file with '--- filename' or any diff headers. Just return the raw code.\n";

        const strictEditBoundaryInstruction = mode === GenerationMode.SCAFFOLD
          ? ""
          : "\n\n🎯 STRICT CHANGE BOUNDARY:\nImplement ONLY what the user explicitly requested.\nDo not add extra improvements, refactors, style tweaks, or unrelated fixes.";

        const phases = this.orchestrator.decidePhases(mode, []);
        Logger.info(`Running phases: ${phases.join(', ')}`, logContext);

        // Phase 1: Planning
        if (phases.includes("planning")) {
          yield { type: 'status', phase: 'PLANNING', message: "Planning architecture..." };
          const planningPrompt = currentPrompt + strictEditBoundaryInstruction;
          const input = this.orchestrator.buildPhaseInput('planning', planningPrompt, currentContextFiles, this.dependencyGraph, activeWorkspace);
          const plan = await this.orchestrator.executePhaseWithCache('planning', input, modelName, this.memory.phaseCache, mode === GenerationMode.FIX);
          thoughts.push(`[PLAN]: ${plan.thought || 'Planned architecture.'}`);
          finalPlan = plan.plan || [];

          // Pre-apply dependency audit on the plan itself (Pass A validation)
          const planValidationErrors = this.validator.validatePlan(finalPlan, currentContextFiles);
          if (planValidationErrors.length > 0) {
            // If plan validation fails, do not proceed to coding
            throw new Error(`Plan validation failed: ${planValidationErrors.join('; ')}`);
          }
        }

        // Phase 2: Coding (Developer)
        if (phases.includes("coding")) {
          yield { type: 'status', phase: 'CODING', message: "Generating code..." };
          const codingPrompt = currentPrompt + strictEditBoundaryInstruction;
          const input = mode === GenerationMode.SCAFFOLD 
            ? `PLAN:\n${JSON.stringify(finalPlan)}\n\nCONTEXT:\n${this.orchestrator.buildContext(currentContextFiles, this.dependencyGraph, currentPrompt)}`
            : `USER REQUEST:\n${codingPrompt}${patchInstruction}\n\nCONTEXT:\n${this.orchestrator.buildContext(currentContextFiles, this.dependencyGraph, currentPrompt)}`;
          const code = await this.orchestrator.executePhaseWithCache('coding', input, modelName, this.memory.phaseCache, mode === GenerationMode.FIX);
          thoughts.push(`[CODE]: ${code.thought || 'Implemented code.'}`);
          if (code.answer) finalAnswer = code.answer;
          applyAndValidateGeneratedFiles(code.files || {});
        }

        // Phase 3: Review
        if (phases.includes("review")) {
          yield { type: 'status', phase: 'REVIEW', message: "Reviewing implementation..." };
          const reviewPrompt = currentPrompt + strictEditBoundaryInstruction;
          const input = mode === GenerationMode.FIX
            ? `USER REQUEST (FIX ERROR):\n${reviewPrompt}${patchInstruction}\n\nCONTEXT:\n${this.orchestrator.buildContext(currentContextFiles, this.dependencyGraph, currentPrompt)}`
            : `GENERATED FILES:\n${JSON.stringify(generatedFilesThisAttempt)}${patchInstruction}\n\nCONTEXT:\n${this.orchestrator.buildContext(currentContextFiles, this.dependencyGraph, currentPrompt)}`;
          const review = await this.orchestrator.executePhaseWithCache('review', input, modelName, this.memory.phaseCache, mode === GenerationMode.FIX);
          thoughts.push(`[REVIEW]: ${review.thought || 'Reviewed code.'}`);
          if (mode === GenerationMode.FIX && review.answer) finalAnswer = review.answer;
          applyAndValidateGeneratedFiles(review.files || {});
        }

        // Phase 4: Security
        if (phases.includes("security")) {
          yield { type: 'status', phase: 'SECURITY', message: "Security audit..." };
          const input = mode === GenerationMode.OPTIMIZE
            ? `USER REQUEST (OPTIMIZE SECURITY):\n${currentPrompt}${patchInstruction}\n\nCONTEXT:\n${this.orchestrator.buildContext(currentContextFiles, this.dependencyGraph, currentPrompt)}`
            : `FILES TO SECURE:\n${JSON.stringify(generatedFilesThisAttempt)}${patchInstruction}\n\nCONTEXT:\n${this.orchestrator.buildContext(currentContextFiles, this.dependencyGraph, currentPrompt)}`;
          const security = await this.orchestrator.executePhaseWithCache('security', input, modelName, this.memory.phaseCache, mode === GenerationMode.FIX);
          thoughts.push(`[SECURITY]: ${security.thought || 'Security audit complete.'}`);
          if (mode === GenerationMode.OPTIMIZE && security.answer) finalAnswer = security.answer;
          applyAndValidateGeneratedFiles(security.files || {});
        }

        // Phase 5: Performance
        if (phases.includes("performance")) {
          yield { type: 'status', phase: 'PERFORMANCE', message: "Performance audit..." };
          const input = mode === GenerationMode.OPTIMIZE
            ? `USER REQUEST (OPTIMIZE PERFORMANCE):\n${currentPrompt}${patchInstruction}\n\nCONTEXT:\n${this.orchestrator.buildContext(currentContextFiles, this.dependencyGraph, currentPrompt)}`
            : `FILES TO AUDIT:\n${JSON.stringify(generatedFilesThisAttempt)}${patchInstruction}\n\nCONTEXT:\n${this.orchestrator.buildContext(currentContextFiles, this.dependencyGraph, currentPrompt)}`;
          const perf = await this.orchestrator.executePhaseWithCache('performance', input, modelName, this.memory.phaseCache, mode === GenerationMode.FIX);
          thoughts.push(`[PERF]: ${perf.thought || 'Performance audit complete.'}`);
          applyAndValidateGeneratedFiles(perf.files || {});
        }

        // Phase 6: UI/UX
        if (phases.includes("uiux")) {
          yield { type: 'status', phase: 'UIUX', message: "UI/UX polish..." };
          const input = mode === GenerationMode.OPTIMIZE
            ? `USER REQUEST (OPTIMIZE UI/UX):\n${currentPrompt}${patchInstruction}\n\nCONTEXT:\n${this.orchestrator.buildContext(currentContextFiles, this.dependencyGraph, currentPrompt)}`
            : `FILES TO POLISH:\n${JSON.stringify(generatedFilesThisAttempt)}${patchInstruction}\n\nCONTEXT:\n${this.orchestrator.buildContext(currentContextFiles, this.dependencyGraph, currentPrompt)}`;
          const uiux = await this.orchestrator.executePhaseWithCache('uiux', input, modelName, this.memory.phaseCache, mode === GenerationMode.FIX);
          thoughts.push(`[UIUX]: ${uiux.thought || 'UI/UX polish complete.'}`);
          if (mode === GenerationMode.OPTIMIZE && uiux.answer) finalAnswer = uiux.answer;
          applyAndValidateGeneratedFiles(uiux.files || {});
        }

        // 3.5 Patch Enforcement Check
        const patchViolations = this.diffEngine.enforcePatchRules(generatedFilesThisAttempt, currentFiles, failedPatchFiles);
        if (patchViolations.length > 0) {
          yield { type: 'status', phase: 'FIXING', message: "Fixing patch violations..." };
          Logger.warn(`Patch violation detected`, { ...logContext, violations: patchViolations });
          for (const v of patchViolations) {
            failedPatchFiles.add(v);
          }
          const violationMsg = `Patch violation detected for:\n${patchViolations.join('\n')}\n\nThese files already exist. You MUST return unified diff patches for them. Do NOT return the full file.`;
          errorContext = `\n\nIMPORTANT: ${violationMsg}`;
          attempts++;
          continue;
        }

        // 4. Transactional Apply & Pre-apply Dependency Audit
        // All-or-nothing: If any critical validation fails, the entire set of generated files for this attempt is rejected.
        // This prevents partial merges and ensures structural consistency.
        const filesToValidateBeforeApply = generatedFilesThisAttempt;
        const preApplyValidationErrors = this.validator.validateOutput(filesToValidateBeforeApply, currentContextFiles, this.dependencyGraph);
        preApplyValidationErrors.push(...accumulatedApplyErrors);

        if (preApplyValidationErrors.length > 0) {
          yield { type: 'status', phase: 'FIXING', message: `Pre-apply validation failed (${preApplyValidationErrors.length} errors). Rejecting changes (Attempt ${attempts + 1})...` };
          yield { type: 'validation_errors', errors: preApplyValidationErrors };
          Logger.warn(`Pre-apply validation failed (Attempt ${attempts + 1})`, { ...logContext, preApplyValidationErrors });

          // Fail-class aware retry for pre-apply errors
          errorContext = this.buildErrorContext(preApplyValidationErrors, attempts);
          attempts++;
          continue; // Retry with new error context
        }

        // If pre-apply validation passes, then the changes are considered valid for merging.
        // The `currentContextFiles` already holds the merged state after `applyAndValidateGeneratedFiles` calls.
        const mergedFiles = currentContextFiles;
        this.updateDependencyGraph(mergedFiles); // Final update after successful merge

        // 5. Runtime Validation (Post-apply sanity check - mostly for final structural consistency)
        yield { type: 'status', phase: 'REVIEW', message: "Validating final code structure..." };
        const postApplyValidationErrors = this.validator.validateOutput(mergedFiles, mergedFiles, this.dependencyGraph);

        if (postApplyValidationErrors.length > 0) {
          yield { type: 'status', phase: 'FIXING', message: `Post-apply validation failed (${postApplyValidationErrors.length} errors). (Attempt ${attempts + 1})...` };
          yield { type: 'validation_errors', errors: postApplyValidationErrors };
          Logger.warn(`Post-apply validation failed (Attempt ${attempts + 1})`, { ...logContext, postApplyValidationErrors });

          errorContext = this.buildErrorContext(postApplyValidationErrors, attempts);
          attempts++;
          continue; // Retry with new error context
        }

        // 6. Success: Finalize Result
        yield { type: 'status', phase: 'BUILDING', message: "Building application..." };
        yield { type: 'status', phase: 'PREVIEW_READY', message: "Finalizing build..." };
        finalResult = {
          files: generatedFilesThisAttempt, // Return only the files generated in this successful attempt
          answer: finalAnswer,
          thought: thoughts.join('\n\n'),
          plan: finalPlan,
          mode
        };

        this.memory.lastPromptHash = originalPromptHash;
        this.memory.lastMode = mode;
        this.memory.lastResult = finalResult;
        this.diffEngine.updateSnapshot(mergedFiles, this.memory.fileHashes);

        yield { type: 'result', ...finalResult };
        return;

      } catch (error: any) {
        Logger.error(`Generation error`, error, logContext);
        attempts++;
        if (attempts >= maxAttempts) throw error;
        yield { type: 'status', phase: 'FIXING', message: `Retrying after error: ${error.message}` };
      }
    }

    throw new Error("Failed to generate code after multiple attempts.");
  }

  private buildErrorContext(validationErrors: string[], attempts: number): string {
    let strategyInstruction = "";
    if (attempts >= 2) {
      strategyInstruction = "\n\nSTRATEGY CHANGE: You are failing repeatedly. SIMPLIFY the implementation. Remove complex types or advanced features if they are causing errors. Focus on basic functionality.";
    }
    if (attempts >= 4) {
      strategyInstruction = "\n\nEMERGENCY MODE: Just output the simplest possible working code. Ignore best practices if necessary to pass validation.";
    }

    const errorSummary = validationErrors.map(e => {
      if (e.includes('Missing import target')) return "MISSING FILE: Create the file you are importing. Ensure the path is correct.";
      if (e.includes('failed to update required dependent files')) return "DEPENDENCY UPDATE FAILED: You MUST update the listed dependent files to maintain structural consistency.";
      if (e.includes('Syntax Error')) return "SYNTAX ERROR: Fix TypeScript/JavaScript syntax.";
      if (e.includes('JSON')) return "JSON ERROR: Fix JSON format.";
      if (e.includes('React Key Error')) return "REACT KEY ERROR: Add unique 'key' props to list items.";
      if (e.includes('Forbidden pattern')) return "FORBIDDEN PATTERN: Remove Node.js/CommonJS specific features (e.g., require, module.exports, process) from browser-side code.";
      return e;
    }).join('\n');

    return `\n\n🚨 VALIDATION FAILED (Attempt ${attempts + 1}):\n${errorSummary}\n${strategyInstruction}\n\nPlease fix these errors in your next response.`;
  }

  async *processRequestStream(
    prompt: string,
    currentFiles: Record<string, string>,
    history: ChatMessage[] = [],
    activeWorkspace?: WorkspaceType | boolean,
    modelName: string = 'gemini-3-pro-preview'
  ): AsyncIterable<string> {
    try {
      const generator = this.processRequest(prompt, currentFiles, history, activeWorkspace, modelName);
      for await (const update of generator) {
        yield JSON.stringify(update) + "\n";
      }
    } catch (error: any) {
      throw error;
    }
  }

  private updateDependencyGraph(files: Record<string, string>) {
    const currentFilePaths = new Set(Object.keys(files));

    // Remove deleted files from cache
    for (const path of this.dependencyNodeCache.keys()) {
      if (!currentFilePaths.has(path)) {
        this.dependencyNodeCache.delete(path);
      }
    }

    // Update changed/new files
    for (const [filePath, content] of Object.entries(files)) {
      const hash = this.diffEngine.hashContent(content);
      const cached = this.dependencyNodeCache.get(filePath);

      if (!cached || cached.hash !== hash) {
        const rawImports = this.validator.extractImports(content);
        const resolvedImports: string[] = [];

        for (const imp of rawImports) {
          const resolved = this.validator.resolveImportPath(filePath, imp, files);
          if (resolved) resolvedImports.push(resolved);
        }

        const node: DependencyNode = { 
          file: this.validator.normalizePath(filePath), 
          imports: resolvedImports,
          tablesUsed: this.extractTables(content),
          apisUsed: this.extractAPIs(content),
          servicesUsed: this.extractServices(content)
        };

        this.dependencyNodeCache.set(filePath, { hash, node });
      }
    }

    this.dependencyGraph = Array.from(this.dependencyNodeCache.values()).map(x => x.node);
  }

  private extractTables(content: string): string[] {
    const tables = new Set<string>();
    const sqlRegex = /(?:from|update|into)\s+([a-zA-Z0-9_]+)/gi;
    let match;
    while ((match = sqlRegex.exec(content)) !== null) {
      const table = match[1].toLowerCase();
      if (!['select', 'where', 'set', 'values'].includes(table)) {
        tables.add(table);
      }
    }
    const supabaseRegex = /\.from(?:<[^>]+>)?\(['"]([a-zA-Z0-9_]+)['"]\)/g;
    while ((match = supabaseRegex.exec(content)) !== null) {
      tables.add(match[1]);
    }
    return Array.from(tables);
  }

  private extractAPIs(content: string): string[] {
    const apis = new Set<string>();
    const apiRegex = /(?:fetch|axios\.(?:get|post|put|delete|patch))\(['"]([^'"]+)['"]/g;
    let match;
    while ((match = apiRegex.exec(content)) !== null) {
      apis.add(match[1]);
    }
    return Array.from(apis);
  }

  private extractServices(content: string): string[] {
    const services = new Set<string>();
    const serviceRegex = /\b(use[A-Z]\w+Service|get[A-Z]\w+|[a-zA-Z0-9_]+Service)\b/g;
    let match;
    while ((match = serviceRegex.exec(content)) !== null) {
      services.add(match[1]);
    }
    return Array.from(services);
  }
}
