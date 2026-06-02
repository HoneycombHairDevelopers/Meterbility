import { createHash } from "node:crypto";

/**
 * Blob rendering — MIME sniffing + Shiki syntax highlighting + cache
 * key derivation. Backs the `/api/blob/:hash/render` route per
 * SPEC-V0_3 §8.4 + §10.4.
 *
 * Design decisions locked by /plan-design-review:
 *   - D10: Shiki theme = `github-dark-dimmed` with `.shiki` background
 *     overridden to `var(--surface-0)` so code panes blend with the
 *     existing Cerulean dark surface.
 *   - CQ5: Shiki is lazy-loaded on first text-render request (memoized
 *     promise) so server startup doesn't pay the ~1.5MB grammar cost
 *     for operators who never view a render.
 *   - P2: Cache key includes a RENDER_VERSION constant so future Shiki
 *     upgrades / theme swaps invalidate cached HTML cleanly.
 *   - D7: image/* MIME types serve raw bytes (route handler in web.ts
 *     does the `<img>` rendering); non-image binary falls back to
 *     application/octet-stream + placard at the route layer.
 */

/**
 * Bump this when Shiki is upgraded or the theme is changed. Old
 * cache entries become orphans (cleaned up by blob GC in a future
 * milestone); new requests render fresh.
 */
export const RENDER_VERSION = "v1";

/** Shiki theme. Pinned per D10. */
export const SHIKI_THEME = "github-dark-dimmed";

export interface SniffResult {
  mime: string;
  /** Detected language (Shiki id) when sniffable; undefined for binary. */
  lang?: string;
  /** True when the buffer looks binary (null byte in first 8KB). */
  binary: boolean;
}

/**
 * Magic-byte image detection + null-byte binary heuristic + path-hint
 * language detection. Returns `{mime, lang?, binary}` so the caller
 * can dispatch on it without re-scanning.
 */
export function sniffMimeAndLang(
  buf: Buffer,
  pathHint?: string,
): SniffResult {
  // Image magic bytes — checked first because they're unambiguous
  // and the route shortcuts to raw-bytes for image MIME types.
  if (buf.length >= 8) {
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47
    ) {
      return { mime: "image/png", binary: true };
    }
    // JPEG: FF D8 FF (followed by E0/E1/E2/E3/E8/DB/EE)
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      return { mime: "image/jpeg", binary: true };
    }
    // GIF: GIF87a or GIF89a
    if (
      buf[0] === 0x47 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x38 &&
      (buf[4] === 0x37 || buf[4] === 0x39) &&
      buf[5] === 0x61
    ) {
      return { mime: "image/gif", binary: true };
    }
    // WebP: RIFF....WEBP (bytes 0-3 = RIFF, bytes 8-11 = WEBP)
    if (
      buf.length >= 12 &&
      buf[0] === 0x52 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x46 &&
      buf[8] === 0x57 &&
      buf[9] === 0x45 &&
      buf[10] === 0x42 &&
      buf[11] === 0x50
    ) {
      return { mime: "image/webp", binary: true };
    }
  }

  // Null-byte scan in first 8KB — anything with a NUL is almost
  // certainly binary (UTF-8 text never contains a NUL byte under
  // normal use). 8KB window is the same heuristic Git uses.
  const window = Math.min(buf.length, 8192);
  for (let i = 0; i < window; i++) {
    if (buf[i] === 0) {
      return { mime: "application/octet-stream", binary: true };
    }
  }

  // Text. Resolve language from path hint if provided.
  const lang = pathHint ? langFromPath(pathHint) : undefined;
  return { mime: "text/plain", lang, binary: false };
}

/**
 * Map a filesystem path or filename to a Shiki language id. Handles
 * common extensions + a small set of extension-less filenames
 * (Dockerfile, Makefile, etc. per T9 polish). Returns undefined when
 * no confident mapping exists; the renderer falls back to `plaintext`.
 */
export function langFromPath(path: string): string | undefined {
  const lower = path.toLowerCase();
  const basename = lower.includes("/")
    ? lower.slice(lower.lastIndexOf("/") + 1)
    : lower;

  // Extension-less filenames — T9 polish per design review.
  // Tooling files developers reach for often.
  if (basename === "dockerfile" || basename.startsWith("dockerfile."))
    return "dockerfile";
  if (basename === "makefile" || basename === "gnumakefile") return "makefile";
  if (basename === "rakefile" || basename === "gemfile") return "ruby";
  if (basename === "podfile") return "ruby";
  if (basename === "vagrantfile") return "ruby";
  if (basename === "jenkinsfile") return "groovy";
  if (basename === "cmakelists.txt") return "cmake";
  if (basename === "license" || basename === "license.txt") return undefined;
  if (basename === "readme" || basename === "authors") return undefined;

  const ext = basename.includes(".")
    ? basename.slice(basename.lastIndexOf(".") + 1)
    : "";
  return EXT_TO_LANG[ext];
}

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  ps1: "powershell",
  sql: "sql",
  json: "json",
  jsonc: "jsonc",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  md: "markdown",
  mdx: "mdx",
  rst: "rst",
  tex: "latex",
  vue: "vue",
  svelte: "svelte",
  dart: "dart",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  lua: "lua",
  pl: "perl",
  r: "r",
  scala: "scala",
  zig: "zig",
  proto: "proto",
  graphql: "graphql",
  gql: "graphql",
  env: "bash",
  ini: "ini",
  conf: "ini",
  diff: "diff",
  patch: "diff",
};

