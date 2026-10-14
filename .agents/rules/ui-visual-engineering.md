---
name: ui-visual-engineering
trigger: model_decision
description: "Visual engineering, W3C design tokens, 60-30-10 palette ratio, 8pt grid, strict light/dark theme parity, mandatory micro-interactions, and 8 interaction states for frontend development."
---

# UI Visual Engineering & Design System Standards

Authoritative visual engineering, design tokens, and user interface standards for all frontend applications.

---

## 1. Visual Engineering & Design Tokens
- MUST adhere to W3C Design Tokens (`tokens.json`), 60-30-10 palette ratios, and the 8pt grid system.
- Arbitrary Tailwind values (`p-[13px]`, `text-[#...]`) and AI-slop anti-patterns (purple haze gradients, unconstrained glassmorphism) are STRICTLY FORBIDDEN.
- Colors, surfaces, and spacing MUST resolve through semantic theme tokens (`bg-card`, `text-card-foreground`, `border-border`, `var(--acs-color-*)`). Hardcoded hex color codes in markup are forbidden.
- Components MUST be centralized and reusable (Button, Card, Badge, Modal, Input, Alert) rather than copy-pasting disparate utility classes.

---

## 2. Strict Theme Parity & Anti-Drift Standards
- Rendering dark components or cards atop light canvases (and vice versa) is STRICTLY PROHIBITED (theme drift).
- **Light Mode**: 100% light surfaces: canvas `bg-neutral-50` / `bg-white`, subtle borders, high-contrast text `text-neutral-900`. Normal text WCAG AA contrast ratio MUST be ≥ 4.5:1.
- **Dark Mode**: 100% dark surfaces: canvas `bg-neutral-950` / `bg-neutral-900`, subtle borders, high-contrast text `text-neutral-100`. Normal text WCAG AA contrast ratio MUST be ≥ 4.5:1.
- Interactive elements (cards, queries, lists, notifications) MUST use semantic theme classes. Hardcoding dark colors (e.g., `bg-[#1c2333]`) inside light templates is forbidden.
- Pages MUST adopt a structured theming architecture (`:root` + `[data-theme="dark"]` or `prefers-color-scheme`), ensuring consistent token consumption across all views.

---

## 3. Mandatory Micro-Interactions & Tactile Motion
- Buttons MUST declare explicit transitions and tactile feedback: `transition-all duration-150 ease-out`, `hover:scale-[1.01]` / `hover:brightness-105`, `active:scale-[0.98]`, `focus-visible:ring-2 focus-visible:ring-offset-2`.
- Hover cards MUST feature subtle elevation or border transitions (`transition-all duration-150`, `hover:border-*` / `hover:shadow-*`).
- Progress indicators MUST present smooth transitions (`transition-all duration-300 ease-in-out` or pulsing shimmers during execution) to communicate ongoing activity.
- State-mutating actions (Copy, Save, Adopt) MUST provide immediate visual feedback (e.g., animated green checkmarks or dynamic label swaps). Target quality: WCAG AA+ compliant.
- Static, un-animated buttons (stateless buttons) are prohibited.

---

## 4. Eight Mandatory Interaction States
Every interactive component MUST explicitly handle all 8 states:
1. `idle`: Standard default presentation.
2. `hover`: Subtle visual feedback upon cursor entry.
3. `focus-visible`: Accessible focus ring for keyboard navigation.
4. `active`: Visual depression/feedback upon click or press.
5. `disabled`: Reduced contrast and `cursor-not-allowed`.
6. `loading`: Skeleton placeholder or spinner preserving layout dimensions.
7. `empty`: Informative empty state illustrating missing data.
8. `error`: High-visibility error styling with descriptive remediation messaging.

---

## 5. Immutability & File Constraints
- Enforce immutability via object and array spread: `{ ...obj, key: 'val' }`, `[...items, newItem]`.
- File size discipline: tolerance 300 LOC, hard ceiling at 500 LOC (warning at 300, blocked at 500).
<!-- ACS workflow v1.6.1+4e24e01 -->
<!-- ACS workflow v1.33.0+4e24e01 -->
