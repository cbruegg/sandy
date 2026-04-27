import { Buffer } from "node:buffer";
import type { TranscriptionInput, TranscriptionProvider } from "./transcription-provider.js";

type FetchLike = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => ReturnType<typeof fetch>;

type OpenAiTranscriptionProviderOptions = {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetchFn?: FetchLike;
};

type OpenAiTranscriptionResponse = {
  text?: unknown;
};

const TRANSCRIPTION_PROMPT =
  "Transcribe verbatim. Do not translate anything. Preserve all foreign words, names, and terms in their original language.";

export class OpenAiTranscriptionProvider implements TranscriptionProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchFn: FetchLike;

  constructor(options: OpenAiTranscriptionProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.model = options.model ?? "gpt-4o-mini-transcribe";
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async transcribe(input: TranscriptionInput): Promise<string> {
    const formData = new FormData();
    formData.set(
      "file",
      new File([Buffer.from(input.audio)], input.fileName, {
        type: input.mimeType ?? "application/octet-stream",
      }),
    );
    formData.set("model", this.model);
    formData.set("prompt", TRANSCRIPTION_PROMPT);

    const response = await this.fetchFn(buildTranscriptionUrl(this.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Transcription request failed with status ${response.status}.`);
    }

    const parsed = await response.json() as OpenAiTranscriptionResponse;
    if (typeof parsed.text !== "string" || parsed.text.trim() === "") {
      throw new Error("Transcription response did not include text.");
    }

    return parsed.text;
  }
}

function buildTranscriptionUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/audio/transcriptions`;
}
