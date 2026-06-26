import OpenAI from "openai";
import {
  ReviewProvider,
  ReviewRequest,
  ReviewResponse,
  buildReviewPrompt,
  getSystemPrompt,
} from "./base.js";

/**
 * Reasoning-tier models (e.g. gpt-5.5) only allow the default temperature and
 * reject an explicit `temperature` param, while chat-tuned models (gpt-4o,
 * gpt-5.2) accept it. There's no reliable name pattern, so we discover support
 * at runtime: send temperature, and if the API rejects that specific param,
 * cache the model here and retry without it — paying the failed round-trip at
 * most once per model per process.
 */
const modelsRejectingTemperature = new Set<string>();

function isTemperatureUnsupportedError(error: unknown): boolean {
  const param = (error as { param?: unknown } | null)?.param;
  if (param === "temperature") return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    /temperature/i.test(message) &&
    /unsupported|does not support|only the default/i.test(message)
  );
}

export class OpenAIProvider implements ReviewProvider {
  name = "openai";
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string = "gpt-5.5") {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async review(request: ReviewRequest): Promise<ReviewResponse> {
    const prompt = buildReviewPrompt(request);
    const systemPrompt = getSystemPrompt(!!request.task);

    // Use provided temperature or default to 0.3 for focused output
    const temperature = request.temperature ?? 0.3;
    const maxOutputTokens = request.maxOutputTokens ?? 32768;

    const messages = [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: prompt },
    ];

    const response = await this.createCompletion(messages, maxOutputTokens, temperature);

    const text = response.choices[0]?.message?.content || "";
    const tokensUsed = response.usage
      ? response.usage.prompt_tokens + response.usage.completion_tokens
      : undefined;

    return {
      review: text,
      model: this.model,
      tokensUsed,
    };
  }

  private async createCompletion(
    messages: { role: "system" | "user"; content: string }[],
    maxOutputTokens: number,
    temperature: number
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const withoutTemperature = () =>
      this.client.chat.completions.create({
        model: this.model,
        messages,
        max_completion_tokens: maxOutputTokens,
      });

    // Skip temperature up front for models already known to reject it.
    if (modelsRejectingTemperature.has(this.model)) {
      return withoutTemperature();
    }

    try {
      return await this.client.chat.completions.create({
        model: this.model,
        messages,
        max_completion_tokens: maxOutputTokens,
        temperature,
      });
    } catch (error) {
      if (isTemperatureUnsupportedError(error)) {
        modelsRejectingTemperature.add(this.model);
        console.error(
          `[second-opinion] Model "${this.model}" rejects a custom temperature; ` +
            `retrying with the model default and skipping it for future calls.`
        );
        return withoutTemperature();
      }
      throw error;
    }
  }
}
