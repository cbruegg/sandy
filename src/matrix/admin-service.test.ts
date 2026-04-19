import { test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promptForPasswordHidden } from "./admin-service.js";

class MockReadStream extends EventEmitter {
  setRawMode(_raw: boolean): this {
    return this;
  }

  resume(): this {
    return this;
  }

  pause(): this {
    return this;
  }

  setEncoding(_encoding: BufferEncoding): this {
    return this;
  }

  emitChars(chars: string[]): void {
    for (const char of chars) {
      this.emit("data", char);
    }
  }
}

class MockWriteStream extends EventEmitter {
  outputs: string[] = [];

  write(chunk: string | Buffer): boolean {
    this.outputs.push(chunk.toString());
    return true;
  }
}

test("promptForPasswordHidden returns password on Enter", async () => {
  const mockStdin = new MockReadStream();
  const mockStdout = new MockWriteStream();

  const promptPromise = promptForPasswordHidden(
    "Password: ",
    mockStdin as unknown as NodeJS.ReadStream,
    mockStdout as unknown as NodeJS.WriteStream,
  );

  mockStdin.emitChars(["s", "e", "c", "r", "e", "t", "\n"]);

  const password = await promptPromise;
  assert.equal(password, "secret");
  assert.equal(mockStdout.outputs[0], "Password: ");
  assert.equal(mockStdout.outputs[1], "\n");
});

test("promptForPasswordHidden handles backspace", async () => {
  const mockStdin = new MockReadStream();
  const mockStdout = new MockWriteStream();

  const promptPromise = promptForPasswordHidden(
    "Password: ",
    mockStdin as unknown as NodeJS.ReadStream,
    mockStdout as unknown as NodeJS.WriteStream,
  );

  mockStdin.emitChars(["s", "e", "c", "r", "\u007f", "r", "e", "t", "\n"]);

  const password = await promptPromise;
  assert.equal(password, "secret");
});

test("promptForPasswordHidden throws on empty password", async () => {
  const mockStdin = new MockReadStream();
  const mockStdout = new MockWriteStream();

  const promptPromise = promptForPasswordHidden(
    "Password: ",
    mockStdin as unknown as NodeJS.ReadStream,
    mockStdout as unknown as NodeJS.WriteStream,
  );

  mockStdin.emitChars(["\n"]);

  await assert.rejects(promptPromise, /password is required/i);
});

test("promptForPasswordHidden throws on Ctrl+C", async () => {
  const mockStdin = new MockReadStream();
  const mockStdout = new MockWriteStream();

  const promptPromise = promptForPasswordHidden(
    "Password: ",
    mockStdin as unknown as NodeJS.ReadStream,
    mockStdout as unknown as NodeJS.WriteStream,
  );

  mockStdin.emitChars(["s", "e", "c", "\u0003"]);

  await assert.rejects(promptPromise, /cancelled/i);
});
