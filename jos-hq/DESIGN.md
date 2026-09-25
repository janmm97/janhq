---
name: J/OS HQ
description: A darkroom bench for one operator; every task is a print moving through six stations, printed in black and white under one amber safelight.
colors:
  ground: "#0b0b0b"
  room: "#121212"
  tray: "#1a1a1a"
  rim: "#2a2a2a"
  rim-strong: "#4a4a4a"
  gray: "#6a6a6a"
  silver: "#9a9a9a"
  silver-hi: "#c4c4c4"
  fixed: "#d9d9d9"
  paper: "#f2f2f2"
  safe: "#ffb000"
  safe-lit: "#ffc233"
  on-safe: "#0b0b0b"
  fog: "#f16464"
  strip-1: "#f2f2f2"
  strip-2: "#c4c4c4"
  strip-3: "#8a8a8a"
  strip-4: "#3a3a3a"
  strip-5: "#222222"
  strip-6: "#141414"
typography:
  display:
    fontFamily: "JetBrains Mono Variable, ui-monospace, Cascadia Mono, Consolas, monospace"
    fontSize: "38px"
    fontWeight: 200
    lineHeight: 1
    letterSpacing: "-0.02em"
    fontFeature: "\"tnum\""
  wordmark:
    fontFamily: "JetBrains Mono Variable, ui-monospace, Cascadia Mono, Consolas, monospace"
    fontSize: "20px"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "-0.02em"
  wordmark-compact:
    fontFamily: "JetBrains Mono Variable, ui-monospace, Cascadia Mono, Consolas, monospace"
    fontSize: "16px"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "-0.02em"
  timer-sm:
    fontFamily: "JetBrains Mono Variable, ui-monospace, Cascadia Mono, Consolas, monospace"
    fontSize: "20px"
    fontWeight: 200
    lineHeight: 1
    fontFeature: "\"tnum\""
  circle-value:
    fontFamily: "JetBrains Mono Variable, ui-monospace, Cascadia Mono, Consolas, monospace"
    fontSize: "22px"
    fontWeight: 200
    lineHeight: 1
    fontFeature: "\"tnum\""
  circle-value-long:
    fontFamily: "JetBrains Mono Variable, ui-monospace, Cascadia Mono, Consolas, monospace"
    fontSize: "16px"
    fontWeight: 200
    lineHeight: 1
    fontFeature: "\"tnum\""
  empty-heading:
    fontFamily: "JetBrains Mono Variable, ui-monospace, Cascadia Mono, Consolas, monospace"
    fontSize: "26px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "JetBrains Mono Variable, ui-monospace, Cascadia Mono, Consolas, monospace"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.02em"
  title:
    fontFamily: "JetBrains Mono Variable, ui-monospace, Cascadia Mono, Consolas, monospace"
    fontSize: "15px"
    fontWeight: 700
    lineHeight: 1.4
  body:
    fontFamily: "JetBrains Mono Variable, ui-monospace, Cascadia Mono, Consolas, monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
    fontFeature: "\"tnum\""
  body-row:
    fontFamily: "JetBrains Mono Variable, ui-monospace, Cascadia Mono, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
  body-field:
    fontFamily: "JetBrains Mono Variable, ui-monospace, Cascadia Mono, Consolas, monospace"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.55
  body-dense:
    fontFamily: "JetBrains Mono Variable, ui-monospace, Cascadia Mono, Consolas, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.55
  meta:
    fontFamily: "JetBrains Mono Variable, ui-monospace, Cascadia Mono, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  button:
    fontFamily: "JetBrains Mono Variable, ui-monospace, Cascadia Mono, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.08em"
  label:
    fontFamily: "JetBrains Mono Variable, ui-monospace, Cascadia Mono, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "0.16em"
  mark:
    fontFamily: "JetBrains Mono Variable, ui-monospace, Cascadia Mono, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.12em"
  station:
    fontFamily: "JetBrains Mono Variable, ui-monospace, Cascadia Mono, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 800
    lineHeight: 1.25
    letterSpacing: "0.08em"
  code:
    fontFamily: "JetBrains Mono Variable, ui-monospace, Cascadia Mono, Consolas, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.55
