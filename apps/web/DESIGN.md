# Design direction — "Columnar pad"

Created in F-11 with the `/frontend-design` skill. Every UI task follows this file (AGENTS.md §5).

## Brief

- **Subject:** an alerting console for a bank's operations teams (Settlements, Pricing, Rates, Payments).
- **Audience:** on-call engineers and ops analysts, often at night, scanning many alerts fast.
- **Primary job:** show what needs attention now and let people act on it (acknowledge, follow the runbook, approve).

## Idea

Back offices of banks ran on the **accountant's columnar pad**: pale green paper, green column rules,
a red margin line, blue ink for entries and red ink for what is wrong. The feed is a ledger of incidents,
so the console borrows that material instead of a generic SaaS dashboard look.

- The **memorable thing** is the ledger margin: a double red rule on the left of the feed where each
  alert gets its severity "ink mark". Everything else stays quiet.
- Rows are ruled lines, not cards. Columns are separated by faint green column rules, like the pad.
- Numbers (times, counts, amounts) always use tabular figures so columns line up.

## Tokens

### Color (light — "Desert Day")

Palette: Desert Sun `#dc9750` + Dark Blue `#1e2640`.

| Name | Hex | Use |
|---|---|---|
| paper | `#F4EAD8` | page background (warm sand) |
| sheet | `#FDF6ED` | surfaces (feed, panels) |
| rule | `#E0C896` | row and column rules, borders |
| ink | `#1E2640` | text (dark blue, never pure black) |
| ink-soft | `#4A5571` | secondary text |
| margin | `#DC9750` | Desert Sun accent: margin rule, focus ring, monogram |

Severity inks (same hue in both themes, lightness adjusted):

| Severity | Light | Dark | Meaning |
|---|---|---|---|
| critical | `#B42318` red | `#FF7A6E` | something is broken now |
| error | `#B5531B` burnt orange | `#F4A26B` | failing, not yet critical |
| warning | `#7A5F00` dark ochre | `#E3C35A` | look soon |
| info | `#1E4A8A` blue | `#8DB7E8` | for the record |

### Color (dark — "Desert Night")

| Name | Hex |
|---|---|
| paper | `#1A2238` |
| sheet | `#1E2640` |
| rule | `#2D3D5C` |
| ink | `#ECD9B8` |
| ink-soft | `#9A8B6A` |
| margin | `#DC9750` |

### Type

- **Atkinson Hyperlegible Next** (variable), one family for everything. Designed for legibility —
  the right choice for reading alerts at 3 a.m. Weights 400 / 600 / 750.
- Scale (1.2 ratio): 12.5 · 14 (body) · 16.8 · 20 · 24 · 28.8 px. Line height 1.45 body, 1.2 headings.
- `font-variant-numeric: tabular-nums` on every number column.
- No all-caps labels, no monospace labels, no eyebrows above headings.

### Layout

```
┌──────┬──────────────────────────────────────────────────────────┐
│ nav  │ Team ▾        search…                   ● Live   ☾  Anna │  top bar (48px)
│ rail │──────────────────────────────────────────────────────────│
│      ║│ time   │ alert                       │ team   │ ×n │ act │  ledger header
│ Alerts║│ 09:14 │ order-settlement failed …   │ Settl. │ 12 │ ACK │  ruled rows (40px)
│ …    ║│ 09:13 │ HighErrorRate payments-api  │ Paym.  │  1 │ ACK │
│      ║│                                                         │
└──────┴──────────────────────────────────────────────────────────┘
        ^ red double margin rule; severity ink mark sits in it
```

- Left-aligned everything. Left nav rail 208px (icons + words), collapses to icons below 900px.
- Content max width none (the feed uses the screen); text blocks max 72ch.
- Radius: 6px for controls (buttons, inputs), 0 for ledger rows, 8px only for panels (tight ledger style), 4px for chips.
- No shadows on rows; one soft shadow only for floating panels and menus.

### Motion

- One orchestrated moment: a **new alert "inks in"** — the row's margin mark draws in and the row
  background flashes the severity ink at 12% and fades over 1.2 s. Nothing else animates on its own.
- Responses to actions: ACK/resolve change the row immediately (optimistic), 150 ms color transition.
- `prefers-reduced-motion`: no ink-in animation, instant state changes.

## Writing

- UI language: Polish (as in the plan). Sentence case. Buttons say what they do: "Potwierdź", "Rozwiąż", "Zaloguj się".
- Status words map 1:1 to the API: Otwarty (open), Potwierdzony (acknowledged), Rozwiązany (resolved).
- Empty feed: "Brak otwartych alertów. Nowe pojawią się tu, gdy tylko przyjdą." — an invitation, not a mood.
- Errors say what happened and what to do: "Nieprawidłowy e-mail lub hasło."

## Review against generic defaults (done before building)

- Considered and rejected: near-black + one neon accent (generic "ops dark mode"); identical rounded
  alert cards with grey shadows (SaaS kit). The ledger rows and red margin come from the bank back-office
  subject, not from a template.
- Risk: ruled rows could drift into the "broadsheet" look. Kept apart by colored green rules, a tinted
  paper surface, rounded controls and no newspaper columns or serif display type.
- Dropped a monospace face for IDs/times (a common tell); tabular figures in the one family do the job.
- Kept dark mode as a real second material ("night shift" green-slate), not inverted colors.

## Role-based UI and plain language (UI simplification, see `implementation_plan.md` in this folder)

- **Three personas** from `lib/roles.ts`: admin (org admin), lead (leads at least one team), member.
  The menu, the home heading, "Pierwsze kroki" and what a screen offers follow the persona;
  `router.tsx` shows `NoAccess` for screens a role does not use. The API still enforces permissions.
- **"Więcej opcji"** (`MoreOptions` in `components/ui.tsx`): settings with a sensible default stay folded;
  the button says how many are inside and how many differ from the default.
- **Numbered questions** only for real sequences (rule: 1–4, new connection: 1–3, instruction steps);
  the numeral sits in the margin in `margin` red, like "Dodaj źródło".
- **Words** come from `lib/labels.ts` (actions, fields) and the glossary in `implementation_plan.md` §6:
  "Instrukcja", not runbook; "Połączone systemy", not źródła; "Nowy rodzaj wiadomości", not schemat.
  Technical paths (`payload.desk`) appear only as a hint under the friendly name.
- **Settings the backend does not read are hidden**, not shown disabled (§7 of the plan).
