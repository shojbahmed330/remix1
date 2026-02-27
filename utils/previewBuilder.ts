import { transform } from 'sucrase';

export const buildFinalHtml = (projectFiles: Record<string, string>, entryPath: string = 'index.html', projectConfig?: any) => {
  try {
    const supabaseConfig = projectConfig?.supabase_url ? `
      window.StudioDatabase = {
        url: "${projectConfig.supabase_url}",
        key: "${projectConfig.supabase_key}"
      };
      console.log('Database Bridge: Active');
    ` : `window.StudioDatabase = null;`;

    const polyfill = `
      <script>
        ${supabaseConfig}
        // Mobile Error Monitor
        window.onerror = function(message, source, lineno, colno, error) {
          const errorMsg = 'SYSTEM_ERROR: ' + message + ' at ' + (source ? source.split('/').pop() : 'inline') + ':' + lineno;
          console.error(errorMsg);
          if (window.innerHeight < 1000) {
             const div = document.createElement('div');
             div.style = "position:fixed;bottom:0;left:0;right:0;background:rgba(220,38,38,0.9);color:white;padding:10px;font-size:10px;z-index:99999;font-family:monospace;word-break:break-all;";
             div.innerText = errorMsg;
             document.body.appendChild(div);
             setTimeout(() => div.remove(), 8000);
          }
          window.parent.postMessage({
            type: 'RUNTIME_ERROR',
            error: { message, line: lineno, source: source ? source.split('/').pop() : 'index.html' }
          }, '*');
          return false;
        };
        if ('scrollRestoration' in history) { history.scrollRestoration = 'manual'; }
      </script>
    `;

    // Identify workspaces
    const isAppWorkspace = entryPath.startsWith('app/') || entryPath === 'index.html' || entryPath === 'app.html';
    const isAdminWorkspace = entryPath.startsWith('admin/') || entryPath === 'admin.html';

    // Process Files
    const transpiledFiles: Record<string, string> = {};
    const cssFiles: string[] = [];
    
    Object.entries(projectFiles).forEach(([path, content]) => {
      if (!content) return;
      
      // Filter by workspace
      if (isAppWorkspace && (path.startsWith('admin/') || path.startsWith('admin.'))) return;
      if (isAdminWorkspace && (path.startsWith('app/') || path.startsWith('app.'))) return;

      if (path.endsWith('.css')) {
        cssFiles.push(`/* --- ${path} --- */\n${content}`);
      } else if (path.endsWith('.js') || path.endsWith('.ts') || path.endsWith('.tsx') || path.endsWith('.jsx')) {
        try {
          const transpiled = transform(content, {
            // Keep ESM imports for the browser runtime.
            // Using the `imports` transform rewrites imports to CommonJS `require(...)`,
            // which causes `Uncaught ReferenceError: require is not defined` in preview.
            transforms: ['typescript', 'jsx'],
            jsxRuntime: 'automatic',
            production: true
          }).code;
          
          const cleanPath = path.replace(/\.(ts|tsx|js|jsx)$/, '');
          transpiledFiles[cleanPath] = transpiled;
          transpiledFiles[path] = transpiled;
        } catch (e) {
          console.error(`Transpilation error in ${path}:`, e);
          transpiledFiles[path] = `console.error("Transpilation error in ${path}");`;
        }
      }
    });

    // Build Import Map
    const importMap: Record<string, string> = {
      "react": "https://esm.sh/react@19.0.0",
      "react/jsx-runtime": "https://esm.sh/react@19.0.0/jsx-runtime",
      "react-dom": "https://esm.sh/react-dom@19.0.0",
      "react-dom/client": "https://esm.sh/react-dom@19.0.0/client",
      "lucide-react": "https://esm.sh/lucide-react@0.460.0",
      "framer-motion": "https://esm.sh/framer-motion@11.11.11",
      "recharts": "https://esm.sh/recharts@2.13.3",
      "clsx": "https://esm.sh/clsx@2.1.1",
      "tailwind-merge": "https://esm.sh/tailwind-merge@2.5.4"
    };

    // Add local files to import map as Object URLs
    Object.entries(transpiledFiles).forEach(([path, code]) => {
      try {
        const blob = new Blob([code], { type: 'text/javascript' });
        const url = URL.createObjectURL(blob);
        
        const cleanPath = path.replace(/\.(ts|tsx|js|jsx)$/, '');
        const aliasSet = new Set<string>();
        const addAlias = (...candidates: Array<string | undefined>) => {
          for (const candidate of candidates) {
            if (!candidate) continue;
            const normalized = candidate.trim();
            if (!normalized) continue;
            aliasSet.add(normalized);
            aliasSet.add(normalized.toLowerCase());
          }
        };

        addAlias(cleanPath, path, `./${cleanPath}`, `./${path}`, `/${cleanPath}`, `/${path}`);

        if (path.startsWith('app/')) {
          const appRelativeWithExt = path.replace('app/', './');
          const appRelative = appRelativeWithExt.replace(/\.(ts|tsx|js|jsx)$/, '');
          addAlias(appRelativeWithExt, appRelative, appRelative.replace(/^\.\//, '/'));
        }

        if (path.startsWith('admin/')) {
          const adminRelativeWithExt = path.replace('admin/', './');
          const adminRelative = adminRelativeWithExt.replace(/\.(ts|tsx|js|jsx)$/, '');
          addAlias(adminRelativeWithExt, adminRelative, adminRelative.replace(/^\.\//, '/'));
        }

        // Also map common source-root prefixes to "./..." and "/..." imports.
        // Example: src/components/Button.tsx should resolve both
        // "./src/components/Button" and "./components/Button".
        const aliasPrefixes: string[] = ['src/', 'app/src/', 'admin/src/', 'frontend/', 'client/', 'web/'];
        for (const prefix of aliasPrefixes) {
          if (!cleanPath.startsWith(prefix)) continue;
          const withoutPrefix = cleanPath.slice(prefix.length);
          const withoutPrefixWithExt = path.startsWith(prefix) ? path.slice(prefix.length) : '';
          if (!withoutPrefix) continue;
          addAlias(`./${withoutPrefix}`, `/${withoutPrefix}`);
          if (withoutPrefixWithExt) {
            addAlias(`./${withoutPrefixWithExt}`, `/${withoutPrefixWithExt}`);
          }
        }

        // If module is an index file, map its parent directory import too.
        // Example: app/components/Calculator/index.tsx -> /components/Calculator
        if (cleanPath.endsWith('/index')) {
          const parent = cleanPath.slice(0, -('/index'.length));
          addAlias(parent, `./${parent}`, `/${parent}`);
          if (parent.startsWith('app/')) {
            const appParent = parent.replace(/^app\//, '');
            addAlias(`./${appParent}`, `/${appParent}`);
          }
          if (parent.startsWith('admin/')) {
            const adminParent = parent.replace(/^admin\//, '');
            addAlias(`./${adminParent}`, `/${adminParent}`);
          }
        }

        aliasSet.forEach((alias) => {
          importMap[alias] = url;
        });
      } catch (e) {
        console.error(`Failed to create Object URL for ${path}:`, e);
      }
    });

    const importMapScript = `<script type="importmap">${JSON.stringify({ imports: importMap })}</script>`;

    // Entry Point Search
    const htmlFiles = Object.entries(projectFiles)
      .filter(([path, content]) => path.endsWith('.html') && content.length > 0)
      .sort(([a], [b]) => {
        if (a.includes('index.html')) return -1;
        if (b.includes('index.html')) return 1;
        return 0;
      });

    let entryHtml = projectFiles[entryPath] || (htmlFiles.length > 0 ? htmlFiles[0][1] : '<div id="root"></div>');

    // React Auto-Bootstrap
    const hasReact = Object.keys(projectFiles).some(f => f.endsWith('.tsx') || f.endsWith('.jsx'));
    let bootstrapScript = '';

    if (hasReact) {
      const workspacePrefix = isAppWorkspace ? 'app/' : 'admin/';
      const files = Object.keys(transpiledFiles);
      const entryFile = files.find(f => 
        f === `${workspacePrefix}main` || f === `${workspacePrefix}index` || f === `${workspacePrefix}App` ||
        f === 'main' || f === 'index' || f === 'App'
      ) || 
      files.find(f => f.startsWith(workspacePrefix) && (f.includes('components/') || f.includes('pages/'))) ||
      files.find(f => f.startsWith(workspacePrefix) && f.split('/').pop()![0] === f.split('/').pop()![0].toUpperCase()) ||
      files.find(f => f.startsWith(workspacePrefix));

      if (entryFile) {
        bootstrapScript = `
          <script type="module">
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import * as Main from "${entryFile}";
            const init = () => {
              const rootElement = document.getElementById('root') || document.getElementById('app') || document.body;
              if (rootElement && rootElement.innerHTML.trim().length < 10) {
                const App = Main.default || Object.values(Main).find(v => typeof v === 'function' && v.name && v.name[0] === v.name[0].toUpperCase());
                if (App) {
                  try {
                    const root = createRoot(rootElement);
                    root.render(React.createElement(App));
                  } catch (e) { console.error('Bootstrap Error:', e); }
                }
              }
            };
            if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', init);
            else init();
          </script>
        `;
      }
    }

    const headInjection = `
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
      <base href="https://preview.local/">
      <script src="https://cdn.tailwindcss.com"></script>
      <style>
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        html, body { height: 100%; margin: 0; padding: 0; background-color: #09090b !important; color: #f4f4f5; font-family: sans-serif; }
        ::-webkit-scrollbar { display: none; }
        ${cssFiles.join('\n')}
      </style>
      ${importMapScript}
      ${polyfill}
    `;

    let processedHtml = entryHtml
      .replace(/<link[^>]+href=["'](?!\w+:\/\/)[^"']+["'][^>]*>/gi, '')
      .replace(/<script[^>]+src=["'](?!\w+:\/\/)[^"']+["'][^>]*><\/script>/gi, '');

    // React previews are bootstrapped by this builder from transpiled object-URL modules.
    // Inline module scripts inside srcdoc often import relative paths (./components/...),
    // which resolve against about:srcdoc and can fail with non-hierarchical URL errors.
    // Removing them avoids duplicate runtime entrypoints and prevents the srcdoc resolver crash.
    if (hasReact) {
      processedHtml = processedHtml.replace(/<script[^>]*type=["']module["'][^>]*>[\s\S]*?<\/script>/gi, '');
    }

    if (!processedHtml.toLowerCase().includes('<html')) {
      return `<!DOCTYPE html><html lang="en"><head>${headInjection}</head><body>${processedHtml}${bootstrapScript}</body></html>`;
    }

    const hasHead = /<head[^>]*>/i.test(processedHtml);
    if (hasHead) {
      processedHtml = processedHtml.replace(/<head([^>]*)>/i, `<head$1>${headInjection}`);
    } else if (processedHtml.includes('</head>')) {
      processedHtml = processedHtml.replace('</head>', `${headInjection}</head>`);
    } else {
      processedHtml = processedHtml.replace('<body', `<head>${headInjection}</head><body`);
    }

    if (processedHtml.includes('</body>')) {
      processedHtml = processedHtml.replace('</body>', `${bootstrapScript}</body>`);
    } else {
      processedHtml = processedHtml + bootstrapScript;
    }

    return processedHtml;
  } catch (error) {
    console.error('PREVIEW_BUILD_ERROR:', error);
    return `<div style="color:red;padding:20px;">Build Error: ${error instanceof Error ? error.message : 'Unknown'}</div>`;
  }
};