rounded:
  square: "1px"
  mark: "3px"
  control: "4px"
  card: "6px"
  dialog: "8px"
spacing:
  hair: "2px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  2xl: "24px"
  3xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.safe}"
    textColor: "{colors.on-safe}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "40px"
  button-primary-hover:
    backgroundColor: "{colors.safe-lit}"
    textColor: "{colors.on-safe}"
  button-secondary:
    textColor: "{colors.silver-hi}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "40px"
  button-secondary-hover:
    textColor: "{colors.paper}"
  button-ghost:
    textColor: "{colors.silver}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "40px"
  button-ghost-hover:
    backgroundColor: "{colors.tray}"
    textColor: "{colors.paper}"
  button-danger:
    textColor: "{colors.fog}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "40px"
  button-sm:
    padding: "0 12px"
    height: "32px"
  button-disabled:
    textColor: "{colors.gray}"
  mark-needs-you:
    backgroundColor: "{colors.safe}"
    textColor: "{colors.on-safe}"
    typography: "{typography.mark}"
    rounded: "{rounded.mark}"
    padding: "0 8px"
    height: "24px"
  mark-verified:
    backgroundColor: "{colors.fixed}"
    textColor: "{colors.ground}"
    typography: "{typography.mark}"
    rounded: "{rounded.mark}"
    padding: "0 8px"
    height: "24px"
  mark-running:
    textColor: "{colors.paper}"
    typography: "{typography.mark}"
    rounded: "{rounded.mark}"
    padding: "0 8px"
    height: "24px"
  mark-failed:
    textColor: "{colors.fog}"
    typography: "{typography.mark}"
    rounded: "{rounded.mark}"
    padding: "0 8px"
    height: "24px"
  mark-preview:
    textColor: "{colors.paper}"
    typography: "{typography.mark}"
    rounded: "{rounded.mark}"
    padding: "0 8px"
    height: "24px"
  chip-needs-you:
    backgroundColor: "{colors.safe}"
    textColor: "{colors.on-safe}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "36px"
  chip-needs-you-hover:
    backgroundColor: "{colors.safe-lit}"
  chip-needs-you-compact:
    padding: "0 10px"
    height: "36px"
  tag:
    textColor: "{colors.silver-hi}"
    typography: "{typography.meta}"
    rounded: "{rounded.mark}"
    padding: "1px 6px"
  panel:
    backgroundColor: "{colors.room}"
    rounded: "{rounded.card}"
    padding: "16px"
  panel-header:
    textColor: "{colors.silver-hi}"
    typography: "{typography.label}"
    padding: "12px 16px"
  glance-band:
    backgroundColor: "{colors.room}"
    rounded: "{rounded.card}"
    padding: "16px"
  circle-stat:
    textColor: "{colors.paper}"
    typography: "{typography.circle-value}"
    size: "88px"
  circle-stat-long:
    typography: "{typography.circle-value-long}"
  circle-stat-label:
    textColor: "{colors.silver-hi}"
    typography: "{typography.label}"
  input:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.paper}"
    typography: "{typography.body-field}"
    rounded: "{rounded.control}"
    padding: "0 12px"
  input-search:
    backgroundColor: "{colors.room}"
    textColor: "{colors.paper}"
    typography: "{typography.body-row}"
    rounded: "{rounded.control}"
    padding: "0 12px 0 36px"
    height: "36px"
  nav-item:
    textColor: "{colors.silver-hi}"
    typography: "{typography.body-row}"
    rounded: "{rounded.control}"
    padding: "8px 10px"
  nav-item-active:
    backgroundColor: "{colors.tray}"
    textColor: "{colors.paper}"
  tab-active:
    backgroundColor: "{colors.tray}"
    textColor: "{colors.paper}"
    rounded: "{rounded.mark}"
    padding: "4px 10px"
  dialog:
    backgroundColor: "{colors.room}"
    rounded: "{rounded.dialog}"
    padding: "16px 20px"
