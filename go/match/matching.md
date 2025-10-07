# Matching pixels, and the rules to do so

Hello there! If you're reading this, you're probably a developer. And one who is stalking my WPlace scripts at that. You are a unique kind of fucked up.

This is my plan for writing and implementing rules to search for and match pixels. I am doing this because of my other work in WPlace archiving, both to help the community find lost art, and for possible moderation capabilities.

## The plan

I need to write both strict and vague rules that match pixel patterns. At the simple end, think finding a light green letter H. At the complex end, think locating the coordinates of art given only a screenshot by scanning the million filled tiles.

Rules operate in **palette index space**, not RGB.

There are two matcher types:

- **Specific** - exact 2D templates with wildcards and negation
- **Vague** - 1D colour run patterns along rows or columns, followed by neighbour grouping to enforce widths or heights

Both are defined in a human friendly YAML with a canonical JSON form.

## Shared semantics

- **Transparent** - `T` means alpha 0 after palette read. If you need near transparent, define a pre-quantisation threshold in your ingest step, not in rules.
- **Required colours prefilter** - optional `required_colours` is a list of palette indices or colour names. If a tile lacks any of them, skip scanning for speed.
- **Stop after hit** - by default, stop scanning a tile after the first hit per rule. You can configure `max_matches_per_tile` per rule if needed.

## Specific - 2D templates

Exact pixel layouts with tokens. The engine slides the grid over the image.

### Tokens

- `#RRGGBB`, `rrggbb`, or named colour like `lightgreen` - literal colour
- `.` - any colour
- `!{…}` - not in set, example `!{87ff5e, b2d8d8, T}`
- `<>` and `=` - capture and reuse a colour, example `<a: 004d24>` then `=<a>` later in the grid
- `T`, `t`, `transparent` - transparent

### Metadata

- `anchor` - `top-left | centroid | first-nontransparent` for reporting the match anchor
- `stride` - slide step size in pixels, default 1
- `palette` - optional palette name, example `wplace`

### Example - green H 3x5

```yaml
@template name: "H_3x5"
anchor: top-left
stride: 1
palette: wplace
grid:
  [ 87ff5e, .,        87ff5e ]
  [ 87ff5e, .,        87ff5e ]
  [ 87ff5e, 87ff5e,   87ff5e ]
  [ 87ff5e, .,        87ff5e ]
  [ 87ff5e, .,        87ff5e ]
```

Canonical JSON:

```json
{
	"type": "template",
	"name": "H_3x5",
	"anchor": "top-left",
	"stride": 1,
	"palette": "wplace",
	"grid": [
		["87ff5e", ".", "87ff5e"],
		["87ff5e", ".", "87ff5e"],
		["87ff5e", "87ff5e", "87ff5e"],
		["87ff5e", ".", "87ff5e"],
		["87ff5e", ".", "87ff5e"]
	]
}
```

### Example - pink G 5x7 on a consistent non transparent background

```yaml
@template name: "G_5x7"
anchor: top-left
stride: 1
grid:
  [ <a: !{T}>, cb007a, cb007a, cb007a, cb007a ]
  [ cb007a,    =<a>,   =<a>,   =<a>,   =<a>   ]
  [ cb007a,    =<a>,   =<a>,   cb007a, cb007a ]
  [ cb007a,    =<a>,   =<a>,   =<a>,   cb007a ]
  [ cb007a,    =<a>,   =<a>,   =<a>,   cb007a ]
  [ cb007a,    =<a>,   =<a>,   =<a>,   cb007a ]
  [ =<a>,      cb007a, cb007a, cb007a, =<a>   ]
```

## Vague - 1D run patterns plus grouping

A **run** is a `(colour, length)` pair produced by RLE of a single row or a single column. A vague rule is a small regex-like sequence of run atoms and length quantifiers that matches on one row or column. After a single row or column matches, we group adjacent rows or columns that match the same pattern and align them.

### Deterministic behaviour

- **Quantifiers** - `{min,max}` are **lazy** by default, not greedy. That avoids overmatching.
- **Anchor** - the anchor is the first pixel of the run at `align_on` (see group block).
- **prev and next** - refer to the previous and next **literal colour tokens** in the pattern, not to pixel values. Using `prev` on the first literal or `next` on the last literal is invalid.

### Pattern primitives

- Colour atoms

  - literal: `#60f7f2`, `60f7f2`, or named colour like `lightgreen`
  - transparent: `T`, `t`, `transparent`
  - any: `.`
  - not in set: `![a|b|T]`
  - one of set: `[a|b|c]`
  - references: `prev`, `next` which point to neighbouring literal tokens in the pattern
  - capture and reuse: `(<w: 60f7f2{40,60}>)` then `=<w>` refers to the same colour, and `len(w)` refers to that run length

- Length quantifier

  - `{min,max}` inclusive
  - `{min,}` for no max
  - if omitted, length is exactly 1

### Grouping block

After matching a single row or column, examine neighbours and merge them into a group when they match the same pattern and align.

