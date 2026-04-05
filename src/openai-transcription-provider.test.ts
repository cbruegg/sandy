import assert from "node:assert/strict";
import test from "node:test";
import { OpenAiTranscriptionProvider } from "./transcription/openai-transcription-provider.js";

test("OpenAiTranscriptionProvider uses the default OpenAI endpoint and model", async () => {
  let requestUrl: RequestInfo | URL = "";
  let requestInit: RequestInit | undefined;
  const provider = new OpenAiTranscriptionProvider({
    apiKey: "sk-test",
    fetchFn: async (input, init) => {
      requestUrl = input instanceof URL ? input.toString() : input;
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
      : headers?.Authorization;

  assert.equal(transcript, "hello world");
  assert.equal(formatRequestUrl(requestUrl), "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(requestInit?.method, "POST");
  assert.equal(authorizationHeader, "Bearer sk-test");
  const body = requestInit?.body;
  assert.ok(body instanceof FormData);
  assert.equal(body.get("model"), "gpt-4o-mini-transcribe");
});

test("OpenAiTranscriptionProvider trims the base URL before appending the transcription path", async () => {
  let requestUrl: RequestInfo | URL = "";
  const provider = new OpenAiTranscriptionProvider({
    apiKey: "sk-test",
    baseUrl: "https://transcribe.example/v1///",
    fetchFn: async (input) => {
      requestUrl = input instanceof URL ? input.toString() : input;
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

  assert.equal(formatRequestUrl(requestUrl), "https://transcribe.example/v1/audio/transcriptions");
});

function formatRequestUrl(input: RequestInfo | URL): string {
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === "string") {
    return input;
  }
  return input.url;
}
