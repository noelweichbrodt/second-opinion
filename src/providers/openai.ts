import OpenAI from "openai";
import {
  ReviewProvider,
  ReviewRequest,
  ReviewResponse,
  buildReviewPrompt,
  getSystemPrompt,
} from "./base.js";

export class OpenAIProvider implements ReviewProvider {
  name = "openai";
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string = "gpt-4o") {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async review(request: ReviewRequest): Promise<ReviewResponse> {
    const prompt = buildReviewPrompt(request);
    const systemPrompt = getSystemPrompt(!!request.task, request.hasOmittedFiles);

    // Use provided temperature or default to 0.3 for focused output
    const temperature = request.temperature ?? 0.3;

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      max_completion_tokens: 8192,
      temperature,
    });

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
}
