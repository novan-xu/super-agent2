# Skeuomorphic material

The page's finish is a subtle skeuomorphic material, approved by the owner on 2026-11-24 after the prototype rounds of tickets AA, AE, AK, AN, AR and AS.
The geometry it must reproduce is recorded in [skeuomorphic-measurements.txt](skeuomorphic-measurements.txt).
The prototype itself, an offline clickable page built from the React components, stays outside the repository.

## Where it lives

- `packages/web/src/styles/material.css` holds the material: its tokens, the paint of every raised, recessed and lit element, the workbench tab treatment, and the focus, hover, press and disabled states.
- It is loaded after `prototype.css` and `page.css`, and its rules are scoped under `:root`, so the finish takes precedence over the flat paint in those two sheets.
- The geometry the material needs (the collapsed sidebar, the logo button, the tab strip, the chat column, the scrollbar gutters and the control heights) is part of `prototype.css` and `page.css` themselves.
- The production palette, the radius tokens (8, 12, 16, pill), spacing, the type scale and `--ctl-h: 40px` are unchanged.

## Lighting

One light, from the top, in both themes.

- **Raised** things (buttons, selected segments, cards, the page sheet) have a face gradient that is lightest at the top, one edge that is lightest at the top and darkest at the bottom, and a short soft shadow that falls straight down.
- Controls are only slightly raised (微凸): a nearly flat face, a thin highlight and a short contact shadow.
- **Recessed** things (fields, tracks, wells, pressed controls) are the inverse: a darker upper edge and one inner shadow under the top edge.
- **Dark mode** also has a sheen under the top edge of raised controls (`--mat-hi`), a thin, barely blurred line about one pixel high.
- **Light mode** has no inner highlight line anywhere, because on a light face a white line just inside a darker edge reads as a second outline.
- In light mode the face gradient carries the light, and shadows use one warm brown ink, `--mat-ink: 96 72 36`, at low opacity.
- Light mode has no glow, halo or bloom of any kind: not on status lights, meters, rings, focus or selected states.
- Nothing in light mode casts a shadow upward or sideways.
- **Lamp-like indicators in light mode** (status lamps, allowance meters, allowance rings) have no lighting at all: each is its plain semantic colour on one pale flat track (`--border`).
- Buttons, fields, cards and the sheet keep their bevel in light mode, and dark mode keeps all of its lighting.

## Bevel language

Every raised control uses the anatomy of the sidebar's current navigation button:

1. **Face**: a vertical gradient over the fill, lightest at the top, painted across the border box.
2. **Edge**: one 1 px edge, faint at the top, medium on the sides and strongest at the bottom, and the only line around the control.
3. **Sheen** (dark only): a thin light just inside the top edge.
4. **Drop**: a short contact shadow over a soft ambient shadow, straight down, about 2 px deep on a control with a faint trace to 4 px.

Recessed things invert it: a dark upper edge, a lighter lower edge, and one inner upper shadow.
Pressed controls switch from raised to recessed with no offset or transform, and their inner shadow is `--mat-sink-press`.
Fields, tracks and wells keep `--mat-sink`.

Controls with a 1 px border carry the edge in `border-color`.
Controls with `border: 0` (`.nav-btn`, `.seg button`, `.conv-tabs a`, `.wb-mobile-tabs button`, `.tab`, `.tray-icon`) carry the same edge as an inset ring (`--mat-ring`), and in dark the sheen sits one pixel lower (`--mat-hi-ring`).
Neither changes any geometry.

## Tokens