/**
 * Strip a leading UTF-8 BOM (EF BB BF) so Shiki doesn't render it as
 * a stray glyph. Returns the original buffer when no BOM is present.
 */
export function stripBom(buf: Buffer): Buffer {
  if (
    buf.length >= 3 &&
    buf[0] === 0xef &&
    buf[1] === 0xbb &&
    buf[2] === 0xbf
  ) {
    return buf.subarray(3);
  }
  return buf;
}

/**
 * Build the cache key for a rendered blob. Includes RENDER_VERSION
 * so renderer upgrades naturally invalidate the cache.
 */
export function renderCacheKey(blobHash: string, lang: string): string {
  // Prefix `render_` distinguishes cache entries from content blobs
  // when inspecting blob storage by hand.
  return (
    "render_" +
    createHash("sha256")
      .update(`${blobHash}|${lang}|${RENDER_VERSION}`)
      .digest("hex")
  );
}

// ─── Shiki lazy-load + render ────────────────────────────────────────

type ShikiHighlighter = {
  codeToHtml: (
    code: string,
    opts: { lang: string; theme: string },
  ) => string;
};

let shikiHighlighterPromise: Promise<ShikiHighlighter> | undefined;

/**
 * Lazy-create a Shiki highlighter instance, memoized for the process
 * lifetime. First call pays the ~200ms grammar/theme load cost; all
 * subsequent calls reuse the cached instance. Per CQ5: this is why
 * server startup stays fast even though Shiki ships ~1.5MB.
 */
function getShikiHighlighter(): Promise<ShikiHighlighter> {
  if (!shikiHighlighterPromise) {
    shikiHighlighterPromise = (async () => {
      // Dynamic import so the Shiki bundle isn't pulled in until
      // the first render request actually hits the route.
      const shiki = await import("shiki");
      // `createHighlighter` (1.x API) preloads a known set of langs
      // up front. We register the common ones eagerly so the first
      // render of each language doesn't pay an extra fetch cost.
      // Less-common langs use `loadLanguage` on demand inside the
      // try block of renderHighlighted.
      const highlighter = await shiki.createHighlighter({
        themes: [SHIKI_THEME],
        langs: [
          "typescript",
          "tsx",
          "javascript",
          "jsx",
          "python",
          "json",
          "yaml",
          "markdown",
          "bash",
          "go",
          "rust",
          "html",
          "css",
          "sql",
          "diff",
        ],
      });
      return highlighter as ShikiHighlighter & {
        loadLanguage: (lang: string) => Promise<void>;
        getLoadedLanguages: () => string[];
      };
    })();
  }
  return shikiHighlighterPromise;
}

/**
 * Render a code buffer as syntax-highlighted HTML. Returns
 * escaped-plaintext HTML on any Shiki error (per Pass 2 D5 — never
 * 500 on a malformed blob). The output is a `<pre class="shiki">...`
 * block; the CSS override `.shiki { background: var(--surface-0) }`
 * in html.ts (D10) blends it with the rest of the page.
 */
export async function renderHighlighted(
  buf: Buffer,
  lang?: string,
): Promise<string> {
  const cleaned = stripBom(buf);
  const code = cleaned.toString("utf-8");
  const effLang = lang ?? "plaintext";
  try {
    const highlighter = (await getShikiHighlighter()) as ShikiHighlighter & {
      loadLanguage: (lang: string) => Promise<void>;
      getLoadedLanguages: () => string[];
    };
    // Late-load uncommon languages without ballooning startup memory.
    if (
      effLang !== "plaintext" &&
      typeof highlighter.getLoadedLanguages === "function" &&
      !highlighter.getLoadedLanguages().includes(effLang)
    ) {
      try {
        await highlighter.loadLanguage(effLang);
      } catch {
        // Unknown lang — fall through to plaintext render below.
        return renderPlaintext(code);
      }
    }
    return highlighter.codeToHtml(code, {
      lang: effLang,
      theme: SHIKI_THEME,
    });
  } catch {
    // Shiki occasionally throws on adversarial content (unterminated
    // strings, broken Unicode in grammar paths). Return safe-escaped
    // plaintext so the route stays 200 and the user still sees their
    // file. Per D5 + Pass 2 design decision.
    return renderPlaintext(code);
  }
}

function renderPlaintext(code: string): string {
  const escaped = code
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<pre class="shiki"><code>${escaped}</code></pre>`;
}
