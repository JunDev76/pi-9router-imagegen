/**
 * imagegen — 9router image generation tool
 *
 * Calls 9router's `/v1/responses` endpoint with the Codex `image_generation`
 * tool (gpt-image-2). Uses the already-configured `9router` provider auth
 * (apiKey + baseUrl) from pi's model registry, so no separate login needed.
 *
 * Saves images to ~/.pi/agent/generated-images/<timestamp>-<id>.<ext>
 * and returns them inline as image attachments so the LLM can see the result.
 */

import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

const PROVIDER = "9router";
const RESPONSE_MODEL = "cx/gpt-5.5"; // text LLM that dispatches the image_generation tool
const IMAGE_MODEL = "gpt-image-2";

const SIZES = ["auto", "1024x1024", "1536x1024", "1024x1536"] as const;
const QUALITIES = ["auto", "low", "medium", "high"] as const;
const BACKGROUNDS = ["auto", "opaque", "transparent"] as const;
const OUTPUT_FORMATS = ["png", "webp", "jpeg"] as const;

const TOOL_PARAMS = Type.Object({
	prompt: Type.String({ description: "Image description/prompt." }),
	size: Type.Optional(StringEnum(SIZES)),
	quality: Type.Optional(StringEnum(QUALITIES)),
	background: Type.Optional(StringEnum(BACKGROUNDS)),
	outputFormat: Type.Optional(StringEnum(OUTPUT_FORMATS)),
	outputPath: Type.Optional(
		Type.String({
			description:
				"Optional exact path where the generated image should be saved. Defaults to ~/.pi/agent/generated-images/<id>.<format>.",
		}),
	),
	referenceImages: Type.Optional(
		Type.Array(Type.String(), {
			description:
			"Optional paths to reference images. Appended as input_image blocks so gpt-image-2 can edit/condition on them.",
		}),
	),
});

type ToolParams = Static<typeof TOOL_PARAMS>;

function mimeFromFormat(format: string): string {
	if (format === "jpeg") return "image/jpeg";
	if (format === "webp") return "image/webp";
	return "image/png";
}

function mimeFromPath(p: string): string {
	const e = extname(p).toLowerCase();
	if (e === ".jpg" || e === ".jpeg") return "image/jpeg";
	if (e === ".webp") return "image/webp";
	if (e === ".gif") return "image/gif";
	return "image/png";
}

function extensionFromFormat(format: string): string {
	return format === "jpeg" ? "jpg" : format;
}

function defaultOutputDir(): string {
	return join(homedir(), ".pi", "agent", "generated-images");
}

function defaultOutputPath(imageId: string, format: string): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return join(defaultOutputDir(), `${stamp}-${imageId}.${extensionFromFormat(format)}`);
}

function resolvePath(p: string, base: string): string {
	if (p.startsWith("/")) return p;
	return join(base, p);
}

function resolveOutputPath(path: string | undefined, cwd: string, imageId: string, format: string): string {
	if (!path || !path.trim()) return defaultOutputPath(imageId, format);
	const raw = path.trim().startsWith("@") ? path.trim().slice(1) : path.trim();
	const absolute = resolvePath(raw, cwd);
	if (!extname(absolute)) return join(absolute, `${imageId}.${extensionFromFormat(format)}`);
	return absolute;
}

async function saveImage(path: string, base64: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, Buffer.from(base64, "base64"));
}

interface ImageGenOutput {
	id: string;
	type: "image_generation_call";
	result: string;
	revised_prompt?: string;
	revisedPrompt?: string;
}

function findImageOutput(outputs: unknown[]): ImageGenOutput | undefined {
	for (const item of outputs) {
		if (item && typeof item === "object" && (item as { type?: string }).type === "image_generation_call") {
			return item as ImageGenOutput;
		}
	}
	return undefined;
}

type ImagegenExecuteCtx = {
	cwd: string;
	modelRegistry: {
		getProviderAuth: (provider: string) => Promise<
			| { auth: { apiKey?: string; baseUrl?: string; headers?: Record<string, string> } }
			| undefined
		>;
	};
};