| Token | Dark | Light |
| --- | --- | --- |
| `--mat-raised` (control face) | `surface` 89% + white | `surface` 55% + `surface-warm` |
| `--mat-hover` | `surface` 84% + white | `surface` |
| `--mat-down` (pressed face) | `surface` 93% + white | `surface-warm` 70% + `sunk` |
| `--mat-card` | `surface` 96% + white | `surface` |
| `--mat-well` (fields) | `sunk` 88% + black | `sunk` 45% + `surface` |
| `--mat-track` (segment tracks, switch, meter) | `sunk` 88% + black | `sunk` 88% + `surface-warm` |
| `--mat-gradient-control` | white 3% → white 0.6% at 50% → black 4.5% | white 55% → white 22% at 50% → ink 1.5% |
| `--mat-gradient-accent` | white 9% → clear at 55% → black 5% | white 14% → white 3% at 50% → amber ink 3.5% |
| `--mat-hi` / `--mat-hi-accent` (sheen, bordered controls) | `inset 0 1px 1px -0.5px` white 14% / 30% | none |
| `--mat-hi-ring` (sheen, borderless) | `inset 0 2px 1px -1px` white 10% | none |
| `--mat-rim-top / -rim / -rim-bottom` | white 4.5% / black 20% / black 34% | ink 9% / 13.5% / 18.5% |
| `--mat-well-rim-top / -rim / -rim-bottom` | black 42% / black 26% / white 6% | ink 24% / 15% / 9% |
| `--mat-accent-rim-top / -rim / -rim-bottom` | white 8% / black 14% / black 26% | `rgb(176 122 0)` 24%, `rgb(160 108 0)` 30%, `rgb(140 92 0)` 36% |
| `--mat-drop-control` | `0 1px 1.5px -0.5px` black 42%, `0 2px 4px -2px` black 24% | `0 1px 1px` ink 7%, `0 1px 2px -1px` ink 8% |
| `--mat-drop-hover` | `0 1px 2px -0.5px` black 44%, `0 3px 6px -3px` black 26% | `0 1px 1px` ink 8%, `0 2px 3px -1px` ink 10% |
| `--mat-drop-sm` (controls ≤ 32 px) | `0 1px 1px -0.5px` black 40%, `0 1px 3px -2px` black 22% | `0 1px 1px` ink 7%, `0 1px 1px -1px` ink 6% |
| `--mat-drop-accent` | same as control | `0 1px 1px rgb(120 80 0 / .11)`, `0 1px 2px -1px rgb(120 80 0 / .09)`; hover `.12` / `0 2px 3px -1px .12` |
| `--mat-drop-card` | `0 2px 3px -1px` black 52%, `0 8px 18px -8px` black 30% | `0 1px 2px` ink 6%, `0 4px 10px -6px` ink 14% |
| `--mat-card-rim-top / -rim / -rim-bottom` | white 3.5% / none / none | ink 6% / 8% / 12% |
| `--mat-sink` (inner shadow of fields, tracks, wells) | `inset 0 2px 4px -1px` black 60% | `inset 0 1px 2px` ink 13% |
| `--mat-sink-press` (pressed or latched control) | `inset 0 1px 3px -1px` black 42% | `inset 0 1px 1.5px` ink 10% |
| `--mat-gradient-thumb` / `--mat-shadow-thumb` (switch thumb) | white 14% → clear 56% → black 7% / `0 1px 1.5px` black 36%, `0 2px 3px -1px` black 20% | — / ring ink 18%, `0 1px 1px` ink 10%, `0 1px 2px -1px` ink 10% |
| `--mat-shadow-dialog` | `0 4px 8px -2px` black 52%, `0 24px 64px -12px` black 64% | ring ink 7%, `0 4px 10px -2px` ink 10%, `0 20px 40px -14px` ink 20% |
| `--mat-sheet-edge` (page sheet edge) | white 8% | ink 13% |
| `--mat-sheet-edge-solid` (the same edge laid over `--side-bg`, for the active tab's contour and feet) | white 8% over `--side-bg` | ink 13% over `--side-bg` |
| `--mat-focus` (buttons) | `0 0 0 2px` accent 72% + fg | `0 0 0 2px` accent 78% + `#7a4f00` |
| `--mat-focus-field` (fields and composer; the border turns `--mat-focus-ink`) | `0 0 0 1px` focus ink | `0 0 0 1px` focus ink |
| `--focus-ring` (global focus) | production | `0 0 0 2px` accent 78% + `#7a4f00`, for every accent |
| `--mat-folder-drop` (folder tabs below the active tab's top; the logo's top is level with them) | 4 px | 4 px |

Composites: `--mat-shadow-control` = hi + drop; `--mat-shadow-sm` = hi + drop-sm; `--mat-shadow-ring` = ring + hi-ring + drop; `--mat-shadow-ring-sm` = ring + hi-ring + drop-sm; `--mat-shadow-pressed` = sink-press; `--mat-shadow-pressed-ring` = well ring + sink-press; `--mat-shadow-well` = sink; `--mat-shadow-well-ring` = well ring + sink.

## Control heights

| Context | Height |
| --- | --- |
| Default control (`.btn`, `.field`, `select.field`, one-line `textarea.field`, `.icon-btn`) | 40 px |
| `.btn-sm`, segment buttons, `.conv-tabs a` | 32 px |
| A `.btn-sm` that shares a row with a field (`.srow-ctl`, connections, `.drow-review`) | 40 px, the field's height |
| Composer toolbar | 40 px desktop, 36 px below 768 px |
| Track (`.seg`, `.conv-tabs`) | 32 px segments + 3 px padding + 1 px edge |
| `.wb-mobile-tabs` | 36 px segments + 3 px padding + 1 px edge = 44 px |
| Settings → 用量 budget field and button | 32 px |

## Component states

| Component | Rest | Hover | Pressed | Selected / current | Disabled | Focus |
| --- | --- | --- | --- | --- | --- | --- |
| `.btn`, `.icon-btn`, `.conv-pick`, `.mini`, `.trow` | raised face, edge, sheen (dark), drop | `--mat-hover` face, drop-hover | recessed: `--mat-down`, well edge, sink | latch `[aria-pressed=true]`: recessed, accent 12% tint | `--mat-disabled` flat, well side edge, no shadow | `--mat-focus` added to the current shadow |
| `.btn-primary`, `.brand-toggle` | accent face, accent gradient, accent edge, accent drop | `--accent-hover`, accent drop hover | `--accent-active`, inverted accent edge, amber inner shadow | — | production disabled fill | `--mat-focus` |
| `.btn-danger` / `.btn-danger-solid` | danger tint face / danger face with dark edge | deeper tint | recessed | — | as `.btn` | as `.btn` |
| Small controls (`.btn-sm`, `.mini`, `.message-quote`, `.tray-icon`) | as `.btn` with `--mat-drop-sm` | full drop | as `.btn` | — | as `.btn` | as `.btn` |
| `.field`, `select.field`, `textarea.field` | well face, well edge, sink | `--mat-well-hover` | — | `.field--owner`: accent border | `--mat-disabled`, no shadow | border `--mat-focus-ink` + `--mat-focus-field`; invalid keeps the danger border (light: plus a 1 px danger line; dark: a danger halo) |
| `.composer` | surface, card edge, card drop | — | — | — | — | border `--mat-focus-ink`; light adds `--mat-focus-field` |
| `.seg`, `.conv-tabs` (track) | `--mat-track`, well edge, sink | — | — | — | — | — |
| Segment, `.conv-tabs a`, `.wb-mobile-tabs button` | transparent, `--fg-2` | `--mat-well-hover` | well ring + sink | raised piece: `--mat-raised`, `--mat-shadow-ring-sm`, `--fg`; radius = track radius − 3 px | transparent | `--mat-focus` |
| `.nav-btn`, `.rail-item` | transparent | raised face at 45%, no shadow | well ring + sink-press | raised piece, `--mat-shadow-ring`; collapsed sidebar: the same piece, 48 px wide | — | `--mat-focus` |
| Phone `.tabbar` | `--mat-track` with a top well edge | — | well ring + sink | current `.tab`: raised piece, `--mat-shadow-ring-sm`, radius 12, `--meta` text | — | `--mat-focus` |
| Workbench tab, active | `--bg` fill, concave 6 px feet over the neighbours' bottom corners, `--mat-sheet-edge-solid` contour one pixel outside its top and sides, z 2; dark lifts it with `drop-shadow(0 -1px 2px` black 35%`)`, light has no shadow; first tab: no left foot, left side on the sheet edge's column, sheet corner square | — | — | — | — | `--mat-focus` |
| Workbench tab, inactive (folder tab) | face from `--mat-folder-drop` below the tab top to 1 px above its bottom, 8 px top radius, filling its own box edge to edge with its neighbours; light `--side-bg` + 5% ink, dark `--side-bg` + 4.5% white with a 3.5% top sheen; one edge on the top and the left side (light ink 10%, dark white 6%), the last tab also on its right; `--fg-2` text | light + 8.5% ink, dark + 8% white, `--fg` text; the corner piece follows | — | — | — | a 2 px `--mat-focus-ink` line inside its face |
| Cards (`.wcard`, `.wb-card`, `.mcard`, `.panel`, lists) | card fill, card gradient, card edge, card drop | `.wb-card`: card drop + hover drop | `.wb-card`: recessed | `.wb-card[aria-pressed]`: recessed, accent 15% tint; `.wcard--focus`: accent border | — | `--mat-focus` |
| Choices (`.theme-opt`, `.qc-opt`, `.radio`) | raised | hover drop | recessed | recessed, accent 15% tint | flat | `--mat-focus` |
| `.switch` | track + well ring + sink, raised thumb | — | thumb sinks | accent track, accent edge, `--accent-on` thumb | flat | well ring + `--mat-focus` |
| Status lights, dark (`.dot--*`, `.tl-dot`, `.allowance-fill`, ring arcs) | colour core, colour bloom (2 px + 6 px; ring arcs as a 1 px + 3 px drop-shadow filter) | — | — | live: 2.4 s breathe of the bloom, steady with reduced motion | — | collapsed sidebar lamps: a 2 px `--mat-focus-ink` outline 2 px outside the lamp |
| Status lights, light | the plain semantic colour, no specular, edge, gradient, glow or bloom; meter fill and ring arc on a flat `--border` track | — | — | live: 2.4 s breathe of the lamp's opacity (1 → 0.5), steady with reduced motion | — | as dark |
| `.rail` (conversation list) | sunk; dark: inner shadow on its left edge; light: one 1 px ink 8% edge | — | — | — | — | — |
| Dialogs, menus, toasts | card fill, `--mat-shadow-dialog` | — | — | — | — | — |

## Sidebar: the collapsed state is a crop

The collapsed sidebar is the expanded sidebar with its right part cut away.
Nothing that stays visible moves or changes size (desktop, 768 px and wider; the phone layout has no sidebar).

- **Logo**: the logo is the collapse toggle, a 48 px `button.side-toggle.brand-toggle` holding the logo, painted like a primary control, with the app name beside it.
- **Width**: the strip is the left margin (12 px), the 48 px logo column and the same 12 px again up to the sheet's edge line, which is drawn in the sidebar's last, transparent pixel column: `--side-w` is 12 + 48 + 12 + 1 = 73 px.
- **Same geometry as expanded**: side padding 12 px, 24 px gaps, items stretched, the head in one row and the foot's 12 px gap hold in both states.
- Logo, nav icons, the current button's left edge, top, height and 8 px radius, the lamp well's left edge, top, height and 12 px radius, the lamps and the settings icon keep their expanded x, y and size.
- **One centre column**: the 48 px logo column, 12 px from the window's edge and 12 px from the sheet's edge line, is the strip's centre, 36 px from the window's edge.
- Everything the strip shows is centred on that column: the logo, the nav buttons and their icons, the current button, the rings, the lamp well and its two lamps, and the settings button and its icon.
- The expanded sidebar uses the same column, so collapsing moves nothing.
- The column is `--side-col` (48 px) on `.app`, from 768 px.
- **Nav buttons** have an inline start padding of `--side-nav-inset`, (48 − 18) / 2 = 15 px, so the 18 px icon is centred in the 48 px cut button, and 12 px at the end, so the expanded badges keep their place.
- The current button is the same raised piece with its own right edge, so it reads as cut, not redesigned.
- **Badges** in the collapsed sidebar sit on the icon's top right corner: 16 px high, 3 px below the button's top, starting 8 px before the icon's right edge.
- **Allowance**: rings replace the rows and start at the same y as the first provider row; the 40 px rings are 4 px into the column, and a ring's hover card keeps its 10 px from the ring.
- The allowance list in the sidebar has no heading and no refresh button; the providers follow the navigation one group gap (24 px) below it.
- **Lamp well**: the collapsed `.hub-card` is the expanded one cut to 48 px: the same recess, edge, radius, padding and height, with an inline start padding of `--side-lamp-inset`, 48 / 2 − 4 − 1 = 19 px inside its 1 px edge, so the 8 px lamps are centred in it.
- The well renders its own two lamps in both states, stacked vertically, and hides only their labels when collapsed.
- When collapsed, each lamp is a focusable image with the name and state as its label and tooltip, and keyboard focus shows a 2 px focus outline around it.
- **No animation**: the two states switch without a transition.
- **Limit**: the four rings keep clear of the lamp well down to a window about 590 px high; rings cannot scroll without clipping their hover cards, so they are left as they are.

## Logo level with the tab strip

The logo's top edge is level with the tab strip's top edge, the top of the folder tabs.
The sidebar's top padding is `calc(56px - 42px + var(--mat-folder-drop))`, 18 px from the window's top.
The active tab stands 4 px proud of the strip.
The sidebar is the same on every page, so the logo is at 18 px on every page and in both sidebar states, and the sheet's top edge is at 56 px on every page.

## Page sheet on every page

On every page the sidebar and the page header are one ground (`--side-bg`, no sidebar edge, no header rule), and the page body (`.body > .main`) is a raised sheet beside them.
That is the workbench's arrangement, where the tab strip is the header, applied to 对话, 传输, 历史, 记忆, 定时, 设置 and the ticket page.

- The sheet has the `--bg` fill and 16 px corners (`--radius-lg`), so both the top and the bottom corners next to the sidebar are rounded.
- Its edge is `0 0 0 1px var(--mat-sheet-edge)`.
- Its shadow in dark is a `-2px -2px 5px -2px` contact and a `-5px 0 12px -5px` ambient.
- Its shadow in light is `0 2px 8px -2px` ink 10%, so nothing is thrown up or sideways.
- On phones the header (the page title, or the tab strip on the workbench) is on the ground and the sheet below it has the same rounded corners above the tab bar.
- The workbench's sheet has a square top-left corner only while the first tab is active.
- A page that scrolls (`.body > .main:not(.is-fill)`) keeps `scrollbar-gutter: stable`, so with always-visible scrollbars its content does not move sideways when a longer or shorter page or settings section opens.
- From 768 px `.set-nav` sticks at `--space-8`, the page's top padding, so 设置 does not move up and down when its sections change.

## Workbench tab strip

- The strip starts at the sheet's left edge.
- `.wb-tabs-scroll` is a horizontal scroll container, which clips at its padding edge, so from 768 px it starts one pixel further left (margin −1 px, padding +1 px): the first tab's left side can then be painted on the sheet edge's own pixel column, and no tab moves.
- On phones the sheet's edge column is outside the window, so the strip starts at the window's edge and stays inside it.
- Its end padding is `--radius-lg` + 10 px, before the `+` button.
- Tabs stand edge to edge, with no gap and no overlap, and two neighbours share one hairline.
- The tab boxes are the same for every selection, so tab positions do not change when the selection changes on desktop.
- **Active tab**: cut from the sheet, with the `--bg` fill, 6 px concave feet (`--mat-tab-foot`) over the bottom corners of its neighbours, and a contour in `--mat-sheet-edge-solid` one pixel outside its top and sides that runs down into the feet and lands on the sheet edge's row.
- **Inactive tabs**: a face of their own filling their own box, 4 px (`--mat-folder-drop`) lower than the active tab, with an 8 px top radius, flat on the sheet's top edge, which stays visible as their baseline.
- In light their face is a little darker than the ground; in dark it is a little lighter, with a faint top sheen.
- Hover deepens the face.
- **First tab active**: the sheet's top-left corner is square, and the tab's left side runs straight down into the sheet's left edge.
- **First tab inactive**: the sheet's corner is rounded, and the tab's face continues below the strip into the 17 × 17 px square cut by the corner, up to the sheet's curved edge (an inverse fillet drawn by `.top--workbench::before`).
- In both states the left side of tab and sheet is the same straight line, and only the fill changes.
- When the strip is scrolled sideways the corner follows the first tab's state, not the tab under the corner.
- With the `+` button at the strip's right end, the last tab is not flush with the sheet's right edge and has its normal right foot.
- On phones the header's rows sit at its bottom (`row-gap: 0`, `align-content: flex-end`), so the tabs end exactly on the sheet's top edge.
- On phones the active tab is at least 192 px wide so it can show its label, which moves later tabs when the selection changes.
- The workbench's phone switch (`.wb-mobile-tabs`) is a padded track with an 8 px 12 px 0 margin, and its current item is a raised piece.

## Chat column

The message column is exactly the composer's column, in the workbench panel and on 对话.
`.stream-inner` uses `box-sizing: content-box`, so its padding sits outside its `max-width`, and below 768 px its inline padding is 12 px, the composer wrap's.

Both columns are on one horizontal frame, also with always-visible scrollbars.
`.conv-main > .stream` and `.conv-main > .composer-wrap` both have `scrollbar-gutter: stable`; the wrap gets `overflow: hidden` so the gutter applies, and 2 px of top padding so the composer's focus line is not clipped.
With overlay scrollbars neither reserves anything.

A brain bubble's left edge, and its topic label, is the composer's left edge.
An owner bubble's right edge, including its image frame, topic label and action buttons, and a question card's right edge, is the composer's right edge.

## Allowance rings

The rings appear in the collapsed sidebar; the expanded sidebar shows meters.

- **Dark**: the ring is a groove with a half-round section, cut into the sidebar between r 13 and r 19 of the 40-unit viewBox and lit from the top, drawn as twenty-four 0.25-unit bands over the ring (`.allowance-ring-wrap::after`).
- The inner wall's light and shade are kept at 60%, so the centre reads level with the surface, not raised.
- **Dark, the arc**: the progress arc is a lamp lying in the channel: the SVG is above the groove and the arc glows like the meter fills, `drop-shadow(0 0 1px <colour>) drop-shadow(0 0 3px <colour 54%>)`.
- **Light**: no groove and no lighting: a pale flat track (`--border`) and the plain semantic arc, like the meters.
- The centre is the sidebar surface itself, with the letter printed on it.

## Height and alignment

1. `textarea.field` uses 8 px block padding, so a one-line textarea is 40 px like its neighbours.
2. A `.btn-sm` beside a field in the same row takes `--ctl-h`.
3. The steer reply's textarea and attach button use `--ctl-h`.
4. `.add-machine .seg button` is 32 px, so the system switch is 40 px like the machine name field.
5. The composer toolbar's buttons and destination select are 40 px, and 36 px below 768 px.
6. Settings → 用量: the budget form uses `.field` and `.btn .btn-sm`, both 32 px high, with the field at its natural width beside its label.
