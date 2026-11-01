import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand, HeadBucketCommand, CreateBucketCommand } from '@aws-sdk/client-s3';
import type { Storage } from './index.js';
import { NotFoundInStorage } from './index.js';

export interface S3Options {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
}

export class S3Storage implements Storage {
  private client: S3Client;
  private bucket: string;
  private bucketChecked = false;

  constructor(o: S3Options) {
    this.bucket = o.bucket;
    this.client = new S3Client({
      region: o.region,
      endpoint: o.endpoint,
      forcePathStyle: o.forcePathStyle,
      credentials: o.accessKeyId && o.secretAccessKey ? { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey } : undefined,
    });
  }

  /** Creates the bucket on first use if it doesn't exist (convenient for MinIO). */
  private async ensureBucket() {
    if (this.bucketChecked) return;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (e: any) {
      if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound') {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      } else throw e;
    }
    this.bucketChecked = true;
  }

  async put(key: string, body: Buffer | string, contentType?: string): Promise<void> {
    await this.ensureBucket();
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async get(key: string): Promise<Buffer> {
    await this.ensureBucket();
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return Buffer.from(await r.Body!.transformToByteArray());
    } catch (e: any) {
      if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) throw new NotFoundInStorage(key);
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await this.ensureBucket();
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async exists(key: string): Promise<boolean> {
    await this.ensureBucket();
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (e: any) {
      if (e?.$metadata?.httpStatusCode === 404) return false;
      throw e;
    }
  }

  async ping(): Promise<void> {
    this.bucketChecked = false;
    await this.ensureBucket();
  }
}