---

# Design System: J/OS HQ

## Overview

**Creative North Star: "Darkroom Stations"**

HQ is a darkroom bench, not a dashboard. Every task is a print that moves through six fixed stations (Compose, Test strip, Expose, Develop, Fix, Dry), and nothing is exposed until the operator says so. The room is printed in black and white: a dense black ground, room and tray greys for surfaces, silver and fibre-white for ink, a stepped black-to-white test strip as the one graphic device, and a faint pool of enlarger light at the head of each page. One amber safelight burns only where the operator acts. Fog red is kept for failure.

The density is an expert's. One operator works here for long stretches, often at night, beside dark editors, so the surfaces are quiet, the type is one monospace family throughout, and state always reads from shape (outline, dash, fill, strike) before it reads from colour. Numbers come as lines of readout text, not tiles or rings, with one recorded exception: the "At a glance" band at the top of J1 Dashboard, where the operator asked for circle graphs on 2026-09-24. Surfaces sit on hairline rims and never nest.

The build rejects the category's card grid of KPI rings, glowing accents and colour-coded status pills; J1's one band of greyscale rings, on a single surface and without the safelight, is the only place a ring appears. Motion is short and functional. The system has two authored moments: a finished result develops in from a grey ghost, and an approved payload takes the safelight briefly as it is exposed.

**Key Characteristics:**
- Greyscale world, one amber safelight, one failure red.
- JetBrains Mono is the only typeface, with tabular numerals everywhere.
- State is carried by outline, dash, fill and strike-through, so it reads without colour.
- Hairline rims (1px) on flat surfaces that never nest.
- The six-station test strip is the signature: stepped white-to-black bands.
- 200 ms ease-out-expo transitions; a 900 ms develop reveal and a 200 ms expose flash; nothing pulses.

## Colors

A black-and-white print palette with one warm light source and one failure tint, both reserved.

### Primary
- **Safelight Amber** (`safe`): the only accent. It marks exactly four things: the primary action (Approve · expose, Answer, Reconcile, Send, New agent's submit), anything that "needs you" (the top-bar chip, the Needs-you mark, a lit bay or card rim), the focus ring and caret, and the station where the operator is acting (the waiting station on a task's strip, the current step in the agent form). Hover lifts it to **Safelight Lit** (`safe-lit`), its own token in the stylesheet. Text on it is always **On-safe Black** (`on-safe`).

### Secondary
- **Fog Red** (`fog`): failure only: Failed and Blocked marks and squares, the failed station on a strip, a blocked bay rim (at 60% opacity), the danger button and error notes. The build moved it from the spec's #E5484D to this lighter value because the spec value failed contrast on the tray surface.

### Neutral
- **Ground Black** (`ground`): the page, top bar, sidebar, input wells and the tab rail.
- **Room Grey** (`room`): every surface: panels, bays, cards, menus, dialogs, the composer.
- **Tray Grey** (`tray`): hover and selected fills inside a surface; active nav item; active tab; the un-toned station band.
- **Rim** (`rim`): the 1px hairline on every surface and divider.
- **Strong Rim** (`rim-strong`): control outlines (secondary buttons, menus, tags), dashed empty states, dialog and menu edges, scrollbar thumbs.
- **Gray** (`gray`): disabled text only.
- **Silver** (`silver`): secondary ink: descriptions, meta, labels, placeholders.
- **High Silver** (`silver-hi`): control text, section labels, tags, settled states (Planned, Verified in dense rows).
- **Fixed** (`fixed`): the filled Verified mark: a print that has been fixed.
- **Fibre White** (`paper`): primary ink, headings, values, the running outline, text selection.
- **Test strip 1-6** (`strip-1` to `strip-6`): the six stepped bands a station takes when it is done, fibre white to dense black, in station order. Strip 1-5 also draw the Preview mark's underline.

