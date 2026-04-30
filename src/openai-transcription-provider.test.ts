import assert from "node:assert/strict";
import { test } from "bun:test";
import { OpenAiTranscriptionProvider } from "./transcription/openai-transcription-provider.js";

test("OpenAiTranscriptionProvider uses the default OpenAI endpoint and model", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const provider = new OpenAiTranscriptionProvider({
    apiKey: "sk-test",
    fetchFn: async (input, init) => {
      requestUrl = requestInputToUrl(input);
      requestInit = init;
      return new Response(JSON.stringify({ text: "hello world" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    },
  });

  const transcript = await provider.transcribe({
    audio: new Uint8Array([1, 2, 3]),
    fileName: "voice.ogg",
    mimeType: "audio/ogg",
  });

  const headers = requestInit?.headers;
  const authorizationHeader = headers instanceof Headers
    ? headers.get("Authorization")
    : Array.isArray(headers)
      ? headers.find(([key]) => key === "Authorization")?.[1]
      : headers?.["Authorization"];

  assert.equal(transcript, "hello world");
  assert.equal(requestUrl, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(requestInit?.method, "POST");
  assert.equal(authorizationHeader, "Bearer sk-test");
  const body = requestInit?.body;
  assert.ok(body instanceof FormData);
  assert.equal(body.get("model"), "gpt-4o-mini-transcribe");
  assert.equal(
    body.get("prompt"),
    "Transcribe verbatim. Do not translate anything. Preserve all foreign words, names, and terms in their original language and script, even within a sentence of different language.",
  );
});

test("OpenAiTranscriptionProvider trims the base URL before appending the transcription path", async () => {
  let requestUrl = "";
  const provider = new OpenAiTranscriptionProvider({
    apiKey: "sk-test",
    baseUrl: "https://transcribe.example/v1///",
    fetchFn: async (input) => {
      requestUrl = requestInputToUrl(input);
      return new Response(JSON.stringify({ text: "done" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    },
  });

  await provider.transcribe({
    audio: new Uint8Array([1]),
    fileName: "voice.ogg",
  });

  assert.equal(requestUrl, "https://transcribe.example/v1/audio/transcriptions");
});

function requestInputToUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}
