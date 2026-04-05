export type TranscriptionInput = {
  audio: Uint8Array;
  fileName: string;
  mimeType?: string;
};

export interface TranscriptionProvider {
  transcribe(input: TranscriptionInput): Promise<string>;
}
