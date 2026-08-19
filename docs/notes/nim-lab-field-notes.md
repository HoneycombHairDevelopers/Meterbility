# NIM Lab Field Notes
**Lab A - Meterbility x NVIDIA NIM: The Complete Runbook**

| | |
|---|---|
| Date | <!-- YYYY-MM-DD --> |
| Branch | `nim-endpoint-support` |
| Models under test | Nemotron: `<!-- exact ID from catalog page -->` <br> Llama-family: `<!-- exact ID from catalog page -->` |
| Base URL | `https://integrate.api.nvidia.com/v1` |
| Started / Ended | <!-- HH:MM --> / <!-- HH:MM --> |

> Rule of the lab: write the note the moment the thing happens. Friction evaporates from memory within minutes, and friction is the most valuable thing collected today.

---

## Delights

<!-- Things that worked better than expected. Anything that made you say "oh, nice." These become the warm half of the article and the honest praise in the field-feedback memo. -->

Time to first API key very quick after launching a build account and logging in. Did not necessarily know what it as for when it was generated. 

-

---

## Friction

<!-- Anything that cost you time, confused you, or made you re-read a doc. Be specific: exact error string, exact click path, exact assumption that failed. This is the highest-value section. -->

Difficulty finding the model id that the guide recommended that I use. There is, however, a code sample in different languages and the ability to generate a model per API key. 
-

---

## Ideas

<!-- Product ideas for Meterbility, article angles, DevRel suggestions for NVIDIA, feature gaps you noticed. -->

-

---

# Numbered Field Notes

These are the eight prompts the runbook plants in each phase. Fill them in place.

### Field note #1 - Time-to-first-key (Phase 0)
*Time from landing on build.nvidia.com to holding an `nvapi-` key. Note every click that confused you.*

- Landed at:
- Key in hand at:
- **Elapsed:**
- Click path taken:
- Confusing moments:

### Field note #2 - Model discoverability (Phase 0)
*How discoverable was the right model? Did the catalog's categories match how an agent developer thinks (reasoning / tool-use / long-context), or did you have to translate?*

- How I searched:
- Categories offered vs. categories I wanted:
- Translation cost:

### Field note #3 - `usage` field behavior (Phase 1a)
*Does `usage` come back populated? On streaming responses too? Test both. Meterbility's cost accounting depends on this field.*

| Case | `prompt_tokens` | `completion_tokens` | Notes |
|---|---|---|---|
| Non-streaming | | | |
| Streaming, default | | | |
| Streaming + `stream_options: {"include_usage": true}` | | | |

- Verdict for the adapter:

### Field note #4 - Tool-call JSON quality (Phase 1c)
*Valid first try? Any schema quirks vs. OpenAI/Anthropic behavior you know from your existing adapters?*

- Valid on first attempt (y/n):
- Quirks observed:
- Differences from OpenAI adapter expectations:
- Differences from Anthropic adapter expectations:

### Field note #5 - What broke in the proxy (Phase 2)
*Whatever broke here IS the release-note diff. Write down the exact assumption that failed.*

- Auth pattern chosen (passthrough / injection):
- Exact assumption that failed:
- File(s) touched:
- One-line release-note phrasing:

### Field note #6 - SSE buffering and flush (Phase 2)
*Any buffering/flush behavior you had to fix. Great technical-blog material.*

- Symptom:
- Root cause:
- Fix:
- Blog-worthy detail:

### Field note #7 - Token multiplication (Phase 3)
*Exact input-token growth per step as context accumulates. Article centerpiece and interview line.*

| Step | Input tokens | Output tokens | Latency (ms) | Tool called |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |

- **Multiplication factor (step 1 to step N):**
- Interview line, filled in: "In my own traces, a _-step agent turn re-sends the prompt _x. Here's what prefix caching would save: ___."

### Field note #8 - Live Probe against NIM vs. usual providers (Phase 4)
*Any latency or UX difference?*

- Pause responsiveness:
- Injection landed cleanly (y/n):
- Resume behavior:
- Compared to OpenAI/Anthropic:

### Overflow notes (#9+)

<!-- Target is >=10 total entries. Anything that does not fit a numbered slot goes here. -->

- #9:
- #10:

---

# Measurements Log

### TTFT, hand-measured (Phase 1b)

| Model | Run | TTFT (ms) | Total (ms) | Notes |
|---|---|---|---|---|
| Nemotron | 1 | | | |
| Nemotron | 2 | | | |
| Llama | 1 | | | |
| Llama | 2 | | | |

- Median Nemotron TTFT:
- Median Llama TTFT:
- Where I measured from (client send / first byte / first content delta):

### TTFT, proxy-observed (Phase 2)

| Model | Proxy TTFT (ms) | Hand-measured (ms) | Delta | Explanation |
|---|---|---|---|---|
| | | | | |

### Agent run gallery (Phase 3)

| Run | Steps | Total in-tokens | Total out-tokens | Wall clock | Outcome | Trace ID / screenshot |
|---|---|---|---|---|---|---|
| 1 | | | | | | |
| 2 | | | | | | |
| 3 | | | | | | |
| 4 | | | | | | |

- Variance worth showing on camera:

### Determinism check (Phase 4)

- Params held constant: `temperature=`, `seed=`, `max_tokens=`
- Replay 1 vs. replay 2 output:
- Honest label (bit-exact / distribution-matched / best-effort), per Engine Adapters spec F3.6:

---

# Phase Gates

Check each only when its "done when" is truly satisfied.

