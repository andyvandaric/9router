---
trigger: always_on
---

# ACS Global English Copywriting Governance (ACS-DNC Framework — Developer-Native Copywriting)

All agents (Lead Orchestrator and Subagents) MUST adhere to this copywriting standard whenever writing, editing, or reviewing developer documentation, product copy, marketing pages, release announcements, or CLI messages in **English**.

The goal is to eliminate generic robotic AI patterns (*AI slop*) and deliver **clean, friendly, natural, high-converting Developer-Native English (ACS-DNC)** that resonates with engineers and technical buyers worldwide.

---

## 🌍 1. The Global English Standard (Grade 6-8 Readability)

More than 70% of software engineers reading English are non-native English speakers. Great developer copy is **clear, humble, warm, and effortless to parse**:

- **Model Tone:** Write like the engineering teams at **Stripe, Linear, GitHub, and Basecamp**—sharp, friendly, respectful, and direct.
- **Short Words > Complex Words:** Use "use" instead of "utilize", "help" instead of "facilitate", "start" instead of "commence", "show" instead of "demonstrate".
- **Active Voice:** "ACS runs in the background" instead of "Background operations are executed by ACS".
- **Short Sentences:** Keep sentences under 20 words. If you run out of breath reading it aloud, split it with a period.

---

## 🚫 2. Absolute Ban on "AI Slop" (Taboo Phrases & Corporate Clichés)

AI models frequently output formulaic fluff. The following patterns are **STRICTLY FORBIDDEN** in any user-facing text:

### Banned Opening Clichés
- ❌ *"In today's fast-paced digital world..."* / *"In the rapidly evolving landscape of AI..."*
  - **Why:** Empty filler that wastes the reader's attention.
  - **Fix:** Cut completely. Open directly with the developer's actual problem.
- ❌ *"Imagine a world where..."* / *"Picture this: you are..."*
  - **Why:** Cheap dramatic trope that feels like an infomercial.
  - **Fix:** Jump straight to the real scenario: *"When your AI agent breaks production..."*

### Banned Corporate Buzzwords
- ❌ *"Delve into..."* / *"Dive deep into the realm of..."* ➔ **Fix:** *"Explore"*, *"Look at"*, *"Inspect"*.
- ❌ *"Seamlessly integrate..."* ➔ **Fix:** *"Connects in 1 step"*, *"Runs out of the box"*.
- ❌ *"Supercharge your workflow..."* ➔ **Fix:** *"Save 3 hours daily"*, *"Cut token spend by 80%"*.
- ❌ *"Unlock the full potential of..."* ➔ **Fix:** *"Get complete control over..."*.
- ❌ *"Revolutionary / Game-changing / Paradigm shift"* ➔ **Fix:** Show concrete metrics and let the user decide.

### Banned Academic Transitions & Preachiness
- ❌ *"It is important to remember that..."* / *"Needless to say..."* / *"As we all know..."*
  - **Why:** Sounds patronizing, like a lecture.
  - **Fix:** State the fact directly: *"Remember:"* or simply state the truth.
- ❌ *"In conclusion..."* / *"To wrap things up..."* / *"Ultimately..."*
  - **Why:** High-school essay conclusion.
  - **Fix:** End with a strong benefit statement or a clear Call-to-Action button.

### Banned Formatting Quirks
- ❌ **Em-Dash Overdose (—):** Limit em-dashes to at most one per page. Break clauses into two clean sentences.
- ❌ **Stiff Bold Lists (`- **Title:** Explanation`):** Write flowing, conversational bullets instead of repetitive dictionary definitions.

---

## 🎯 3. Problem-Solving First, Never Stack-Bragging (HARD RULE)

Buyers and engineers do not purchase programming languages or database engines—they purchase **time saved, peace of mind, and outcomes**:

1. **Lead with the Pain Relieved, Not the Tech Stack**:
   - ❌ *Stack-First:* "ACS Core: Built with Go, Cloudflare Workers, and SQLite with Zero Console Flicker."
   - ✅ *Problem-First:* "Stop AI agents from hallucinating rules and breaking your codebase: deterministic local guardrails for Claude Code."
2. **Position Stack as Proof, Not the Hero**:
   - Mention Go, Cloudflare D1, or Garble only in architecture sections as technical justification (*reason to believe*), never as the headline hook.
3. **The "So What?" Test**:
   - For every feature listed, ask: *"So what does this do for my afternoon as an engineer?"*
   - Feature: *Stateless reverse proxy.* ➔ Benefit: *Zero RAM bloat, laptop runs cool even with 10 agents running.*

---

## 🛠️ 4. The 18 ACS-DNC Formulas (Categorized)

**A. Fundamental & Mindset**

### ACS-DNC #0: The "Engine + Cockpit" Mindset (Product + Packaging)
- Just as a great developer tool succeeds through both a bulletproof core engine and a frictionless terminal experience.
- In software copy, **Copywriting** is the *engine* (the substance), and **Typography & Layout** is the *cockpit* (the scan path). Both must be tuned for effortless developer comprehension.

### ACS-DNC #17: The 4-Part Sovereign Structure (WHAT, WHY, VALUE, HOW)
Ensure the narrative flow follows this clean 4-part architectural ladder:
- **WHAT:** Crisp statement of what the tool actually is. Give it a clear name and a tangible visual.
- **WHY:** Why should the engineer care right now? Point directly to the pain point, broken status quo, or wasted budget.
- **VALUE:** Why is the price or effort worth it? Ground it in quantified ROI (hours saved, tokens reduced, license clarity) with a no-risk guarantee.
- **HOW:** Exactly how does the developer get it? Give a clear command or button: *"Run the 1-line installer and paste your key."*

