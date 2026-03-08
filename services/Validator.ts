
import * as ts from "typescript";
import { DependencyNode } from "../types";

export class Validator {
  private resolveCache = new Map<string, string | null>();

  public validateOutput(filesToValidate: Record<string, string>, allFiles: Record<string, string>, dependencyGraph: DependencyNode[]): string[] {
    const errors: string[] = [];
    errors.push(...this.validateFileSizeAndConflicts(filesToValidate));
    // Pass both the files to validate AND the full project context
    errors.push(...this.validateImports(filesToValidate, allFiles));
    errors.push(...this.validateDefaultImportCompatibility(filesToValidate, allFiles));
    errors.push(...this.validateTypeScriptSyntax(filesToValidate));
    errors.push(...this.detectCircularDependencies(dependencyGraph));
    errors.push(...this.validateReactKeys(filesToValidate));
    errors.push(...this.validateForbiddenPatterns(filesToValidate));
    return errors;
  }

  public validateFileSizeAndConflicts(files: Record<string, string>): string[] {
    const errors: string[] = [];
    for (const [path, content] of Object.entries(files)) {
      const lines = content.split('\n').length;
      if (lines > 2000) { // Increased limit
        errors.push(`File "${path}" is too large (${lines} lines). Please split it.`);
      }
      if (content.includes('<<<<<<<') || content.includes('=======')) {
        errors.push(`File "${path}" has merge conflict markers.`);
      }
    }
    return errors;
  }

  public validateImports(filesToValidate: Record<string, string>, allFiles: Record<string, string>): string[] {
    const errors: string[] = [];
    this.resolveCache.clear();

    for (const [path, content] of Object.entries(filesToValidate)) {
      const imports = this.extractImports(content);
      for (const imp of imports) {
        if (imp.startsWith('.') || imp.startsWith('@/')) {
          // Resolve against ALL files in the project, not just the new ones
          const resolved = this.resolveImportPath(path, imp, allFiles);
          if (!resolved) {
            errors.push(`🚨 CRITICAL ERROR: Missing import target "${imp}" in file "${path}". You referenced this file but it does not exist in the project. You MUST create this missing file.`);
          }
        }
      }
    }
    return errors;
  }

