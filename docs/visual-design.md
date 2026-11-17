# RAVAN visual direction

**RAVAN. Every Story Flows.** The display wordmark uses **RAVĀN**. A private picture house: deep blue-green black, warm ivory, restrained copper accents, cinematic photographic compositions, Cormorant Garamond display typography and DM Sans interface text. Fonts and images are bundled locally.

The library opens with a full-width film still, readable text scrims, one primary action and a compact resume shortcut. The collection uses original photographic sample posters with live typography. Film details borrow the selected artwork as a quiet backdrop. The Google setup screen has a sunlit architectural illustration. TV shares the identity with generous type and a highly visible remote-focus ring.

Original generated artworks illustrate only the labelled fictional preview library. Real entries use their own safe local artwork URL or a geometric fallback. Counts, years, availability and saved position come from the catalogue; no invented ratings or runtimes. The existing backend project identifiers and deployment variables retain their technical names.

Six generated source images become eight WebP derivatives: six 480 px posters and two responsive coastal hero sizes. Together these exports are 373,430 bytes. The hero loads eagerly with selective high priority; posters load lazily with reserved dimensions. A failed asset reveals a readable fallback. No external image host, autoplay video, continuous motion or third-party tracking was introduced.

Controls remain semantic links/buttons with visible focus. Motion is brief and suppressed under reduced motion. Mobile has its own hero crop, stacked collection and compact navigation. The LG C1 build targets Chromium 79 and retains explicit dimensions for its posters. Physical hardware acceptance remains open.

**Loading and motion (15 November 2026).** Every wait uses one motif: the copper line that sits over the A in the wordmark, which is also the line in the favicon. It carries a slow current when the length of a wait is unknown and fills only to a percentage the server reported. Placeholders stand in the final layout and breathe once per group. A screen is never held back for an animation, a fast answer shows no placeholder at all, and only `opacity` and `transform` move. Both the system's reduced-motion setting and the owner's saved preference still everything. A film without artwork gets a typographic poster from one family (six deep tones, ivory title, the copper line) in place of the earlier geometric fallbacks. Preparation screens show the step and percentage the server sends and nothing else: no time remaining, no speed. The components are in `packages/ui/src/Loading.tsx` and `loading.css`; the reasoning and measurements are in the maintainer's frontend audit.

See [design and current documentation](frontend-redesign-2026-11-15.md), [asset prompts and provenance](design-art-manifest.json), and [verification](testing/ravan-redesign-2026-11-15.md).
