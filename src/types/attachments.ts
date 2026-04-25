type AttachmentKind = "file";

export type MessageAttachment = {
  attachmentId: string;
  kind: AttachmentKind;
  fileName: string;
  mimeType?: string;
};

export type SavedAttachment = {
  attachmentId: string;
  kind: AttachmentKind;
  fileName: string;
  hostPath: string;
  mimeType?: string;
};

export type SharedAttachment = {
  attachmentId: string;
  kind: AttachmentKind;
  fileName: string;
  hostPath: string;
  sharePath: string;
  mimeType?: string;
};