### Phase 0 - Prep (15 min)
- [ ] build.nvidia.com account, credits confirmed
- [ ] `NVIDIA_API_KEY` exported, not committed
- [ ] Two exact model IDs copied from their own model pages
- [ ] Clean tree on branch `nim-endpoint-support`
- [ ] This notes file open and visible

### Phase 1 - First Contact (30-40 min)
- [ ] `curl` smoke test returns OpenAI-shaped response
- [ ] `scripts/nim-smoke.ts` passes on both models
- [ ] Streaming works, TTFT recorded by hand
- [ ] Tool-calling returns well-formed `tool_calls`

### Phase 2 - Proxy Passthrough (30-45 min)
- [ ] Proxy upstream pointed at the NIM base URL
- [ ] Auth pattern decided and working
- [ ] Request + response bodies captured in inspector
- [ ] Token counts populated from `usage` (or gap documented)
- [ ] Latency recorded and sanity-checked against Phase 1b
- [ ] Namespaced model ID (`nvidia/...`) renders gracefully in the UI
- [ ] SSE chunks flow live, not as one blob
- [ ] Cost-accounting v1 behavior decided and logged as a known limitation

### Phase 3 - Real Agent Run (45-60 min)
- [ ] Tool loop built (`list_files`, `read_file`, `word_count`)
- [ ] 3-4 runs completed against Nemotron through the proxy
- [ ] Inspector shows steps, tool args/results, per-step tokens and latency
- [ ] Best trace screenshotted (Substack shot #3)
- [ ] Token-growth numbers recorded in field note #7

### Phase 4 - Fork, Replay, Live Probe (30-45 min)
- [ ] Fork at step 2 replayed against NIM, divergent branch renders
- [ ] Determinism labeled honestly
- [ ] Live Probe pause, inject, resume succeeded
- [ ] Full sequence rehearsed once unrecorded

### Phase 5 - Ship It (20-30 min)
- [ ] Phase 2 code merged, diff small and honest
- [ ] Docs section: base URL, key format, one config example, one caveat
- [ ] Release note drafted (v0.3.2 or similar)
- [ ] README provider line includes **NVIDIA NIM**
- [ ] Tagged and pushed, public timestamp confirmed

### Phase 6 - Demo Recording (45-60 min)
- [ ] Two silent run-throughs done
- [ ] 3-4 min video recorded and exported, 1080p+
- [ ] 90-second live cut rehearsed twice out loud

### Whole-lab Definition of Done
- [ ] Raw NIM call works from a script
- [ ] `meter proxy` captures a NIM-served request end-to-end
- [ ] Multi-step agent run lands in the inspector with full timeline
- [ ] One fork/replay and one Live Probe executed against NIM
- [ ] Release note + README badge shipped
- [ ] Demo video recorded, 90-second cut rehearsed
- [ ] This file has >= 10 entries

---

# Artifacts Produced

| Artifact | Location / link | Status |
|---|---|---|
| `scripts/nim-smoke.ts` | | |
| Agent tool-loop harness | | |
| Best trace screenshot (Substack shot #3) | | |
| Fork/branch screenshot | | |
| Live Probe screenshot | | |
| Release note | | |
| README diff | | |
| Demo video (3-4 min) | | |
| 90-second cut | | |

---

# Troubleshooting Encountered

Log only what actually happened, with the fix that actually worked.

| Time | Symptom | Suspected cause | Fix that worked | Minutes lost |
|---|---|---|---|---|
| | | | | |

<details>
<summary>Reference table from the runbook (unedited)</summary>

| Symptom | Likely cause | Fix |
|---|---|---|
| `401 Unauthorized` | Key not exported in the shell running the proxy, or proxy stripped the header | `echo $NVIDIA_API_KEY`; log outbound headers once (redacted) |
| `404 model not found` | Guessed model ID | Copy the exact ID from the model page's own code sample |
| `429` / credit errors | Free-tier rate limit or credits exhausted | Add retry/backoff to the loop; check remaining credits in the catalog UI |
| Stream arrives as one blob | Proxy buffering SSE | Flush per-chunk; disable body buffering on the proxy route |
| `usage` missing on streams | Server omits usage unless requested | Send `stream_options: {"include_usage": true}`, else estimate and label it |
| Long hangs on big models | Cold model or long generation | Client timeouts 60s+, cap `max_tokens` in the demo loop |
| Tool-call loop never terminates | Model keeps calling tools | Cap iterations at 6, treat as demo color |
| Latency inflated in inspector | Proxy overhead vs. TTFT measurement point | Compare against Phase 1b hand-measured TTFT, document measurement point |

</details>

---

# Downstream Consumers

What each output feeds, so nothing gets written twice.

- **Substack article** - Delights, Friction, field notes #3, #6, #7, TTFT table, token multiplication table, screenshots.
- **Field-feedback memo to NVIDIA** - Field notes #1, #2, #4, plus anything in Friction about the catalog and docs.
- **Release note and README** - Field note #5, cost-accounting decision, streaming caveat.
- **Interview talk track** - Field note #7, determinism label from Phase 4, the 90-second cut.

### The two sentences earned from this lab

Rewrite these once, at the end, with real numbers substituted.

- For Christy: *"NIM endpoints keep the OpenAI-compatibility promise. I verified it by pointing my own debugger's proxy at them, and I shipped NIM support in Meterbility last week. I can show you an agent trace running on Nemotron in about ninety seconds."*
- For the article: *"Nobody joins agent traces to serving telemetry, so I started with the layer everyone can access: the OpenAI-compatible seam where NVIDIA's inference stack meets the agent ecosystem."*