**Concrete Example (Selling ACS):**
- *(WHAT):* "This is Agnostic Config Suites (ACS) – A local orchestration and boundary control engine for your AI coding agents."
- *(WHY):* "Without it, default agent setups eat 10,474 tokens on boot and overwrite files across unverified environments."
- *(VALUE):* "ACS cut idle token burn by 88% and completely eliminates terminal window flicker. One-time license, zero monthly SaaS tax."
- *(HOW):* "Get started in 2 minutes: download the single binary, run `acs activate <key>`, and start coding."

### ACS-DNC #11: The Focus Tunnel (No Distracting External Leaks)
Never link out to external websites or documentation from a primary conversion/sales page unless it is the explicit checkout or activation action.
- External links invite developers to browse away into rabbit holes. Keep attention anchored on the single offer.

**B. Word Choice & Conversational Tone**

### ACS-DNC #1: Sensory & Tangible Technical Words
Replace flat, abstract words with tactile, sensory phrasing that engineers can feel:
- *Avoid:* "High-performance background operation."
- *Use:* "Whisper-quiet background daemon that never steals window focus or flashes a console popup."

### ACS-DNC #2: Specificity & The "So What?" Drill-Down
- **Kill Clichés:** Ban generic claims like "best-in-class", "industry-standard", or "seamless".
- **Replace Adjectives with Ground-Truth Numbers:** "Significantly faster" ➡️ "Cuts boot latency from 4.2s to 120ms".
- **Drill Down to Outcomes:** When mentioning a feature, always answer *"So what?"*:
  - *Feature:* "Stateless REST MCP fallback." ➔ *So what?* ➔ "If an MCP stdio pipe drops mid-session, your agent fails over in 40ms without dropping your task context."

### ACS-DNC #3: Ruthless Word Economy (Zero Redundancy)
If a technical point can be stated in 8 words, never use 16:
- ❌ *"In order to ensure that the environment is completely isolated from production, it is necessary to..."*
- ✅ *"To isolate staging from production, ACS locks port 20155."*

### ACS-DNC #4: Conversational Engineering Flow (Peer-to-Peer)
Write as one experienced software engineer explaining an elegant architecture to another over coffee:
- Read your copy aloud. If you stumble or run out of breath, break the clause with a period.
- Avoid both robotic corporate stiffness and cringey fake excitement.

### ACS-DNC #8: Flawless Grammar & Typographic Precision
Small typos, unescaped markdown, and broken punctuation signal sloppy engineering and destroy trust.
- Double-check code fences, CLI flags, backticks, and sentence capitalization.
- Keep technical acronyms capitalized (CLI, API, SDK, D1, RAM, CPU, SSH, MCP).

**C. Typography & Readability (Scannability)**

### ACS-DNC #5: Crisp Paragraphs (Max 3 to 4 Lines)
Developers do not read wall-to-wall text; they scan for signal.
- **Maximum 3 to 4 lines per paragraph** on desktop screens.
- Break long paragraphs with a single line break. 1-to-2 sentence punchlines are encouraged.

### ACS-DNC #6: High-Signal Bullets & Numbering
When detailing features, prerequisites, or error remediation, always use formatted lists.
- Bullet points catch scanning eyes and organize technical information hierarchically.

### ACS-DNC #7: Left-Aligned Readability
- All body copy, explanations, and feature descriptions MUST be **left-aligned**.
- Center-alignment is strictly reserved for single-line main hero headlines. Left alignment provides a steady vertical reading axis.

### ACS-DNC #9: Typography & Case Hygiene (No ALL-CAPS Walls)
- Never write entire sentences in ALL CAPS. It reads like an alarming compiler panic.
- Reserve capitalization for command names, acronyms, and single-word emphasis. Use sentence case for clear body readability.

### ACS-DNC #15: Pattern Interrupts for Scanners
- Combat reader fatigue by alternating text pacing: weave short statements between bullet lists, monospace code snippets (`acs doctor`), and highlighted metric callouts.

**D. UI/UX, Visuals & Conversion Strategy**

### ACS-DNC #10: Action-Oriented CTA Buttons
- Avoid passive or robotic button text like "Submit" or "Click Here".
- Use outcome-driven labels: *"Get Your ACS License"*, *"Activate in 1 Step"*, *"Download Single Binary"*.

### ACS-DNC #12: Zero-Lag Visuals & Lazy Loading
- A developer sales page is not a heavy media portfolio. Use diagrams, SVGs, and ASCII charts for fast visual proof.
- Always lazy-load heavy assets. Slow loading kills conversion before your copy is even rendered.

### ACS-DNC #13: Logical Micro-Commitments
- Guide the developer step-by-step: Read Headline ➔ Inspect Terminal Benchmark ➔ Verify Proof ➔ Select License Plan.

### ACS-DNC #14: Clean Pricing Psychology
- State prices plainly and transparently without hidden asterisk surprises.
- For international developer audiences, present clear USD tiers alongside local payment methods (e.g. QRIS for Southeast Asian developers).

### ACS-DNC #16: Fair Value & Bundling Structure
- Offer straightforward perpetual or annual licensing with transparent upgrade terms.
- Highlight the elimination of monthly subscription fatigue: *"Own the tool, keep your runtime sovereign."*
<!-- ACS workflow v1.6.1+5637dd7 -->
<!-- ACS workflow v1.33.0+5637dd7 -->
