# pi-9router-imagegen

Pi extension for image generation via 9router’s Codex Responses `image_generation` tool (`gpt-image-2`). Uses your existing 9router auth and ChatGPT plan.

Adds an agent-callable `imagegen` tool and an `/img` command.

## Install

```txt
pi install npm:pi-9router-imagegen
```

Then `/reload`.

Requires:

1. **pi** with the `9router` provider configured (`pi-9router-ext`, `/9router-config`)
2. A 9router instance whose Codex route supports `image_generation`

Optional smoke test:

```bash
curl -s http://localhost:20128/v1/responses \
  -H "Authorization: Bearer <your-9router-key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"cx/gpt-5.5","input":"draw a red dot","tools":[{"type":"image_generation","model":"gpt-image-2"}]}'
```

If the response includes an `image_generation_call` output, you're good.

### From source

```bash
git clone https://github.com/JunDev76/pi-9router-imagegen.git
cd pi-9router-imagegen
pi install .
/reload
```

## Usage

### Agent tool

The model can call `imagegen` on its own when an image would help. Give it a task, not just an image prompt:

> Build a landing page for a coffee brand. Use `imagegen` freely for the hero image, product shots, and any other assets you need.

> Mock up a mobile app onboarding flow and generate the illustration assets as you go.

It skips SVG, icons, diagrams, and code-that-draws — those stay as code.

### `/img` command

One image, now:

```txt
/img gen a product photo of a ceramic mug on a white background
/img gen --size 1536x1024 --quality high a cinematic expedition poster for a lava cavern
/img gen --format webp --out ./assets/hero.png coffee shop storefront at golden hour
/img gen --ref ./input.png make it a watercolor painting
/img gen --ref ./sketch.png,./mood.png --size 1024x1024 render in this style
```

| Flag | Values | Default |
|------|--------|---------|
| `--size` | `auto` · `1024x1024` · `1536x1024` · `1024x1536` | `auto` |
| `--quality` | `auto` · `low` · `medium` · `high` | `auto` |
| `--background` | `auto` · `opaque` · `transparent` | `auto` |
| `--format` | `png` · `webp` · `jpeg` | `png` |
| `--out` | path | `~/.pi/agent/generated-images/<ts>-<id>.<ext>` |
| `--ref` | path (comma-separated, repeatable) | none — text-to-image |

Pass `--ref` one or more image paths to condition the generation on them (edit / transform / style-match):

## Output

Images land in `~/.pi/agent/generated-images/` by default. The tool returns the saved path plus an inline image attachment, so vision-capable models can inspect the result without opening the file.

## Configuration

Dispatch model and image model are constants at the top of `imagegen.ts`:

```ts
const PROVIDER = "9router";
const RESPONSE_MODEL = "cx/gpt-5.5"; // text LLM that dispatches image_generation
const IMAGE_MODEL = "gpt-image-2";
```

Change `RESPONSE_MODEL` to whatever Codex text model id your 9router instance exposes.

## How it works

`gpt-image-2` is not a top-level chat model — it's a tool on the Codex Responses API. This extension posts to 9router’s `/v1/responses` with a text model and an `image_generation` tool:

```json
{
  "model": "cx/gpt-5.5",
  "tools": [{
    "type": "image_generation",
    "model": "gpt-image-2",
    "size": "1024x1024",
    "quality": "medium"
  }]
}
```

9router routes that to Codex; the base64 image comes back in an `image_generation_call` output. Auth and base URL come from the existing `9router` provider — no extra login.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Missing 9router auth` | Configure with `/9router-config` / `pi-9router-ext` |
| HTTP 400 / no `image_generation_call` | Confirm your Codex route supports `image_generation`; re-run the smoke test above |
| Image saved but model can't "see" it | Switch to a vision-capable model for that turn |

## License

MIT
