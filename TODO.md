# TODO / FEATURE WISHLIST

- Code architecture: all code is now in one lib.rs. Can we start thinking about splitting this up into multiple files? 
- Text spans: per-span font family and size (bold/italic/color shipped); show styling live inside the inline editor overlay
- work more on refining the design: tighten up in some spaces, where you can, make the UI feel nice and usable
- pathfinder ops on 3+ shapes at once and on shapes with holes (pairwise union/subtract/intersect shipped; curves are flattened through the clipper); outline stroke with round joins/caps and open-path support (mitered closed outlines shipped)
# DONE (things are moved here once they are done)

- Non-destructive booleans: Union/Subtract/Intersect now produce a boolean group with the source shapes alive inside — move or edit a source (deep select / outliner) and the combined outline re-renders live; the group itself carries the fill/stroke, hit-tests against the computed result (holes miss), exports as an even-odd SVG path, ungroups back to the sources, and ⌘E flattens it into a real editable path
- Clicking one node of a multi-selection narrows the selection to it on release (Figma behavior)

- Frame-interior drags: dragging inside an empty frame moves the frame; inside a non-empty one it rubber-bands that frame's children (a plain click still selects the frame, and a selected frame still drags normally)
- Document colors in the color picker: a swatch row of the colors already used in the file (fills, strokes, gradient stops, text spans), most frequent first

- Deep select: double-clicking an item in a group selects that item (one container level per double-click, Figma-style); the deep-selected child can be resized, moved, and panel-edited directly, and double-clicking a grouped text/path once more opens its editor

- Shift constrains drags: squares/circles while drawing, original proportions while resizing from a corner
- The sides of the selection box are grab bands — drag any edge to resize that axis alone (with ns/ew cursors); corners keep working as before
- Resize drags snap the moving edge to nearby edges/centers — most usefully the parent frame's — with the same red guide lines as move snapping

- BUG fix: resizing a frame or group through the panel's W/H fields now scales its contents proportionally about the top-left (handle drags already did); groups gained W/H fields in the panel
- BUG fix: typing in a text item no longer overlaps the previous text — the canvas stops drawing a node while its inline editor is open, even when the node is nested in a frame or group

- Components & instances: ⌥⌘K turns the selection into a component (a frame-like master); "Create instance" places a live instance beside it that renders the master by reference — master edits show up in every instance immediately, instances resize by scaling the mapping, SVG export embeds the transformed master, and a deleted master leaves a placeholder

- Gradient handle on the canvas: selecting a node with a linear gradient shows a spoke from its center; dragging the dot re-aims the gradient live, coalescing into one undo step

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