### Named Rules
**The One Safelight Rule.** Amber marks only a primary action, "needs you", the focus ring and the station where the operator acts. If it marks anything else, it is wrong. One and Studio are told apart by name, never by colour.

**The Fog Is Failure Rule.** Red appears only for failure, blocking and destructive actions. Warnings and unverified states stay greyscale and use a dashed outline instead.

**The Colourless State Rule.** Every state must read with colour removed: fill for settled or waiting, solid outline for running or planned, dashed outline for in line or unverified, strike-through for failed.

## Typography

**Display Font:** JetBrains Mono Variable (with ui-monospace, Cascadia Mono, Consolas, monospace)
**Body Font:** JetBrains Mono Variable
**Label/Mono Font:** JetBrains Mono Variable

**Character:** A single monospace family carries every role, varied only by weight, size, case and tracking. It reads as instrument labelling on a darkroom timer: extralight for the big clock, bold tracked capitals for labels and marks, plain weight for everything the operator reads.

### Hierarchy
- **Display** (200, 38px, line-height 1, -0.02em): the Elapsed timer on a running print.
- **Small timer** (200, 20px, line-height 1): the small Elapsed timer and the "Took" span of a finished task.
- **Circle value** (200, 22px, line-height 1, tabular): the number in the centre of a J1 "At a glance" circle, in fibre white. A centre longer than 5 characters (a sub-cent cost such as $0.0034) steps down to 16px so it stays inside the ring.
- **Empty-state heading** (700, 26px, -0.02em): the one heading of an empty chat ("Give J/OS a Tasks"); the largest text in the product after the timer.
- **Wordmark** (800, 20px, line-height 1, -0.02em): "J/OS" at the head of the sidebar, followed by "HQ" as an 11px tracked label. In the chat header the wordmark is compact (800, 16px) and hidden below 640px.
- **Headline** (700, 22px, -0.02em): the page title, preceded by its J-code (J1-J4) at 13px bold in silver.
- **Title** (700, 15px): a bay's workspace name, a holder print's title, drawer titles. Dialog titles are 14px bold.
- **Body** (400, 14px, 1.55): the base size. Rows and navigation use 13px; text fields and empty-state titles use 13.5px; dense rows, status words, readouts and payload blocks use 12.5px; descriptions and meta use 12px. Prose is held to 64-76ch.
- **Button** (600, 12px, uppercase, 0.08em).
- **Label** (700, 11px, uppercase, 0.16em): section and panel headings, the Chats heading, Line. Field labels over values (Route, Mode, Elapsed) use 0.14em.
- **Mark** (700, 11px, uppercase, 0.12em): the state word on a print.
- **Station** (800, 11px, uppercase, 0.08em): the station name in a test-strip band.

### Named Rules
**The One Family Rule.** JetBrains Mono is the only typeface. No second family for display or body.

**The Twelve-Pixel Floor Rule.** Running text is never below 12px. Only tracked uppercase labels, marks and station names go to 11px, and never below it.

**The Tabular Rule.** Numerals are tabular everywhere (set on the body), so times, costs and counts line up in rows.

## Layout

A fixed 264px sidebar on the ground with a 1px rim on its right edge, a sticky top bar (at least 56px tall) and a main column capped at 1600px, padded 16px (32px from 1024px up) and 24px top and bottom. Below 1024px the sidebar becomes a drawer over a 70% black scrim. Below 640px the global search takes its own row so the top bar never widens the page.

The rhythm is a 4px base: 8px inside controls, 12px between related items, 16px inside surfaces and between surfaces, 24px between page sections. Page headers sit 24px above their content.

