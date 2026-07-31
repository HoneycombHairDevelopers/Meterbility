import Reveal from "@/components/Reveal";
import CopyInstall from "@/components/CopyInstall";
import EnterpriseForm from "@/components/EnterpriseForm";
import GitHubIcon from "@/components/GitHubIcon";
import Instrument from "@/components/Instrument";

const GITHUB = "https://github.com/HoneycombHairDevelopers/Meterbility";

const PANELS = [
  { from: "Elements", to: "Context Viewer", desc: <>The fully resolved context for any step — system prompt, history, tool schemas — at <code>/contexts/:id</code>.</> },
  { from: "Sources", to: "Step Inspector", desc: <><code>meter inspect</code> walks every decision; <code>meter fork</code> branches a new trajectory from any step.</> },
  { from: "Network", to: "I/O Inspector", desc: <>Decision blobs, tool results, and files changed — including Bash side-effects other tools can&apos;t see.</> },
  { from: "Performance", to: "Cost Timeline", desc: <>Per-step and per-run cost, token, and latency timelines. Know exactly where the money went.</> },
  { from: "Console", to: "Live Probe", desc: <>Pause a running agent, inject a message, resume — <code>meter probe</code> or the web panel.</> },
  { from: "git", to: "Trajectory Diff", desc: <><code>meter diff</code> compares two runs step-by-step and pinpoints exactly where behavior diverged.</> },
];

const FEATURES = [
  { title: "Capture every surface", desc: <>Claude Code JSONL hooks, Codex CLI &amp; Desktop, Cursor composer, and Anthropic/OpenAI proxies via <code>meter proxy</code>.</> },
  { title: "Bash side-effect capture", desc: <>What tool-call inspection can&apos;t see — <code>sed</code>, <code>mv</code>, build scripts — lands as file-change rows via hooks or the FileSentinel.</> },
  { title: "Fork & replay", desc: <>Deterministic prefix replay with a live suffix. Continue with <code>--continue simulate|live</code> for multi-step what-ifs.</> },
  { title: "Regression suite", desc: <>Promote a good run to a canonical, add assertions, and catch behavioral drift with <code>meter test</code>.</> },
  { title: "SDKs for custom agents", desc: <><code>@meterbility/agent</code> for TypeScript and <code>meterbility-agent</code> for Python (stdlib-only). One-line Anthropic tracing.</> },
  { title: "Sensitive-path redaction", desc: <>Edits to <code>.env</code>, keys, and credential stores record the fact of the change — path, op, size — never the contents.</> },
];

