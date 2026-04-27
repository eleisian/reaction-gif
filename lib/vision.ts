import { readFile } from "node:fs/promises";

export type VisionDebugLogger = (message: string) => void;

function getDataUrl(mimeType: string, buffer: Buffer) {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

export async function describeSourceImage(
  imagePath: string,
  mimeType: string,
  logger?: VisionDebugLogger
) {
  if (!process.env.OPENAI_API_KEY) {
    logger?.("OPENAI_API_KEY is not configured; skipping source visual description.");
    return null;
  }

  const model = process.env.OPENAI_VISION_MODEL ?? "gpt-4o-mini";
  logger?.(`Describing source frame with ${model}.`);

  const buffer = await readFile(imagePath);
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "Describe the supplied image for an image-editing model. Focus on subject identity, art style, camera angle, composition, colors, lighting, background, and visible motion context. Be concise and concrete."
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Describe this source frame so an outpainting model can preserve its style and subject continuity."
            },
            {
              type: "image_url",
              image_url: {
                url: getDataUrl(mimeType, buffer),
                detail: "low"
              }
            }
          ]
        }
      ],
      max_tokens: 180
    })
  });

  if (!response.ok) {
    const body = await response.text();
    logger?.(
      `Source visual description failed: ${response.status} ${response.statusText} ${body.slice(0, 500)}`
    );
    return null;
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const description = data.choices?.[0]?.message?.content?.trim() ?? null;

  if (description) {
    logger?.(`Source visual description: ${description}`);
  } else {
    logger?.("Source visual description returned no text.");
  }

  return description;
}