The Dashboard opens with the "At a glance" band, 24px above the bench: one room surface holding a Tasks group and an Agents group, stacked with a hairline between them and 16px either side of it, then side by side from 1280px at 4fr:3fr with a vertical hairline between and 32px either side. Tasks sets its four circles 2 by 2 below 640px and 4 across from 640px; Agents sets its three circles 3 across at every width. Circles sit 12px apart across and 20px apart down. The Dashboard bench is two bays side by side from 1024px (One and Studio), then the drying line with a 360px rail beside it from 1280px. Agents pairs its list with a 440px detail column from 1280px. The test strip is a container query: six across once its own box reaches the container `md` width, three by two below it, and two-word labels wrap rather than truncate.

A list that scrolls inside a panel fades into the panel at its bottom edge (up to 28px) while more sits below, and shows its last row whole at the end. The fade is a mask: its gradient runs from `#000` to transparent, and in a mask only the alpha counts, so `#000` means "fully shown", not black. It is not a colour and draws nothing, so it is not in the palette.

The enlarger light is a radial pool of neutral grey at the top centre of the main column (from #1b1b1b through #161616 to the ground by 85%). It lights the page head; surfaces sit on top of it.

## Elevation & Depth

Depth is tonal first: ground, then room, then tray, each separated by a 1px rim. Shadows exist but are low and dark, never glows; they sit a surface slightly above the ground rather than lift it. Overlays (menus, search results, dialogs, the health drawer) carry deeper shadows and a strong rim. Inset rings, not shadows, mark state inside a surface: the active tab and the stations on a test strip.

### Shadow Vocabulary
- **Surface rest** (`box-shadow: 0 16px 30px -22px rgba(0,0,0,0.95)`): panels and bays on the page.
- **Composer** (`box-shadow: 0 20px 50px -24px rgba(0,0,0,0.95)`): the chat composer.
- **Popover** (`box-shadow: 0 18px 40px -12px rgba(0,0,0,0.85)`): menus and search results.
- **Dialog** (`box-shadow: 0 30px 80px -20px rgba(0,0,0,0.9)`): modals over a 70% black scrim.
- **Drawer** (`box-shadow: -30px 0 60px -30px rgba(0,0,0,0.9)`): the runtime health drawer.
- **Station ring** (`box-shadow: inset 0 0 0 2px <colour>`): paper for the current station, safe for waiting, fog for failed, strong rim for stopped.

### Named Rules
**The No-Nesting Rule.** Surfaces never nest. Inside a panel, use rows, hairline dividers and dashed empty states, never another panel.

**The No-Glow Rule.** Shadows are dark and falling. Nothing glows, and the safelight is never a shadow except in the 200 ms expose flash.

## Shapes

Small, nearly square corners throughout: 1px on status squares, 3px on marks, tags and tab buttons, 4px on controls, 6px on surfaces, 8px on dialogs only. Borders are 1px hairlines; state changes the stroke rather than the shape: solid, dashed, filled or struck through. Focus is a 2px safelight outline at a 3px offset with a 3px radius. The test strip is a single 3px-cornered band clipped into six cells.

## Components

### Buttons
Tracked uppercase labels on nearly square controls; confident and quiet until one of them is the action.
- **Shape:** 4px corners, 1px border; 40px tall (32px small), 16px sides (12px small).
- **Primary:** safelight fill and border, black text; hover to the lit amber. Only the action the operator is being asked to take.
- **Secondary (default):** transparent with a strong rim and high-silver text; hover to a silver rim and white text.
- **Ghost:** no border, silver text; hover fills with tray.
- **Danger:** a fog rim at 60% and fog text; hover adds a 10% fog fill (Reject, Stop, Delete).
- **Disabled:** rim border, no fill, gray text, not-allowed cursor.
- **Transitions:** colours only, 200 ms ease-out-expo; switched off under reduced motion.

### Marks and status squares
A state is HQ's word in the state's shape. Marks (24px tall, 3px corners, 11px bold tracked caps) sit on prints and rows; a 7px square with 1px corners plus the word stands in for dense rows and the sidebar.
- **Needs you:** safelight fill, black text.
- **Verified / Planned / Done (fixed):** fixed-grey fill, black text.
- **Running / Verifying:** fibre-white outline.
- **Planning (and any unlisted word, such as Idle or Ready):** silver outline, high-silver text.
- **In line:** dashed silver outline.
- **Unverified:** dashed fibre-white outline.
- **Failed / Blocked:** fog outline and fog text, struck through (1px).
- **Cancelled / Rejected:** strong-rim outline, silver text.
- **Preview:** a high-silver outline with a 2px five-step strip (strip 1-5) along its bottom edge; shown while a PREVIEW run is running.

### Needs-you chip
The safelight chip in the top bar whenever anything waits on the operator: a 36px safelight control with a 7px black square, "Needs you · n" in 12px bold caps at 0.1em, lifting to the lit amber on hover; it opens the oldest waiting item. In the chat header it has a compact form: below 640px it drops the words and reads "· n" with the square, and its sides tighten from 12px to 10px.

### Test strip (signature)
The six stations as one band. A station that is done takes its step of the strip, fibre white at Compose to dense black at Dry. A station not yet toned is drawn on the tray with an inset ring: fibre white for the current station, safelight for waiting on the operator, fog for failed, strong rim for stopped; a station not reached or skipped is a dashed outline. Each band carries its name and, below it, its role or state (`route · plan`, `now`, `waiting for you`, `failed here`).

### Cards / Containers
- **Corner Style:** 6px.
- **Background:** room grey on the ground.
- **Shadow Strategy:** surface rest (see Elevation & Depth).
- **Border:** 1px rim; safelight when it holds something that needs the operator (a lit bay, a pending Expose card, a clarify or reconcile card); fog at 60% when blocked.
- **Internal Padding:** 16px; header 12px by 16px over a rim divider, titled with an 11px tracked label.
- **Section heads** on the ground are the same label over a hairline, with no box.
- **Empty states:** a dashed strong-rim box, a 13.5px semibold sentence and a silver line of explanation.

### Inputs / Fields
- **Style:** ground well, 1px rim, 4px corners, 13-13.5px paper text, silver placeholder, safelight caret.
- **Answer box:** a task with no chat answers its question on the task page: an 11px tracked "Your answer" label, a three-row ground-well textarea (13.5px, up to 76ch) and a small primary Send answer button, with an error note beneath.
- **Focus:** the global 2px safelight outline; the search field also shifts its rim to silver; the composer, whose textarea hides its own outline, turns its whole rim to the safelight.
- **Menus:** a 32px strong-rim trigger with a chevron; the list is a room surface with a popover shadow; the active option fills with tray and the selected one carries a small paper square.

### Navigation
The sidebar is a list of J-coded items (J1 Dashboard, J2 Agents, J3 Connections, J4 Workflows) at 13px, the code in an 11px bold silver column. The active item sits in a tray fill with a rim border; hover fills with tray. Workspace sub-items under Agents carry a 5px paper square when current. Chats list beneath an 11px tracked "Chats" heading, each with its route and state square. Below 1024px the sidebar opens as a drawer from a menu button. Tabs are a ground rail with a 1px rim; the active tab takes a tray fill and an inset strong-rim ring; arrow keys move between them.

### At a glance circles (J1 only)
The operator's circle graphs at the top of the Dashboard, replacing J1's one-line readout: a ring, its centre number and a label, nothing more. It is the only ring in HQ.
- **Ring:** an 88px square box; a 4px track in rim grey on a circle of radius 42, leaving an 80px well for the centre. The arc is the same 4px stroke, drawn clockwise from 12 o'clock with butt caps, its length the share value / of. With nothing to show (no total, or a zero share) there is no arc, only the track.
- **Arc tones:** fixed, fog, paper, silver or high silver; never the safelight, so the band carries no amber. Completed is fixed; In line is high silver, measured against the work open now rather than the range; Failed is fog; Abandoned is silver. Agents created and Running are paper; Avg cost is high silver, its arc the share of agent tasks that reported a cost and its centre the average in dollars, reading "$0.00" (with no arc) when no agent task reported a cost.
- **Centre:** the circle value in fibre white, one line, centred in the well.
- **Label:** under the ring, 12px below, an 11px bold uppercase label at 0.16em in high silver (Completed, In line, Failed, Abandoned; Agents created, Running, Avg cost). Nothing sits under the label: the band has no caption line, at the operator's request of 2026-09-24.
- **Group heads:** each group is titled with the 11px tracked label, 16px above its circles: `Tasks · today` (or `in 7 days`, `in 30 days`, following the range) and `Agents`.
- **Loading and failed:** until the Dashboard answers, and when its load failed, the whole frame stands: the band, both heads, every label and ring track, with no arc and a "—" in each centre. The two states look the same in the band; the page's error note says which it is.
- **Accessibility:** each circle is a figure whose aria-label carries the label, value and denominator (`Completed: 26 of 35`), or the centre text where the centre is not a count (`Avg cost: $0.00`, `Completed: —` while loading). There is no aria-describedby, since there is no caption line. The SVG is hidden from assistive technology. The band is a section labelled "At a glance".

**The One Band Rule.** Rings and gauges appear only in the J1 "At a glance" band, the operator's recorded exception of 2026-09-24. Every other number in HQ stays a readout line, and the band never takes the safelight.

### Readout and Timer
Outside the J1 "At a glance" band, numbers are sentences, not tiles: `34 tasks · 19 verified · 0 waiting on you`, values in bold paper, labels in silver, separated by middle dots. A running print shows an Elapsed label over an extralight 38px timer (mm:ss, h:mm:ss past an hour).

### The develop reveal and the expose flash
A result that has just arrived develops in once over 900 ms (from 12% opacity, blurred and flat, through 85% at 60%, to full contrast); one already on the page when it loads is shown dry. Approving an Expose card flashes an 18% safelight wash across it that fades out over 200 ms. Both are off under reduced motion, and every transition is removed there too.

## Do's and Don'ts

### Do:
- **Do** keep the safelight for a primary action, "needs you", the focus ring and the station where the operator acts; everything else is greyscale.
- **Do** make every state readable without colour: fill, outline, dash, or strike-through, always with HQ's word beside it.
- **Do** strike through failed marks; leave the agent Limits "never" verdicts unstruck, since "never" is a setting, not a failure.
- **Do** show a running PREVIEW with the Preview mark: a high-silver outline with the 2px five-step strip underline.
- **Do** set every surface on a 1px rim in room grey, with 16px padding and 6px corners, and put rows, not panels, inside it.
- **Do** use JetBrains Mono alone, text at 12px or larger, and 11px only for tracked uppercase labels.
- **Do** keep large sizes to their roles: 38px and 20px extralight for timers, 22px (16px when long) extralight for a circle's centre, 26px for the empty-chat heading, 22px for page titles, 20px and 16px extrabold for the wordmark.
- **Do** write numbers as a readout line with middle dots everywhere except the J1 "At a glance" band, whose circles are the operator's recorded exception.
- **Do** keep transitions to colour changes at 200 ms ease-out-expo, and turn all motion off under reduced motion.

### Don't:
- **Don't** add a second accent or tell One and Studio apart by colour.
- **Don't** use fog red for warnings, unverified results or emphasis; it is failure only.
- **Don't** pulse, spin or loop anything; the develop reveal runs once, on a fresh result.
- **Don't** nest a panel inside a panel.
- **Don't** build stat tiles, KPI rings or gauges outside the J1 "At a glance" band; use a readout line.
- **Don't** put the safelight in the "At a glance" band; its arcs are fixed, fog, paper, silver and high silver only.
- **Don't** use glows or coloured shadows; the only coloured light is the 200 ms expose flash.
- **Don't** set text below 12px, or tracked labels below 11px.