  public validateDefaultImportCompatibility(filesToValidate: Record<string, string>, allFiles: Record<string, string>): string[] {
    const errors: string[] = [];

    for (const [path, content] of Object.entries(filesToValidate)) {
      const defaultImports = this.extractDefaultImports(content);

      for (const imp of defaultImports) {
        if (!imp.specifier.startsWith('.') && !imp.specifier.startsWith('@/')) continue;

        const resolved = this.resolveImportPath(path, imp.specifier, allFiles);
        if (!resolved) continue;

        const target = allFiles[resolved];
        if (!target) continue;

        const hasDefaultExport =
          /export\s+default\s+/m.test(target) ||
          /export\s*\{[^}]*\bas\s+default\b[^}]*\}/m.test(target);

        if (!hasDefaultExport) {
          errors.push(
            `🚨 CRITICAL ERROR: Default import mismatch in "${path}". You imported "${imp.localName}" as default from "${imp.specifier}", but "${resolved}" has no default export. Use a named import or add \`export default\`.`
          );
        }
      }
    }

    return errors;
  }

  public extractDefaultImports(content: string): { localName: string; specifier: string }[] {
    const matches: { localName: string; specifier: string }[] = [];
    const regex = /import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\}\s*)?from\s+['"]([^'"]+)['"]/g;

    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      matches.push({ localName: match[1], specifier: match[2] });
    }

    return matches;
  }

  public validateTypeScriptSyntax(files: Record<string, string>): string[] {
    const errors: string[] = [];
    for (const [fileName, content] of Object.entries(files)) {
      // Check for 'require' usage in all JS/TS files, excluding config files like tailwind.config.js
      if (!fileName.includes('tailwind.config.js') && (fileName.endsWith('.ts') || fileName.endsWith('.tsx') || fileName.endsWith('.js') || fileName.endsWith('.jsx')) && content.match(/require\s*\(/) && !content.includes('createRequire')) {
        errors.push(`TS Syntax Error in ${fileName}: "require()" is not supported in Vite. Use ES6 "import" syntax instead.`);
      }

      if (!fileName.endsWith('.ts') && !fileName.endsWith('.tsx')) continue;
      try {
        const sourceFile = ts.createSourceFile(
          fileName,
          content,
          ts.ScriptTarget.ESNext,
          true,
          fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
        );
        const diagnostics = (sourceFile as any).parseDiagnostics || [];
        for (const d of diagnostics) {
          errors.push(`TS Syntax Error in ${fileName}: ${d.messageText}`);
        }
      } catch (e) {
        // Ignore parser crash
      }
    }
    return errors;
  }

  public detectCircularDependencies(dependencyGraph: DependencyNode[]): string[] {
    const errors: string[] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const dfs = (nodeFile: string, path: string[]) => {
      visited.add(nodeFile);
      recursionStack.add(nodeFile);

      const node = dependencyGraph.find(n => n.file === nodeFile);
      if (node) {
        for (const imp of node.imports) {
          const targetNode = dependencyGraph.find(n => n.file === imp);
          
          if (targetNode) {
            if (!visited.has(targetNode.file)) {
              dfs(targetNode.file, [...path, targetNode.file]);
            } else if (recursionStack.has(targetNode.file)) {
              errors.push(`Circular dependency detected: ${path.join(' -> ')} -> ${targetNode.file}`);
            }
          }
        }
      }
      recursionStack.delete(nodeFile);
    };

    for (const node of dependencyGraph) {
      if (!visited.has(node.file)) {
        dfs(node.file, [node.file]);
      }
    }
    return errors;
  }

  public extractImports(content: string): string[] {
    const importRegex = /import\s+.*\s+from\s+['"](.*)['"]/g;
    const matches = [];
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      matches.push(match[1]);
    }
    return matches;
  }

  public resolveImportPath(importerFile: string, importPath: string, allFiles: Record<string, string>): string | null {
    const cacheKey = `${importerFile}|${importPath}`;
    if (this.resolveCache.has(cacheKey)) return this.resolveCache.get(cacheKey)!;

    let resolved = importPath;

    if (importPath.startsWith('@/')) {
      resolved = importPath.replace('@/', 'src/');
      if (!Object.keys(allFiles).some(f => f.startsWith(resolved))) {
        resolved = importPath.replace('@/', 'app/');
      }
    } else if (importPath.startsWith('.')) {
      resolved = this.resolveRelativePath(importerFile, importPath);
    }

    resolved = this.normalizePath(resolved);

    const candidates = [
      resolved,
      `${resolved}.ts`,
      `${resolved}.tsx`,
      `${resolved}.js`,
      `${resolved}.jsx`,
      `${resolved}/index.ts`,
      `${resolved}/index.tsx`,
      `${resolved}/index.js`,
      `${resolved}/index.jsx`,
    ];

    let finalMatch: string | null = null;
    for (const c of candidates) {
      if (allFiles[c] !== undefined) {
        finalMatch = c;
        break;
      }
    }

    this.resolveCache.set(cacheKey, finalMatch);
    return finalMatch;
  }

  public resolveRelativePath(basePath: string, relativePath: string): string {
    const baseParts = basePath.split('/').slice(0, -1);
    const relativeParts = relativePath.split('/');
    for (const part of relativeParts) {
      if (part === '.') continue;
      if (part === '..') baseParts.pop();
      else baseParts.push(part);
    }
    return baseParts.join('/');
  }

  public normalizePath(p: string): string {
    return p.replace(/\\/g, '/').replace(/\/\//g, '/');
  }

  public validateReactKeys(files: Record<string, string>): string[] {
    const errors: string[] = [];
    for (const [fileName, content] of Object.entries(files)) {
      if (!fileName.endsWith('.tsx') && !fileName.endsWith('.jsx')) continue;

      // Simple regex to detect map functions without a key prop
      const regex = /\.map\(\s*\(([^)]*?)\)\s*=>\s*<([a-zA-Z0-9]+)(?!\s+key)/g;
      let match;
      while ((match = regex.exec(content)) !== null) {
        errors.push(`React Key Error in ${fileName}: List rendered without a unique 'key' prop. Ensure all mapped elements have a 'key'.`);
      }
    }
    return errors;
  }

  public validateForbiddenPatterns(files: Record<string, string>): string[] {
    const errors: string[] = [];
    const safeBuiltins = new Set(['Date', 'String', 'Number', 'Boolean', 'Array', 'Object', 'RegExp', 'Error', 'Promise', 'Symbol', 'Map', 'Set', 'URL', 'FormData', 'Intl', 'Math', 'JSON', 'Console', 'Blob', 'File', 'Headers', 'Request', 'Response', 'URLSearchParams', 'WebSocket', 'Worker', 'Image', 'Audio', 'Video', 'CanvasGradient', 'CanvasPattern', 'CanvasRenderingContext2D', 'MutationObserver', 'IntersectionObserver', 'ResizeObserver', 'Performance', 'Notification', 'Storage', 'IDBKeyRange', 'IDBRequest', 'IDBTransaction', 'IDBDatabase', 'IDBObjectStore', 'IDBIndex', 'IDBCursor', 'IDBCursorWithValue', 'IDBFactory', 'Event', 'CustomEvent', 'MessageEvent', 'CloseEvent', 'ErrorEvent', 'ProgressEvent', 'UIEvent', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'WheelEvent', 'PointerEvent', 'TouchEvent', 'CompositionEvent', 'InputEvent', 'AnimationEvent', 'TransitionEvent', 'ClipboardEvent', 'DragEvent', 'HashChangeEvent', 'PageTransitionEvent', 'PopStateEvent', 'StorageEvent', 'DeviceOrientationEvent', 'DeviceMotionEvent', 'GamepadEvent', 'BeforeUnloadEvent', 'SecurityPolicyViolationEvent', 'PromiseRejectionEvent', 'MediaQueryListEvent', 'OfflineAudioCompletionEvent', 'AudioProcessingEvent', 'RTCPeerConnectionIceEvent', 'RTCTrackEvent', 'RTCDataChannelEvent', 'RTCPeerConnectionIceErrorEvent', 'RTCCertificate', 'RTCSessionDescription', 'RTCIceCandidate', 'RTCIceServer', 'RTCIceTransport', 'RTCDtlsTransport', 'RTCSctpTransport', 'RTCRtpSender', 'RTCRtpReceiver', 'RTCRtpTransceiver', 'RTCRtpContributionSource', 'RTCRtpReceiveParameters', 'RTCRtpSendParameters', 'RTCRtpCodecParameters', 'RTCRtpHeaderExtensionParameters', 'RTCRtpCodecCapability', 'RTCRtpHeaderExtensionCapability', 'RTCRtpCapabilities', 'RTCIceParameters', 'RTCIceCandidatePair', 'RTCIceCandidateStats', 'RTCIceCandidatePairStats', 'RTCIceTransportStats', 'RTCOutboundRtpStreamStats', 'RTCInboundRtpStreamStats', 'RTCRemoteOutboundRtpStreamStats', 'RTCRemoteInboundRtpStreamStats', 'RTCAudioSourceStats', 'RTCVideoSourceStats', 'RTCTransportStats', 'RTCPeerConnectionStats', 'RTCCodecStats', 'RTCMediaStreamStats', 'RTCMediaStreamTrackStats', 'RTCDataChannelStats', 'RTCCertificateStats', 'RTCIceServerStats', 'RTCIceCandidateStats', 'RTCIceCandidatePairStats', 'RTCIceTransportStats', 'RTCOutboundRtpStreamStats', 'RTCInboundRtpStreamStats', 'RTCRemoteOutboundRtpStreamStats', 'RTCRemoteInboundRtpStreamStats', 'RTCAudioSourceStats', 'RTCVideoSourceStats', 'RTCTransportStats', 'RTCPeerConnectionStats', 'RTCCodecStats', 'RTCMediaStreamStats', 'RTCMediaStreamTrackStats', 'RTCDataChannelStats', 'RTCCertificateStats', 'RTCIceServerStats', 'Uint8Array', 'Uint16Array', 'Uint32Array', 'Int8Array', 'Int16Array', 'Int32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'DataView', 'ArrayBuffer', 'SharedArrayBuffer']);

    for (const [fileName, content] of Object.entries(files)) {
      if (!fileName.endsWith('.tsx') && !fileName.endsWith('.jsx') && !fileName.endsWith('.ts') && !fileName.endsWith('.js')) continue;

      // 1. Detect component calls as functions: ComponentName() or {ComponentName()}
      if (fileName.endsWith('.tsx') || fileName.endsWith('.jsx')) {
        try {
          const sourceFile = ts.createSourceFile(
            fileName,
            content,
            ts.ScriptTarget.ESNext,
            true,
            fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.JSX
          );

          const visit = (node: ts.Node) => {
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
              const name = node.expression.text;
              const startsUppercase = /^[A-Z]/.test(name);

              if (startsUppercase && !safeBuiltins.has(name)) {
                errors.push(`🚨 CRITICAL ERROR in ${fileName}: You are calling React component "${name}" as a function: ${name}(). ALWAYS use JSX syntax: <${name} />. Calling components as functions causes "Cannot read properties of null (reading 'useContext')" errors.`);
              }
            }

            ts.forEachChild(node, visit);
          };

          visit(sourceFile);
        } catch (_e) {
          // If parser fails, skip this specific heuristic to avoid noisy false positives.
        }
      }

      // 2. Detect dynamic require
      if (!fileName.includes('tailwind.config.js') && content.match(/\brequire\s*\(/) && !content.includes('createRequire')) {
        errors.push(`🚨 CRITICAL ERROR in ${fileName}: Dynamic "require()" is not supported in Vite. You MUST use ESM "import" syntax. Example: import { something } from 'package';`);
      }

      // 3. Detect process.env usage (must use import.meta.env in Vite client code)
      if (content.includes('process.env.') && !content.includes('process.env.GEMINI_API_KEY') && !content.includes('process.env.API_KEY') && !fileName.includes('vite.config.ts') && !fileName.includes('server.ts')) {
        errors.push(`🚨 CRITICAL ERROR in ${fileName}: "process.env" is not allowed in Vite client code. Use "import.meta.env.VITE_VARIABLE_NAME" with null-safe fallback/checks to prevent runtime crashes.`);
      }

      // 4. Detect unhandled Supabase environment variables
      if (content.includes('VITE_SUPABASE_URL') && !content.includes('if (!import.meta.env.VITE_SUPABASE_URL)') && !content.includes('import.meta.env.VITE_SUPABASE_URL ??') && !content.includes('import.meta.env.VITE_SUPABASE_URL ||')) {
        errors.push(`🚨 CRITICAL ERROR in ${fileName}: You are accessing "VITE_SUPABASE_URL" without a safety check. ALWAYS check if it exists before using it to prevent "Cannot read properties of undefined" errors.`);
      }
    }
    return errors;
  }

  public validatePlan(plan: string[], currentFiles: Record<string, string>): string[] {
    const errors: string[] = [];
    for (const step of plan) {
      const createMatch = step.match(/CREATE\s+FILE\s+([\\w\\/\\.-\\s]+?\.[tj]sx?)/i);
      if (createMatch) {
        const filePath = this.normalizePath(createMatch[1]);
        if (currentFiles[filePath] !== undefined) {
          errors.push(`Plan Error: File to be created '${filePath}' already exists.`);
        }
      }

      const updateMatch = step.match(/UPDATE\s+FILE\s+([\\w\\/\\.-\\s]+?\.[tj]sx?)/i);
      if (updateMatch) {
        const filePath = this.normalizePath(updateMatch[1]);
        if (currentFiles[filePath] === undefined) {
          errors.push(`Plan Error: File to be updated '${filePath}' does not exist.`);
        }
      }
    }
    return errors;
  }
}
