# Plan Forge — Design System (Master)

> **Source of truth.** When building or modifying a page, first check
> `design-system/pages/[page-name].md`. If that file exists, its rules **override**
> this master. Otherwise, strictly follow the rules below.

**Project:** Plan Forge — PM Drafting Console
**Generated:** 2026-05-19
**Stack:** Vanilla HTML + CSS + JS (no framework, no build step)
**Themes supported:** `light` (default) · `dark` · `midnight`

---

## 1. Identity

Plan Forge is a **single-user document-drafting console** that generates project-management artifacts via LLM. Its visual identity is **"engineering blueprint"** — serif display headings paired with monospace technical labels, corner-tick panels evoking drafting paper, and a navy + cyan + indigo palette.

**Tone:** Professional, document-centric, calmly authoritative. Not playful, not consumer.
**Audience:** Project managers, technical leads, intrapreneurs delivering artifacts under deadline pressure.
**Anti-tone:** Avoid playful emoji, gradient overload, gamification, and consumer-app patterns.

---

## 2. Color tokens (CSS custom properties)

All colors live in `:root` / `[data-theme="..."]` blocks in `styles.css:5-131`. **Never hardcode hex values in component styles or component logic** — always reference a token.

### Light (default)

| Role | Token | Hex | Use |
|------|-------|-----|-----|
| Background | `--ink` | `#ffffff` | Page background |
| Surface | `--ink-panel-solid` | `#ffffff` | Panel / card fill |
| Surface alt | `--ink-deep` | `#f8fafc` | Subtle alt fill (panel-head bg) |
| Primary text | `--paper` | `#0f172a` | Body, headings |
| Secondary text | `--paper-dim` | `#475569` | Labels, meta |
| Tertiary text | `--ghost` | `#94a3b8` | Placeholder, captions |
| Brand | `--cyan` / `--primary` | `#5b6cff` | Accents, links, focus |
| Brand bright | `--cyan-bright` | `#7a8dff` | Hover state |
| Brand soft bg | `--cyan-deep` / `--primary-deep` | `#eef2ff` | Mission box bg, active item |
| Success | `--green` | `#10b981` | Online dot, success badge |
| Warning | `--amber` | `#fbbf24` | Required-field marker, warning |
| Danger | `--red` / `--danger` | `#ef4444` | Errors, destructive actions |

### Dark

| Role | Token | Hex |
|------|-------|-----|
| Background | `--ink` | `#0f172a` |
| Surface | `--ink-panel-solid` | `#1a1f35` |
| Surface alt | `--ink-deep` | `#1e293b` |
| Primary text | `--paper` | `#f1f5f9` |
| Secondary text | `--paper-dim` | `#cbd5e1` |
| Brand | `--cyan` / `--primary` | `#818cf8` |
| Brand soft bg | `--cyan-deep` | `#312e81` |

### Midnight

| Role | Token | Hex |
|------|-------|-----|
| Background | `--ink` | `#020617` |
| Surface | `--ink-panel-solid` | `#0f172a` |
| Brand | `--cyan` / `--primary` | `#60a5fa` |
| Brand soft bg | `--cyan-deep` | `#1e3a8a` |

### Contrast rules (enforced)

- **Body text vs surface:** ≥ 4.5:1 (WCAG AA).
- **Secondary text vs surface:** ≥ 3:1.
- **Brand text on surface (any theme):** ≥ 4.5:1 — `--cyan` against light surface passes; against light `app-header` gradient also passes.
- **Every theme is tested independently.** Don't assume dark-mode values work if light passes.

---

## 3. Typography system

**Three-font stack** — this is non-negotiable for the blueprint identity:

| Family | Role | Use cases |
|--------|------|-----------|
| **DM Serif Display** | Display | Brand wordmark, H1/H2 in rendered output, big empty-state phrases |
| **Work Sans** | UI body | Buttons, paragraphs, form input values, descriptive prose |
| **JetBrains Mono** | Technical | Labels (uppercase, letter-spaced), panel heads (`FIG. 01`), code, tables in output, all metadata |

**CSS imports** stay in `index.html:9` (Google Fonts inline link). Don't add a fourth family.

### Type scale

