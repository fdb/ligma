# TODO / FEATURE WISHLIST

- Code architecture: all code is now in one lib.rs. Can we start thinking about splitting this up into multiple files? 
- Text spans: per-span font family and size (bold/italic/color shipped); show styling live inside the inline editor overlay
- work more on refining the design: tighten up in some spaces, where you can, make the UI feel nice and usable
- pathfinder ops on 3+ shapes at once and on shapes with holes (pairwise union/subtract/intersect shipped; curves are flattened through the clipper); outline stroke with round joins/caps and open-path support (mitered closed outlines shipped)
- pathfinder operations stay non-destructive: they appear as a group, with the source shapes inside, until flattened
- Double clicking an item in a group should select that item, allowing operations on that (e.g. resizing, editing text, and so on)
- Hold shift while dragging to constrain proportions, e.g. while creating a new shape
- Custom color picker should also have "document colors" - colors that appear on this document, sorted by most frequently used
- If a frame is empty dragging inside of a frame drags the frame. if it has one item, dragging inside of it will create a drag selection rectangle to select items of the frame
- You can also drag the sides of an item to change the width/height, not just the corner points
- Dragging the corner points should also snap to the frame (e.g. to snap the width to the width of the frame)
- If you start typing in a text item, it will still display the previous text, so the two texts will overlap until you press enter or escape

# DONE (things are moved here once they are done)

- Rich text, part 2 — span colors + floating text toolbar: while editing, a toolbar hovers above the text with B/I buttons and color dots that style the current selection (buttons keep the textarea's selection alive); colored runs render on canvas, export as tspan fills, and clear via the white dot

- Radial gradient fills: the fill-type toggle cycles solid → linear → radial (center-out across the node, matching SVG paint server on export)
- Linear gradient fills: toggle any fill between solid and a linear gradient (stop hex inputs + angle in the panel, gradient preview in the swatch); rendered across the node's bounding box on canvas and as an SVG paint server, persisted with the document; picking a flat color reverts to solid

- Frame clipping: children render clipped to their frame's (rounded) bounds, on canvas and in SVG export; clipped-away overhang was already unreachable by clicks

- Rich text, part 1 — bold/italic spans: select text while editing and press ⌘B/⌘I (or use the B/I buttons in the Text panel for the whole node); style runs merge and split cleanly, render with real font variants on canvas, export as SVG tspans, persist with the document, and clamp when the text changes

- Outline stroke (right-click or Object menu): converts a shape's stroke into a filled even-odd ring path (mitered offsets of the closed outline, bevels at spikes); a filled body stays underneath, a stroke-only shape is replaced

- Pathfinder: Union / Subtract / Intersect on two selected shapes (right-click or Object menu) — Greiner-Hormann clipping on the flattened outlines, subject = the lower shape in z; results are multi-contour even-odd paths, so punched holes and split pieces both work, and they stay editable with the path tools

- Flatten (⌘E, also in the right-click and Object menus): merges the selected shapes into one multi-contour path filled under the even-odd rule, so overlaps become holes; rounded rects and ellipses convert to proper bezier arcs
- Frame selection (⌥⌘G): wraps the selection in a new frame sized to its bounding box

- Design polish round: selecting a nested layer auto-expands its ancestors in the outliner (Figma-style reveal); selects (blend, font, export) restyled to match the input chrome with a custom caret; tooltips on the terse X/Y/W/H/O/R/S field labels

- Path editing: dragged anchors snap to the stationary anchors' x/y axes, and control handles snap to anchor axes (easy vertical/horizontal tangents), with the same red guide lines as object snapping

- Bezier path tool, part 2 — node editing: double-click a path to edit; drag anchors (with marquee multi-select and shift-toggle), drag control handles (smooth points keep the mirror handle collinear at its own length, alt breaks the pair), double-click an anchor to toggle corner ↔ smooth, Delete removes selected anchors (the path dissolves under two), Escape exits

- Bezier path tool, part 1 — pen drawing (P): click places corner anchors, click-drag pulls out symmetric handles (smooth anchors), clicking the first anchor closes the path (closed paths get a fill), Enter/Escape/tool-switch commits an open path; paths render with beziers on canvas and in SVG export, hit-test against the actual outline, and move/resize/undo like any node

- Session chat: a floating chat bubble in the editor; messages broadcast live to everyone in the file through the presence room (ephemeral — nothing stored), with an unread badge

- Comments: press C (or the bubble in the toolbar) and click anywhere to pin a comment; pins carry the author's presence color/initial, open to read, and resolve away — synced live to every editor in the file

- Text: font picker with a curated Google Fonts set (stylesheets load lazily; opening a document fetches the fonts it uses)

- Outliner drag-reorganization: drag layer rows to reorder; drop onto a frame/group row to nest inside it (drop zones: above / into / below, with indicators)

- Text: word wrapping to the text box (greedy, against real canvas metrics) with explicit newlines; Enter inserts a newline while editing, Escape commits
- Text: horizontal (left/center/right) and vertical (top/middle/bottom) alignment, honored on canvas, in the inline editor, and in SVG export

- Image uploads: drop a file on the canvas or File > Place image. Assets are content-addressed in R2 (re-uploads dedupe); image nodes move/resize/blend like any layer and export to SVG/PNG

- Multiplayer presence: live named cursors over WebSockets (one presence room per document, hosted by its Durable Object), plus live document sync — when another editor saves, your copy refreshes automatically (unless you have unsaved changes; then last writer wins)
- Blend modes (multiply, screen, overlay, … — all 16 CSS modes) per layer, in canvas rendering and SVG export

- Custom color picker (SV square, hue + opacity sliders, hex input) with an eyedropper that samples pixels already on the canvas; picker drags coalesce into one undo step

- Text: text bug: text shifts around when clicking it to edit on the canvas
- If I draw an object in a frame, it appears in the outliner as belonging to that frame (and stays selectable inside it)
- Cmd-+ Cmd-- to zoom in / zoom out
- If I have multiple shapes I can transform them together (resize handles on the joint bounding box; also resizes groups)
- Right click menu: copy, cut, paste, duplicate, bring to front, send to back, group/ungroup, show/hide, lock/unlock, delete (+ ⌘C/⌘X/⌘V/⌘]/⌘[ shortcuts)

- Option-dragging to copy shapes
- Snapping to other shapes (edges + centers, red guide lines while dragging)
- Renaming a frame by clicking the name on the canvas (double-click the label)
- Editing text on the canvas by double-clicking and just typing
- "Copy as SVG" feature (Edit menu)
- Ligma menu that has all features of the app sorted like a classical Mac app (File/Edit/View/Object)
- Arrange options to align multiple objects or distribute them horizontally/vertically
- Change filename (click the name in the top bar)
- See file name in HTML title attribute and see it change when file name is changed in the doc
