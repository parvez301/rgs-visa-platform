import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const PRESIGN_EXPIRY_SECONDS = 15 * 60;
export const ALLOWED_UPLOAD_CONTENT_TYPES = ["image/jpeg", "image/png", "application/pdf"] as const;
export type AllowedUploadContentType = (typeof ALLOWED_UPLOAD_CONTENT_TYPES)[number];

export interface DocumentStore {
  presignUpload(objectKey: string, contentType: AllowedUploadContentType): Promise<string>;
  presignDownload(objectKey: string): Promise<string>;
}

export class S3DocumentStore implements DocumentStore {
  constructor(
    private readonly bucketName: string,
    private readonly s3Client: S3Client = new S3Client({}),
  ) {}

  async presignUpload(objectKey: string, contentType: AllowedUploadContentType): Promise<string> {
    return getSignedUrl(
      this.s3Client,
      new PutObjectCommand({ Bucket: this.bucketName, Key: objectKey, ContentType: contentType }),
      { expiresIn: PRESIGN_EXPIRY_SECONDS },
    );
  }

  async presignDownload(objectKey: string): Promise<string> {
    return getSignedUrl(
      this.s3Client,
      new GetObjectCommand({ Bucket: this.bucketName, Key: objectKey }),
      { expiresIn: PRESIGN_EXPIRY_SECONDS },
    );
  }
}

/** Test adapter — returns deterministic fake URLs and records calls. */
export class InMemoryDocumentStore implements DocumentStore {
  readonly uploadCalls: Array<{ objectKey: string; contentType: string }> = [];
  readonly downloadCalls: string[] = [];

  async presignUpload(objectKey: string, contentType: AllowedUploadContentType): Promise<string> {
    this.uploadCalls.push({ objectKey, contentType });
    return `https://fake-s3.local/upload/${objectKey}?contentType=${encodeURIComponent(contentType)}`;
  }

  async presignDownload(objectKey: string): Promise<string> {
    this.downloadCalls.push(objectKey);
    return `https://fake-s3.local/download/${objectKey}`;
  }
}