- `group.width` or `group.height` - min and max neighbour count
- `group.align_on` - which pattern run index defines the alignment origin across neighbours, default 0
- `group.align` - `top` for columns or `left` for rows
- `group.tol_px` - max pixel offset allowed at the start of the `align_on` run across neighbours, default 0

### Optional extras

- `required_colours` - quick prefilter by palette index presence

### Example - stacked blues then transparent

```yaml
@pattern name: "blue_stack"
axis: column
palette: wplace
pattern:
  60f7f2{40,}
  4093e4{1,20}
  60f7f2{1,20}
  4093e4{1,20}
  60f7f2{1,20}
  4093e4{1,20}
  T{40,}
  .{1,}
group:
  width: [1,20]
  align_on: 0
  align: top
  tol_px: 0
max_matches_per_tile: 1
required_colours: [ 60f7f2, 4093e4 ]
```

### Example - yellow rectangle, small separator band, red rectangle on a row

```yaml
@pattern name: "yellow_band_red"
axis: row
palette: wplace
pattern:
  f9dd3b{10,50}
  ![T|prev|next]{5,10}
  ed1c24{10,50}
group:
  height: [1,50]
  align_on: 0
  align: left
  tol_px: 0
```

### Canonical JSON with typed atoms

Avoid encoding token semantics inside strings like `"![T|prev|next]"`. Use a small AST.

```json
{
	"type": "pattern",
	"name": "yellow_band_red",
	"axis": "row",
	"palette": "wplace",
	"pattern": [
		{ "atom": { "type": "literal", "value": "f9dd3b" }, "len": { "min": 10, "max": 50 } },
		{
			"atom": {
				"type": "not",
				"of": [{ "type": "transparent" }, { "type": "prev" }, { "type": "next" }]
			},
			"len": { "min": 5, "max": 10 }
		},
		{ "atom": { "type": "literal", "value": "ed1c24" }, "len": { "min": 10, "max": 50 } }
	],
	"group": { "height": { "min": 1, "max": 50 }, "align_on": 0, "align": "left", "tol_px": 0 },
	"max_matches_per_tile": 1
}
```

Another example showing captures and tied lengths:

```json
{
	"type": "pattern",
	"name": "blue_stack_captured",
	"axis": "column",
	"pattern": [
		{
			"atom": { "type": "capture", "name": "w", "of": { "type": "literal", "value": "60f7f2" } },
			"len": { "min": 40 }
		},
		{ "atom": { "type": "literal", "value": "4093e4" }, "len": { "min": 1, "max": 20 } },
		{ "atom": { "type": "ref", "name": "w" }, "len": { "eq": { "ref_len": "w" } } }
	],
	"group": { "width": { "min": 1, "max": 20 }, "align_on": 0, "align": "top", "tol_px": 0 }
}
```

## Outputs and logging

When a rule hits, record a JSONL entry and copy the matched image.

- Tiles directory - `C:\Users\jazza\Downloads\wplace\tiles-115\x\y.png`
- Matches JSONL - `C:\Users\jazza\Downloads\wplace\tiles-115-matches.jsonl`
- Copies directory - `C:\Users\jazza\Downloads\wplace\tiles-115-matches`
- Copy file name - `X{tileX} Y{tileY}.png`

JSONL event shape:

```json
{
	"rule": "blue_stack",
	"mode": "pattern",
	"tile": { "x": 1234, "y": 567 },
	"anchor": { "x": 876, "y": 432 }, // pixel within the tile at the start of align_on run
	"group": { "axis": "column", "width": 7, "align_on": 0, "align": "top", "tol_px": 0 },
	"image": "C:\\Users\\jazza\\Downloads\\wplace\\tiles-115\\1234\\567.png",
	"palette": "wplace",
	"timestamp": "2025-10-03T06:00:00Z"
}
```

## Engine outline

1. **Ingest**

   - Load PNG
   - If RGB, quantise once to palette indices
   - Precompute RLE runs for every row and column
   - Build a fast set of present palette indices for prefiltering

2. **Specific first**

   - Slide the grid with `stride`
   - Early exit on first hit per rule or up to `max_matches_per_tile`

3. **Vague next**

   - For each row or column, run a tiny DFA over that run list using lazy quantifiers
   - If matched, try to merge neighbour rows or columns that match the same pattern and align under `group.align_on` and `group.tol_px`
   - Accept if the merged width or height is within range

4. **Tile skipping**

   - Use `required_colours` to avoid scanning tiles that cannot match

5. **Emit and copy**

   - Write JSONL entry
   - Copy the tile to the matches folder

## Linting rules

- Error if `prev` or `next` is used where there is no previous or next literal token
- Error if `group.align_on` is out of range for `pattern` length
- Disallow capture names that start with digits
- Validate that all JSON atoms match an allowed type

## FAQ crumbs

- **What about “any but previous colour” on a row**
  Use `![T|prev]` where `prev` refers to the previous literal token in the pattern.

- **“Same width as before”**
  Capture a run and reference its length via `len(w)` in later quantifiers or group constraints.