export default function Home() {
  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <nav aria-label="Main">
        <div className="wrap nav-inner">
          <a className="wordmark" href="#">
            meterbility<span className="tick" aria-hidden="true">_</span>
          </a>
          <div className="nav-links">
            <a href="#devtools">DevTools</a>
            <a href="#features">Features</a>
            <a href="#pricing">Pricing</a>
            <a className="btn btn-line" href={GITHUB} target="_blank" rel="noopener">
              <GitHubIcon /> GitHub
            </a>
            <a className="btn btn-solid" href="#enterprise">Get Enterprise</a>
          </div>
        </div>
      </nav>

      <main id="main">
      <header className="hero">
        <div className="wrap">
          <Reveal>
            <span className="eyebrow">
              <span className="dot" aria-hidden="true" /> v0.5 · live on npm as @meterbility/cli
            </span>
            <h1>
              The{" "}
              <span className="u">
                debugger
                <svg viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
                  <path pathLength="1" d="M2,7 C 25,3 60,9 98,4" />
                </svg>
              </span>{" "}
              for AI agents.
            </h1>
            <p className="sub">
              Capture every run. Inspect every decision. Pause and inject live. Fork from
              any step. Diff the trajectories. Meterbility turns agent runs into a
              queryable, replayable, forkable corpus.
            </p>
            <div className="hero-ctas">
              <a className="btn btn-solid" href="#pricing">Start free — it&apos;s open source</a>
              <a className="btn btn-line" href={GITHUB} target="_blank" rel="noopener">
                <GitHubIcon /> View on GitHub
              </a>
            </div>
            <CopyInstall />
            <p className="works">
              Works with · <span>Claude Code, Codex CLI, Cursor, Anthropic + OpenAI proxies, TypeScript &amp; Python SDKs</span>
            </p>
          </Reveal>
        </div>
      </header>

      <div className="instrument-wrap">
        <div className="wrap">
          <Reveal>
            <Instrument />
          </Reveal>
        </div>
      </div>

      <section id="devtools">
        <div className="wrap">
          <Reveal>
            <div className="sec-head">
              <span className="sec-num" aria-hidden="true">01</span>
              <div>
                <h2>Browser DevTools, mapped onto agents.</h2>
                <p>
                  You already know how to debug a web page. Meterbility gives your agents
                  the same panels — all shipping today.
                </p>
              </div>
            </div>
          </Reveal>
          <ul className="ledger">
            {PANELS.map((p, i) => (
              <Reveal key={p.to} as="li" className="ledger-row">
                <span className="ledger-idx" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
                <span className="ledger-from">{p.from}</span>
                <span className="ledger-to">
                  <span className="arrow" aria-hidden="true">→</span>
                  {p.to}
                </span>
                <span className="ledger-desc">{p.desc}</span>
              </Reveal>
            ))}
          </ul>
        </div>
      </section>

      <section id="features" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <Reveal>
            <div className="sec-head">
              <span className="sec-num" aria-hidden="true">02</span>
              <div>
                <h2>Full-fidelity capture. Local-first storage.</h2>
                <p>
                  Everything runs on your machine: SQLite plus content-addressed blobs.
                  Add Postgres when you need multi-machine sync.
                </p>
              </div>
            </div>
          </Reveal>
          <ul className="feats">
            {FEATURES.map((f, i) => (
              <Reveal key={f.title} as="li" className="feat">
                <span className="feat-idx" aria-hidden="true">F{String(i + 1).padStart(2, "0")}</span>
                <div>
                  <h3>{f.title}</h3>
                  <p>{f.desc}</p>
                </div>
              </Reveal>
            ))}
          </ul>
        </div>
      </section>

      <section id="pricing" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <Reveal>
            <div className="sec-head">
              <span className="sec-num" aria-hidden="true">03</span>
              <div>
                <h2>Open core. Start free, scale when your team does.</h2>
                <p>
                  The full single-operator product is MIT-licensed, forever. Paid tiers add
                  multi-tenant fleet orchestration and the hosted cloud.
                </p>
              </div>
            </div>
          </Reveal>
          <Reveal>
            <div className="tiers">
              <div className="tier">
                <h3 className="tier-name">Open Source</h3>
                <p className="tier-license">MIT license</p>
                <p className="tier-price">$0</p>
                <p className="tier-note">free forever, run it anywhere</p>
                <ul>
                  <li>All capture surfaces (Claude Code, Codex, Cursor, proxies)</li>
                  <li>Terminal + web inspector, Live Probe</li>
                  <li>Fork, replay, diff, regression suite</li>
                  <li>TypeScript &amp; Python SDKs</li>
                  <li>Local SQLite + optional Postgres sync</li>
                  <li>1,290+ tests, zero copyleft deps</li>
                </ul>
                <a className="btn btn-line" href={GITHUB} target="_blank" rel="noopener">
                  <GitHubIcon /> Get started on GitHub
                </a>
              </div>
              <div className="tier hot">
                <h3 className="tier-name">Team</h3>
                <p className="tier-license">Elastic License 2.0 (ee/)</p>
                <p className="tier-price">Early access</p>
                <p className="tier-note">join the design-partner program</p>
                <ul>
                  <li>Everything in Open Source</li>
                  <li className="soon">Multi-tenant fleet orchestration</li>
                  <li className="soon">SSO &amp; role-based access control</li>
                  <li className="soon">Audit logs</li>
                  <li className="soon">Long-retention storage modules</li>
                  <li>Direct line to the maintainers</li>
                </ul>
                <a className="btn btn-solid" href="#enterprise">Sign up for Team</a>
              </div>
              <div className="tier">
                <h3 className="tier-name">Enterprise</h3>
                <p className="tier-license">Commercial · hosted cloud</p>
                <p className="tier-price">Custom</p>
                <p className="tier-note">tailored to your fleet</p>
                <ul>
                  <li>Everything in Team</li>
                  <li className="soon">Hosted cloud — zero-ops backend</li>
                  <li className="soon">Compliance &amp; procurement support</li>
                  <li className="soon">SLAs &amp; priority support</li>
                  <li className="soon">Custom capture adapters</li>
                  <li>Shape the roadmap with us</li>
                </ul>
                <a className="btn btn-solid" href="#enterprise">Sign up for Enterprise</a>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      <section id="enterprise" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div className="signup-grid">
            <Reveal className="signup-copy">
              <span className="sec-num" aria-hidden="true" style={{ display: "block", marginBottom: 14 }}>04</span>
              <h2>Get on the list.</h2>
              <p>
                The Team and Enterprise tiers are in early access. Tell us about your
                fleet and we&apos;ll reach out to set you up as a design partner.
              </p>
            </Reveal>
            <Reveal>
              <EnterpriseForm />
            </Reveal>
          </div>
        </div>
      </section>

      <div className="open-strip">
        <div className="wrap open-inner">
          <div>
            <h3>Built in the open.</h3>
            <p>
              MIT-licensed core, permissive dependencies only, and a fresh-laptop test
              script that proves the install path on every CI run.
            </p>
            <div className="stats">
              <div className="stat"><b>1,290+</b>tests, two runtimes</div>
              <div className="stat"><b>11</b>@meterbility/* packages</div>
              <div className="stat"><b>0</b>copyleft deps</div>
              <div className="stat"><b>v0.5</b>shipping now</div>
            </div>
          </div>
          <a className="btn btn-line" href={GITHUB} target="_blank" rel="noopener">
            <GitHubIcon /> Star on GitHub
          </a>
        </div>
      </div>

      </main>

      <footer>
        <div className="wrap">
          <div className="foot">
            <div className="foot-col" style={{ maxWidth: 280 }}>
              <a className="wordmark" href="#">meterbility<span className="tick" aria-hidden="true">_</span></a>
              <p style={{ fontSize: 14, color: "var(--ink-3-solid)", marginTop: 12 }}>
                The debugger for AI agents. Capture, inspect, probe, fork, diff.
              </p>
            </div>
            <div className="foot-col">
              <h4>Product</h4>
              <a href="#devtools">DevTools panels</a>
              <a href="#features">Features</a>
              <a href="#pricing">Pricing</a>
              <a href="#enterprise">Enterprise signup</a>
            </div>
            <div className="foot-col">
              <h4>Developers</h4>
              <a href={GITHUB} target="_blank" rel="noopener">GitHub</a>
              <a href="https://www.npmjs.com/package/@meterbility/cli" target="_blank" rel="noopener">npm — @meterbility/cli</a>
              <a href="https://pypi.org/project/meterbility-agent/" target="_blank" rel="noopener">PyPI — meterbility-agent</a>
              <a href={`${GITHUB}/blob/main/docs/getting-started.md`} target="_blank" rel="noopener">Getting started</a>
              <a href={`${GITHUB}/blob/main/docs/architecture.md`} target="_blank" rel="noopener">Architecture</a>
            </div>
            <div className="foot-col">
              <h4>Project</h4>
              <a href={`${GITHUB}/blob/main/CONTRIBUTING.md`} target="_blank" rel="noopener">Contributing</a>
              <a href={`${GITHUB}/blob/main/SECURITY.md`} target="_blank" rel="noopener">Security</a>
              <a href={`${GITHUB}/blob/main/LICENSE`} target="_blank" rel="noopener">MIT License</a>
              <a href={`${GITHUB}/blob/main/LICENSES-third-party.md`} target="_blank" rel="noopener">Third-party licenses</a>
            </div>
          </div>
          <div className="foot-bottom">
            <span>© 2026 Meterbility. MIT (core) · ELv2 (ee/).</span>
            <span className="cmd">npm install -g @meterbility/cli</span>
          </div>
        </div>
      </footer>
    </>
  );
}