async function generateImage(
	params: ToolParams,
	signal: AbortSignal | undefined,
	onUpdate: ((result: { content: Array<{ type: "text"; text: string }> }) => void) | undefined,
	ctx: ImagegenExecuteCtx,
) {
	const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER);
	if (!auth?.auth?.apiKey) {
		throw new Error(`Missing ${PROVIDER} auth. Configure 9router first via /9router-config.`);
	}

	const apiKey = auth.auth.apiKey;
	// auth.baseUrl from pi-9router-ext is `${config.baseUrl}/v1`; normalize so
	// we can append /responses uniformly. Fall back to the known local default.
	let baseUrl = auth.auth.baseUrl;
	if (!baseUrl) {
		baseUrl = "http://localhost:20128/v1";
	} else if (baseUrl.endsWith("/v1")) {
		baseUrl = `${baseUrl}`;
	}

	const size = params.size ?? "auto";
	const quality = params.quality ?? "auto";
	const background = params.background ?? "auto";
	const outputFormat = params.outputFormat ?? "png";
	const sessionId = randomUUID();

	// Reference images: read + base64, appended as input_image blocks so
	// gpt-image-2 can edit/condition on them. resolvePath reuses cwd.
	const refBlocks: Array<{ type: "input_image"; image_url: string; detail: "auto" }> = [];
	if (params.referenceImages?.length) {
		for (const refRaw of params.referenceImages) {
			const refPath = resolvePath(refRaw.trim(), ctx.cwd);
			const data = await readFile(refPath);
			const b64 = Buffer.from(data).toString("base64");
			refBlocks.push({
				type: "input_image",
				image_url: `data:${mimeFromPath(refPath)};base64,${b64}`,
				detail: "auto",
			});
		}
	}
	const userContent: Array<{
		type: "input_text" | "input_image";
		text?: string;
		image_url?: string;
		detail?: "auto";
	}> = [{ type: "input_text", text: `Generate this image: ${params.prompt}` }];
	userContent.push(...refBlocks);

	const body = {
		model: RESPONSE_MODEL,
		store: false,
		instructions:
			"You are an image generation dispatcher. Use the image_generation tool to create exactly the image requested by the user. If reference images are provided, condition the generation on them (edit/transform/style-match as the prompt describes). Do not write code.",
		input: [
			{
				role: "user",
				content: userContent,
			},
		],
		text: { verbosity: "low" },
		prompt_cache_key: sessionId,
		tool_choice: "auto",
		parallel_tool_calls: false,
		tools: [
			{
				type: "image_generation",
				model: IMAGE_MODEL,
				background,
				moderation: "auto",
				output_compression: 100,
				output_format: outputFormat,
				quality,
				size,
			},
		],
	};

	onUpdate?.({
		content: [{ type: "text", text: `Requesting image from ${PROVIDER}/${IMAGE_MODEL}${refBlocks.length ? ` (${refBlocks.length} ref image${refBlocks.length > 1 ? "s" : ""})` : ""}...` }],
	});

	const response = await fetch(`${baseUrl}/responses`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			Accept: "application/json",
			...(auth.auth.headers ?? {}),
		},
		body: JSON.stringify(body),
		signal,
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`${PROVIDER} image request failed (${response.status}): ${errorText}`);
	}

	const payload = (await response.json()) as {
		status?: string;
		output?: unknown[];
		error?: { message?: string };
	};

	if (payload.status === "failed" || payload.error) {
		throw new Error(payload.error?.message || `${PROVIDER} image generation failed.`);
	}

	const image = findImageOutput(payload.output ?? []);
	if (!image?.result) {
		throw new Error("No image_generation_call result returned by 9router.");
	}

	const savedPath = resolveOutputPath(params.outputPath, ctx.cwd, image.id, outputFormat);
	await saveImage(savedPath, image.result);

	const revised = image.revised_prompt ?? image.revisedPrompt;
	const text = [
		`Generated image with ${PROVIDER}/${IMAGE_MODEL}.`,
		`Saved to: ${savedPath}`,
		revised ? `Revised prompt: ${revised}` : undefined,
	]
		.filter(Boolean)
		.join("\n");

	return { image, savedPath, text, mimeType: mimeFromFormat(outputFormat) };
}

