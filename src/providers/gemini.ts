import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  ReviewProvider,
  ReviewRequest,
  ReviewResponse,
  buildReviewPrompt,
  getSystemPrompt,
} from "./base.js";

export class GeminiProvider implements ReviewProvider {
  name = "gemini";
  private client: GoogleGenerativeAI;
  private model: string;

  constructor(apiKey: string, model: string = "gemini-2.0-flash-exp") {
    this.client = new GoogleGenerativeAI(apiKey);
    this.model = model;
  }

  async review(request: ReviewRequest): Promise<ReviewResponse> {
    const prompt = buildReviewPrompt(request);
    const systemInstruction = getSystemPrompt(!!request.task);

    const model = this.client.getGenerativeModel({
      model: this.model,
      systemInstruction,
    });

    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        maxOutputTokens: 8192,
        temperature: 0.3, // Lower temperature for more focused reviews
      },
    });

    const response = result.response;
    const text = response.text();

    // Get token usage if available
    const usage = response.usageMetadata;
    const tokensUsed = usage
      ? (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0)
      : undefined;

    return {
      review: text,
      model: this.model,
      tokensUsed,
    };
  }
}