| Token | Size | Use |
|-------|------|-----|
| Display XL | 56px / serif | Auth masthead `Plan Forge.` |
| H1 | 32px / serif | Output H1 |
| H2 | 24px / serif italic | Output H2 |
| H3 | 13px / mono uppercase 0.18em | Output H3 (treated as technical label) |
| Body | 14px / sans | Default UI body |
| Body bold | 14px / sans 600 | Emphasis |
| Label | 11px / mono uppercase 0.18em | Form labels, panel heads |
| Caption | 10.5px / mono uppercase 0.15em | Meta, dates, archive timestamps |
| Tiny | 9.5–10px / mono uppercase 0.18em | Archive type tag, title-block keys |

### Rules

- **Base body size:** 14px desktop, **bump to 16px mobile** (prevents iOS auto-zoom on input focus). Currently 14px everywhere — this is a known gap.
- **Line-height:** 1.6 for UI body, 1.7 for rendered markdown.
- **Number alignment in tables:** use `font-feature-settings: "tnum"` for tabular figures. Currently missing in `.md table`.
- **Avoid:** any font outside the three-family system. If you need a 4th visual register, vary weight or size of an existing family.

---

## 4. Spacing rhythm (4 / 8 grid)

| Token | px | Use |
|-------|----|----|
| xs | 4 | Inline icon-text gap |
| sm | 8 | Tight group gap |
| md | 14 | Standard gap (panel-head padding-y) |
| lg | 18 | Form field vertical gap |
| xl | 22 | Panel body padding |
| 2xl | 28 | Section margin |
| 3xl | 40 | Output body padding-x |

**Rule:** every margin/padding/gap must be one of these values. No `margin: 15px` — round to 14 or 16.

---

## 5. Elevation (shadow scale)

| Token | Value | Use |
|-------|-------|-----|
| Flat | none | Default panels |
| Subtle | `0 1px 3px rgba(0,0,0,0.08), 0 4px 16px rgba(0,0,0,0.06)` | Panels at rest |
| Floating | `0 4px 12px rgba(91,108,255,0.4), 0 0 0 4px rgba(91,108,255,0.1)` | Primary button hover |
| Modal | `0 10px 40px rgba(0,0,0,0.15)` | Settings / refine modals |
| Toast | `0 4px 16px rgba(0,0,0,0.1)` | Toast notifications |

**Don't invent new shadow values.** If you need something different, pick the closest and accept it.

---

## 6. Panel pattern (blueprint)

The corner-tick panel is **the** structural primitive. Use it for every card-like container.

```html
<div class="panel">
  <span class="tick-bl"></span><span class="tick-br"></span>
  <div class="panel-head">
    <span><span class="fig">01</span> · Section Title</span>
    <span>meta / status</span>
  </div>
  <div class="panel-body">...</div>
</div>
```

- `::before` / `::after` pseudo-elements draw top-left / top-right ticks.
- The two `<span class="tick-bl/br">` elements draw bottom ticks.
- Numbering (`FIG. 01`, `FIG. 02`, `FIG. 00`) is decorative — keep it consistent within a view.

**Rule:** new top-level views should use this panel. Don't introduce flat unbordered cards alongside the tick panels — pick one.

---

## 7. Motion & micro-interactions

| Trigger | Duration | Easing | Property |
|---------|----------|--------|----------|
| Button hover | 300ms | `cubic-bezier(0.4,0,0.2,1)` | `transform`, `box-shadow`, `background` |
| Panel hover | 300ms | same | `box-shadow` |
| Input focus | 300ms | same | `border-color`, `box-shadow` |
| Theme switch | 400ms | same | `background` (on `body`) |
| Modal enter | 300ms | same | `opacity` + `translateY(20px) → 0` + `scale(0.95 → 1)` |
| Toast enter | 300ms | same | `translateY(15px) → 0` + `opacity` |
| Loading bars | 1.2s loop | `ease-in-out` | `height` |
| Archive-item hover | 250ms | same | `background`, `border-left`, `box-shadow` |

### Rules

- **Only animate `transform`, `opacity`, `background-color`, `border-color`, `box-shadow`.** Never animate `width` / `height` / `top` / `left` / layout properties.
- **Respect `prefers-reduced-motion`** — when set, drop durations to 0.01s and disable the loading-bar animation. Currently missing globally; add to root stylesheet.
- **No animation longer than 500ms** outside the looping loading bars.

