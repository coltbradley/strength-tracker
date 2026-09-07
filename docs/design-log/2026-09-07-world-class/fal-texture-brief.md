# Using fal.ai correctly for UI textures

Researched after Colt pushed back: "I'm not sure you're prompting it correctly
or choosing the right model." He was right on both counts.

## What I was doing wrong

**I picked the model from memory.** The fal tool's own instructions say: _"If the
user does NOT specify a model by name, you MUST call recommend_model first.
Never pick a model from your own knowledge."_ I went straight to
`fal-ai/flux/dev` three times without ever calling it.

**`flux/dev` cannot tile at all.** Every texture it produced was a lottery on
whether the edges happened to match.

**My "negative prompts" were not negative prompts.** `get_model_schema` on
flux/dev returns no `negative_prompt` parameter — it does not exist. So
`"no seams, no grout lines"` was a _positive_ prompt containing the tokens
"seams" and "grout lines", and diffusion models render the nouns you hand them.

**"Tile" is a countable noun.** The prompt said "crumb rubber **tile**", so Flux
correctly drew tiles — and tiles have grout. That is the entire origin of the
grout lines I then spent two regenerations trying to remove.

## What is actually right

Native tiling models exist. They tile in **latent space** (`tiling_mode`,
`tile_size`, `tile_stride`), so seamlessness is structural rather than requested:

| Endpoint                              | Native tiling | Price       |
| ------------------------------------- | ------------- | ----------- |
| **`fal-ai/z-image/turbo/tiling`**     | yes           | $0.02/MP    |
| `fal-ai/patina/material` (`maps: []`) | yes           | $0.01/MP    |
| `ideogram/v4/tiling` (image-to-image) | yes           | $0.04/image |

Note `recommend_model` does NOT surface these — it is popularity-ranked and
returns generic text-to-image models. `search_models` is what finds them.

Working parameters:

```json
{
  "image_size": "square_hd",
  "num_inference_steps": 8,
  "tiling_mode": "both",
  "tile_size": 128,
  "tile_stride": 64,
  "output_format": "png",
  "acceleration": "regular",
  "enable_prompt_expansion": false,
  "seed": 12345
}
```

- `num_inference_steps` **maxes at 8** on this model. Porting flux habits (28
  steps, guidance_scale 3.5) is meaningless — neither parameter exists.
- `enable_prompt_expansion` must be **off**. An LLM rewriting a carefully
  mass-noun'd prompt is precisely how "tile" gets reintroduced.
- Pin the `seed` so a texture can be regenerated at another size.

## Prompting, since you cannot subtract

Name the material as a **mass noun** and assert the positive opposite. Never
write tile, plate, panel, sheet, board, floor or slab. Say rubber, iron, steel,
paper.

Structure: material as mass noun → grain with explicit colours → density and
continuity → orthographic camera → flat lighting with named absences →
frame-filling assertion → scale consistency. Long prose, not tag soup.

The verified rubber prompt is in `pwa/public/proto/iron.html`'s header and was
measured, not eyeballed.

## Verification, measured

Wrap-around seam difference vs a typical interior column difference:

```
wrap seam diff : 7.94
interior diff  : 6.92
ratio          : 1.15     (~1 = seamless; 3-10 = visible seam)
lighting spread: 4.3 levels of 255  (no vignette, no gradient)
```

Always measure this. "Seamless" in a model name is a claim; the ratio is
evidence.

## Surviving downscale — the knurl post-mortem

Contrast (stddev) as the same texture is downscaled:

| Size      | Contrast | WebP         |
| --------- | -------- | ------------ |
| 1024px    | 17.4     | 2.1 MB (png) |
| 512px     | 13.4     | 72 KB        |
| **256px** | 8.0      | **11 KB**    |
| 128px     | 4.3      | 0.9 KB       |

Downscaling is a low-pass filter. Detail finer than the target grid averages to
grey mush, or aliases into noise when the pattern frequency beats against the
pixel grid. That is exactly what happened to the knurl at 8px.

Rules:

- **Generate near ship size.** 1024 → 8px throws away 99% of what you paid for.
- **Ask for coarse and high-contrast**, not fine and detailed. "Large widely
  spaced diamonds, deep grooves" survives; "fine precision knurling" cannot.
- A feature needs roughly **6–10 output pixels** to read at all.
- **Random grain downscales gracefully; regular geometric patterns alias.**
  Rubber and paper are safe. Knurl is the hard case.
- For an 8px strip, do not use a generated photo at all — a CSS
  `repeating-linear-gradient` is a few bytes, crisp, and genuinely tileable.
  Which is what the knurl was replaced with, before any of this was known.

## Cost

Billing rounds up to the nearest megapixel, so 512² and 1024² cost the same —
always generate at 1024 and downscale. Roughly $0.02–0.04 per image on
z-image/turbo/tiling. The whole texture set, with retries, is well under a
dollar.

## Result

`pwa/public/tex/rubber.webp` — 11 KB at 256px, measured seamless, tiled at
128px in the cast-iron prototype. Whole texture directory is 28 KB.