export default function imagegenExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "imagegen",
		label: "Image Gen",
		description:
			"Generate a raster image via 9router's Codex `image_generation` tool (gpt-image-2). Returns the saved file path and an inline image attachment. Pass referenceImages to condition/edit on existing images.",
		promptSnippet: "Generate an image from a text prompt",
		promptGuidelines: [
			"Use imagegen when the user asks to generate, create, or draw a raster image (png/jpg/webp) from a text description.",
			"Do not use imagegen for SVG, icons, diagrams, ASCII art, or code that draws — write code or edit files directly instead.",
		],
		parameters: TOOL_PARAMS,
		async execute(_toolCallId, params: ToolParams, signal, onUpdate, ctx) {
			const { image, savedPath, text, mimeType } = await generateImage(
				params,
				signal,
				onUpdate,
				ctx as ImagegenExecuteCtx,
			);
			return {
				content: [
					{ type: "text", text },
					{ type: "image", data: image.result, mimeType },
				],
				details: {
					imageId: image.id,
					savedPath,
					mimeType,
					revisedPrompt: image.revised_prompt ?? image.revisedPrompt,
					model: IMAGE_MODEL,
					responseModel: RESPONSE_MODEL,
					provider: PROVIDER,
				},
			};
		},
	});

	// /img gen [--size ...] [--quality ...] [--format ...] <prompt>
	pi.registerCommand("img", {
		description:
			"Generate an image: /img gen [--size auto|1024x1024|1536x1024|1024x1536] [--quality auto|low|medium|high] [--format png|webp|jpeg] [--out path] [--ref path ...] <prompt>",
		handler: async (args, ctx) => {
			const tokens = args.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((t) => t.replace(/^"|"$/g, "")) ?? [];
			const options: Partial<ToolParams> = {};
			const positional: string[] = [];
			const refs: string[] = [];
			for (let i = 0; i < tokens.length; i++) {
				const t = tokens[i]!;
				const next = tokens[i + 1];
				if (t === "--size" && next) { options.size = next as ToolParams["size"]; i++; }
				else if (t === "--quality" && next) { options.quality = next as ToolParams["quality"]; i++; }
				else if (t === "--background" && next) { options.background = next as ToolParams["background"]; i++; }
				else if ((t === "--format" || t === "--output-format") && next) { options.outputFormat = next as ToolParams["outputFormat"]; i++; }
				else if ((t === "--out" || t === "--output") && next) { options.outputPath = next; i++; }
				else if ((t === "--ref" || t === "--reference") && next) { refs.push(...next.split(",").map((s) => s.trim()).filter(Boolean)); i++; }
				else positional.push(t);
			}
			if (refs.length) options.referenceImages = refs;
			const prompt = positional.join(" ").trim();
			if (!prompt) {
				ctx.ui.notify("Usage: /img gen <prompt> (optional --size/--quality/--format/--out)", "warning");
				return;
			}
			options.prompt = prompt;

			ctx.ui.notify(`Generating image: ${prompt.slice(0, 80)}${prompt.length > 80 ? "…" : ""}`, "info");
			try {
				const { image, savedPath, mimeType } = await generateImage(options, ctx.signal, undefined, ctx as ImagegenExecuteCtx);
				ctx.ui.notify(`Saved: ${savedPath}`, "info");
				pi.sendMessage(
					{
						customType: "imagegen",
						content: `Generated image (gpt-image-2)`,
						display: true,
						details: { imageId: image.id, savedPath, mimeType },
					},
					{ triggerTurn: false },
				);
			} catch (err) {
				ctx.ui.notify(`Image generation failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}

// ponytail: batches and a browser studio are skipped — add when you
// actually need bulk generation. Reference-image support (input_image) is
// implemented; edit mode uses multiple reference images or mask paths.
// Responses API also supports a `mask` field on image_generation for
// inpainting — add when needed.