---

## 8. Loading & feedback (HIGH PRIORITY)

The current `renderThinking()` shows fake fixed progress steps with a hardcoded model name (`"Drafting with claude-sonnet-4"`). This is a violation of two design-system rules and a CRITICAL audit finding:

### Rules

- **Progress text must reflect reality.** Model name must come from the active config, not be hardcoded.
- **Long async operations (>1s) use skeleton or progress indicator**, not animated lies.
- **Best practice for LLM:** stream output token-by-token (CLAUDE.md §12 #1). Single spinner for 10–30s is poor UX.
- **Required during in-flight generation:**
  - Disable the form (`pointer-events: none; opacity: 0.6` on `#dynamic-fields`).
  - Disable the Generate button (already done).
  - Show generic, honest copy: "Drafting artifact…" + animated bars, no fake step list.

### Toast rules

- Success: cyan-tinted border, white surface.
- Error: red-tinted border, red text. Use `role="alert"` and `aria-live="polite"` so screen readers announce them.
- Auto-dismiss in 3.5s (currently 3500ms — keep).
- Position: bottom-right, fixed, max-width 340px.

### Error box (in output panel)

`.err-box` currently uses hardcoded `#fecaca` / `#fef2f2` / `#dc2626`. Must use theme-aware tokens:

```css
.err-box {
  border: 1.5px solid var(--danger);
  background: color-mix(in srgb, var(--danger) 8%, var(--ink-panel-solid));
  color: var(--danger);
}
```

---

## 9. Form patterns

- **Visible labels above inputs** (never placeholder-only — verified at `index.html:42-46`, good).
- **Required marker:** asterisk in `--amber` color.
- **Char counter** in top-right of label using `<span class="char-count">N/MAX</span>`. Switch to `.near-limit` (`--amber`) at ≥ 90%.
- **Inline error** below the input in a `.field-error` element (not just toast). Currently implemented — keep.
- **Submit feedback:** disable button, show loading text. Re-enable on success/error.
- **Helper text:** small `<small>` below input, `var(--ghost)`, no uppercase.

### Anti-patterns

- ❌ Placeholder-only labels.
- ❌ Errors only at the top of the form.
- ❌ Validation on every keystroke (use `blur` + on submit).
- ❌ Disabled fields without visual difference (currently uses `opacity: 0.6` — OK).

---

## 10. Navigation & layout

- **App layout:** `320px` sticky sidebar + fluid workspace, with `gap: 24px`, `max-width: 1600px`. Breaks to single-column below 960px.
- **Below 960px** the sidebar disappears entirely. **HIGH FINDING — needs a drawer/hamburger replacement.** Currently no way to access archive on mobile.
- **Sticky header** at top, `z-index: 10`.
- **Modals** at `z-index: 2000` with `rgba(0,0,0,0.5) + backdrop-filter: blur(2px)` scrim.

### Z-index scale

| Layer | Value |
|-------|-------|
| Ruler decoration | 1 |
| App body | 2 |
| Sticky header | 10 |
| Toast | 1000 |
| Modal | 2000 |

Don't invent values between these layers.

---

## 11. Icons

**Current state:** mix of emoji (🔌 ⚙ ☀️ 🌙 ⭐ 📎 ▶ ✦ ✏ 📥) and unicode glyphs (▸ ＋ ✕ ✓ ✗ ⚠).

### Rule going forward

- Replace **structural** emoji (theme switcher, settings, sign out, connect, upload, generate) with monochrome SVG icons. Recommended set: [Lucide](https://lucide.dev) — matches the clean technical aesthetic.
- Keep **decorative unicode glyphs** (▸ ＋ ✕) — they read as typographic ornaments, not icons.
- **Never use emoji to convey state** (✅ ❌ ⚠️) in functional UI — use color + icon + text.
- Icon size: 16px in inline buttons, 20px in panel actions, 24px in large affordances. All one stroke width (1.5px Lucide default).

---

## 12. Component status (vs. design system)

| Component | Status | Action |
|-----------|--------|--------|
| Auth view | ✅ On-system | None |
| App header | ⚠ Hardcoded white bg in all themes | **Fix:** add `[data-theme="..."]` overrides at `styles.css:711` |
| Form panels | ✅ On-system | None |
| Generate button | ✅ On-system | None |
| Loading state | ❌ Fakes progress + wrong model name | **Replace** per §8 |
| Output rendering | ✅ On-system | Tabular figures missing — add `font-feature-settings: tnum` to `.md table` |
| Error box | ⚠ Hardcoded light-only colors | **Tokenize** per §8 |
| Sidebar archive | ⚠ No delete, no search, no mobile drawer | **Add** per audit H1, H3, H5 |
| Settings modal | ⚠ "Save & Deploy" copy is misleading | **Rename** to "Save" per audit C3 |
| Theme switcher | ✅ Works | Replace emoji with Lucide sun/moon/sparkles |
| Refine modal | ✅ On-system | Disable Generate until textarea has content |
| Doc-mismatch modal | ✅ On-system | None |
| Export dropdown | ❌ Opacity:0 native select hack | **Replace** with proper custom dropdown (M10) |
| Mobile nav | ❌ Archive disappears with no replacement | **Add** hamburger drawer (H3) |

---

## 13. Anti-patterns (forbidden)

These are violations of the system. Code that introduces them must be rejected in review.

- ❌ **Hardcoded hex values** outside `styles.css` `:root` blocks
- ❌ **A fourth font family** (sticks with DM Serif Display + Work Sans + JetBrains Mono)
- ❌ **Fake / misleading progress text** (`"Drafting with claude-sonnet-4"` regardless of active model)
- ❌ **Emoji as functional icon** (use Lucide SVG)
- ❌ **Theme-specific colors that aren't paired** — every `[data-theme="light"]` value needs `[data-theme="dark"]` and `[data-theme="midnight"]` counterparts
- ❌ **`location.reload()` as a UX pattern** — it destroys user state silently
- ❌ **Toast as the only error channel** — pair with inline `field-error` for forms; with `.err-box` for output
- ❌ **Hover-only affordances** — every interactive thing must be reachable via tap and keyboard
- ❌ **Animating `width` / `height` / `top` / `left`** — use transform/opacity
- ❌ **Bottom-of-page CTA without disabled state during async**
- ❌ **Mobile layout that hides core functionality** (current archive-hidden-on-mobile)
- ❌ **`select` overlaid at `opacity: 0` over a visible button** (current Export dropdown hack)

---

## 14. Pre-delivery checklist

Before merging any visual change, verify:

### Themes
- [ ] Tested in light, dark, and midnight themes — all three pass independently
- [ ] No hardcoded hex in the changed CSS — all colors reference tokens
- [ ] Text contrast ≥ 4.5:1 against its actual rendered background in each theme

### Motion & state
- [ ] Animations only on `transform` / `opacity` / `background` / `border` / `box-shadow`
- [ ] `prefers-reduced-motion` respected (or globally handled)
- [ ] Hover state, focus state, disabled state, loading state all distinct
- [ ] Focus ring visible on all interactive elements when keyboard-navigated

### Layout
- [ ] Tested at 375px, 768px, 1280px viewports
- [ ] No horizontal scroll on mobile
- [ ] No core functionality hidden at mobile width without a replacement (drawer / collapse)
- [ ] Long content (200+ char emails, 100-char titles) doesn't break the layout

### Accessibility
- [ ] Every form input has a `<label for="...">`
- [ ] Icon-only buttons have `aria-label`
- [ ] Errors use `role="alert"` or `aria-live="polite"`
- [ ] Tab order matches visual order
- [ ] Touch targets ≥ 44 × 44px

### Honesty
- [ ] No fake progress text
- [ ] Button labels match what they actually do ("Save", not "Save & Deploy" unless it really deploys)
- [ ] Error messages explain cause and recovery, not just "Invalid input"

---

## 15. References

- `CLAUDE.md` §7 — original design-system notes (kept consistent here)
- `styles.css:5-131` — token definitions (single source of truth for colors)
- `index.html:9` — font import
- Audit report (2026-05-19) — 31 findings, top-5 are C1, C3, H1, H2, H4

When this master conflicts with `CLAUDE.md` §7, **this file wins** — it's the more recent and more complete capture. Update `CLAUDE.md` to point here.
