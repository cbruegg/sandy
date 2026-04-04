import { randomUUID } from "node:crypto";
import { parsePrivilegeRequest, type PrivilegeRequest } from "../types.js";
import { sharedWorkspaceMountPath } from "../shared-workspace.js";

export const privilegeRequestPrefix = "SANDY_PRIVILEGE_REQUEST ";
export const channelFilePrefix = "SANDY_CHANNEL_FILE ";

const privilegeRequestSchemaText = '{"type":"copy_into_share"|"copy_out_of_share","sourcePath":"string","targetPath":"string","reason":"string"}';
const channelFileSchemaText = '{"path":"string","caption":"string optional"}';

export function buildWorkerProtocolInstructions(): string[] {
  return [
    "Protocol requirements for host-mediated actions:",
    `- For privileged host file copy requests, output exactly one line with no surrounding text: ${privilegeRequestPrefix}{...json...}`,
    `- JSON schema for ${privilegeRequestPrefix}: ${privilegeRequestSchemaText}`,
    "Allowed host-mediated request types are copy_into_share and copy_out_of_share.",
    `For any host-mediated request, use absolute paths. Any shared-workspace path must stay under ${sharedWorkspaceMountPath}.`,
    `Example for copying a result file to Downloads: ${privilegeRequestPrefix}{"type":"copy_out_of_share","sourcePath":"${sharedWorkspaceMountPath}/result.txt","targetPath":"~/Downloads/result.txt","reason":"Need to deliver the generated file to the user."}`,
    `Example for copying a host file in: ${privilegeRequestPrefix}{"type":"copy_into_share","sourcePath":"~/Downloads/input.txt","targetPath":"${sharedWorkspaceMountPath}/input.txt","reason":"Need the user-provided input file inside the task workspace."}`,
    `- To send a file that already exists under ${sharedWorkspaceMountPath} back to the user, output exactly one line with no surrounding text: ${channelFilePrefix}{...json...}`,
    `- JSON schema for ${channelFilePrefix}: ${channelFileSchemaText}`,
    `Sending a file from ${sharedWorkspaceMountPath} back to the user through the channel does not require privilege escalation.`,
    "Do not describe the saved path in prose when you want the file delivered. Emit the protocol line instead.",
    `Example for sending a file to the user: ${channelFilePrefix}{"path":"${sharedWorkspaceMountPath}/result.txt","caption":"Generated result file."}`,
    "After emitting a host-mediated request, stop and wait for the next host message before continuing.",
  ];
}

export function parsePrivilegeRequestMessage(text: string): PrivilegeRequest | null {
  const rawPayload = extractPayload(text, privilegeRequestPrefix);
  if (!rawPayload) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawPayload) as unknown;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Privilege request payload must be a JSON object.");
    }
    return parsePrivilegeRequest({
      ...(parsed as Record<string, unknown>),
      requestId: randomUUID(),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown privilege request parse failure.";
    throw new Error(`${detail} Payload: ${rawPayload}`, { cause: error });
  }
}

export function parseChannelFileMessage(text: string): { path: string; caption?: string } | null {
  const rawPayload = extractPayload(text, channelFilePrefix);
  if (!rawPayload) {
    return null;
  }

  const parsed = JSON.parse(rawPayload) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Channel file payload must be a JSON object.");
  }

  const path = "path" in parsed ? parsed.path : undefined;
  const caption = "caption" in parsed ? parsed.caption : undefined;
  if (typeof path !== "string" || (caption !== undefined && typeof caption !== "string")) {
    throw new Error("Channel file payload must contain a string path and optional string caption.");
  }

  return {
    path,
    caption,
  };
}

function extractPayload(text: string, prefix: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(prefix)) {
    return null;
  }
  return trimmed.slice(prefix.length).trim();
}
