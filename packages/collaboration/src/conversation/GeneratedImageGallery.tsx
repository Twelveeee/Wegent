import { useMemo } from "react";
import type { Attachment } from "@wegent/chat-core/runtime";
import type { ProcessingBlock } from "@wegent/chat-core/runtime-conversation";
import { useConversationTranslation } from "./ConversationTranslation";
import {
  AttachmentImageView,
  type AttachmentImageServices,
} from "../issue-detail/AttachmentImageView";

interface GeneratedImageArtifact {
  id: string;
  alt: string;
  mimeType: string;
  fileExtension: string;
  size: number;
  width?: number;
  height?: number;
  src?: string;
  workspaceFile?: Attachment["workspace_file"];
  error?: string;
}

const GENERATED_IMAGE_FILE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
};

function resolveGeneratedImageType(
  mimeType: unknown,
  dataUrl?: string,
): { mimeType: string; fileExtension: string } | null {
  const dataUrlMimeType = /^data:([^;,]+)/i.exec(dataUrl ?? "")?.[1];
  const normalizedMimeType =
    (dataUrlMimeType ?? (typeof mimeType === "string" ? mimeType : "image/png"))
      .split(";", 1)[0]
      .trim()
      .toLowerCase() || "image/png";
  const fileExtension = GENERATED_IMAGE_FILE_EXTENSIONS[normalizedMimeType];
  return fileExtension ? { mimeType: normalizedMimeType, fileExtension } : null;
}

function generatedImageDownloadFilename(
  attachment: Attachment,
  index: number,
): string {
  const extension = attachment.file_extension?.startsWith(".")
    ? attachment.file_extension
    : `.${attachment.file_extension || "png"}`;
  return `generated-image-${index + 1}${extension}`;
}

function generatedImageAttachment(
  image: GeneratedImageArtifact,
  index: number,
): Attachment {
  return {
    id: index + 1,
    filename: image.alt,
    file_size: image.size,
    mime_type: image.mimeType,
    status: "ready",
    file_extension: image.fileExtension,
    created_at: "",
    local_preview_url: image.src,
    workspace_file: image.workspaceFile,
    image_width: image.width,
    image_height: image.height,
  };
}

export function getGeneratedImages(
  blocks: ProcessingBlock[],
  fallbackAlt: string,
): GeneratedImageArtifact[] {
  return [
    ...new Map(blocks.map((block) => [block.id, block])).values(),
  ].flatMap((block): GeneratedImageArtifact[] => {
    if (block.type !== "tool" || block.toolName !== "image_generation")
      return [];
    const payload = block.renderPayload;
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload)
    )
      return [];
    const source = Reflect.get(payload, "source");
    const revisedPrompt = Reflect.get(payload, "revisedPrompt");
    const alt =
      typeof revisedPrompt === "string" && revisedPrompt.trim()
        ? revisedPrompt
        : fallbackAlt;
    if (Reflect.get(payload, "deliveryStatus") === "failed") {
      const error = Reflect.get(payload, "error");
      return [
        {
          id: block.id,
          alt,
          mimeType: "image/png",
          fileExtension: ".png",
          size: 0,
          error:
            typeof error === "string" && error.trim() ? error : fallbackAlt,
        },
      ];
    }
    if (
      typeof source === "object" &&
      source !== null &&
      !Array.isArray(source)
    ) {
      const sourceType = Reflect.get(source, "type");
      const deviceId = Reflect.get(source, "deviceId");
      const workspacePath = Reflect.get(source, "workspacePath");
      const path = Reflect.get(source, "path");
      if (
        sourceType === "workspace_file" &&
        typeof deviceId === "string" &&
        deviceId.trim() &&
        typeof workspacePath === "string" &&
        workspacePath.trim() &&
        typeof path === "string" &&
        path.trim()
      ) {
        const imageType = resolveGeneratedImageType(
          Reflect.get(payload, "mimeType"),
        );
        if (!imageType) return [];
        const size = Reflect.get(payload, "size");
        const width = Reflect.get(payload, "width");
        const height = Reflect.get(payload, "height");
        return [
          {
            id: block.id,
            alt,
            ...imageType,
            size:
              typeof size === "number" && Number.isFinite(size) && size >= 0
                ? size
                : 0,
            width:
              typeof width === "number" && Number.isFinite(width) && width > 0
                ? width
                : undefined,
            height:
              typeof height === "number" &&
              Number.isFinite(height) &&
              height > 0
                ? height
                : undefined,
            workspaceFile: {
              device_id: deviceId,
              workspace_path: workspacePath,
              path,
            },
          },
        ];
      }
    }
    const imageBase64 = Reflect.get(payload, "imageBase64");
    if (typeof imageBase64 !== "string" || !imageBase64.trim()) return [];
    const imageType = resolveGeneratedImageType(
      Reflect.get(payload, "mimeType"),
      imageBase64,
    );
    if (!imageType) return [];
    return [
      {
        id: block.id,
        src: imageBase64.startsWith("data:")
          ? imageBase64
          : `data:${imageType.mimeType};base64,${imageBase64}`,
        alt,
        ...imageType,
        size: 0,
      },
    ];
  });
}

export function GeneratedImageGallery({
  images,
  services,
}: {
  images: GeneratedImageArtifact[];
  services: AttachmentImageServices<Attachment>;
}) {
  const { t } = useConversationTranslation();
  const successfulImages = useMemo(
    () => images.filter((image) => !image.error),
    [images],
  );
  const attachments = useMemo(
    () => successfulImages.map(generatedImageAttachment),
    [successfulImages],
  );

  return (
    <div
      className="mb-3 grid max-w-3xl grid-cols-1 gap-3 sm:grid-cols-2"
      data-testid="generated-image-gallery"
    >
      {images.map((image) =>
        image.error ? (
          <div
            key={image.id}
            role="alert"
            data-testid="generated-image-error"
            className="rounded-lg border border-border bg-surface p-4 text-sm text-text-muted"
          >
            <p>{t("tool_activity.image_generation_delivery_failed")}</p>
            <p className="mt-2 break-words">{image.error}</p>
          </div>
        ) : (
          <GeneratedImagePreview
            services={services}
            key={image.id}
            index={successfulImages.findIndex(
              (candidate) => candidate.id === image.id,
            )}
            galleryAttachments={attachments}
            errorLabel={t("tool_activity.image_generation_read_failed")}
          />
        ),
      )}
    </div>
  );
}

function GeneratedImagePreview({
  services,
  index,
  galleryAttachments,
  errorLabel,
}: {
  index: number;
  galleryAttachments: Attachment[];
  services: AttachmentImageServices<Attachment>;
  errorLabel: string;
}) {
  const attachment = galleryAttachments[index];

  return (
    <AttachmentImageView
      services={services}
      attachment={attachment}
      galleryAttachments={galleryAttachments}
      galleryIndex={index}
      resolveDownloadFilename={generatedImageDownloadFilename}
      buttonTestId="generated-image-preview-button"
      imageTestId="generated-image"
      loadingTestId="generated-image-loading"
      errorTestId="generated-image-error"
      errorLabel={errorLabel}
      imageClassName="h-auto w-full rounded-lg border border-border bg-surface object-contain"
      placeholderClassName="flex min-h-40 w-full items-center justify-center rounded-lg border border-border bg-surface text-text-muted"
      buttonClassName="block w-full cursor-zoom-in p-0 text-left"
    />
  );
}
