import {
  BadGatewayException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OSS from 'ali-oss';

export interface ObjectMetadata {
  sizeBytes: number;
  mimeType: string;
  etag: string;
}
export interface UploadCredentials {
  mode: 'sts';
  headers: { 'x-oss-object-acl': 'private' };
  accessKeyId: string;
  accessKeySecret: string;
  stsToken: string;
  expiresAt: string;
  region: string;
  endpoint: string;
  bucket: string;
  objectKey: string;
}

export interface SignedPutUpload {
  mode: 'signed-put';
  method: 'PUT';
  url: string;
  headers: { 'Content-Type': string; 'x-oss-object-acl': 'private' };
  expiresAt: string;
  region: string;
  endpoint: string;
  bucket: string;
  objectKey: string;
}

export function uploadPolicy(bucket: string, objectKey: string) {
  return {
    Version: '1',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['oss:PutObject', 'oss:ListParts', 'oss:AbortMultipartUpload'],
        Resource: [`acs:oss:*:*:${bucket}/${objectKey}`],
      },
    ],
  };
}

@Injectable()
export class OssService {
  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return ['OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET', 'OSS_BUCKET'].every(
      (key) => Boolean(this.config.get<string>(key)),
    );
  }

  get bucket(): string {
    this.ensureConfigured();
    return this.config.getOrThrow<string>('OSS_BUCKET');
  }

  private ensureConfigured() {
    if (!this.isConfigured())
      throw new ServiceUnavailableException(
        'Configure OSS_BUCKET, OSS_ACCESS_KEY_ID and OSS_ACCESS_KEY_SECRET first',
      );
  }

  private client(bucket: string): OSS {
    this.ensureConfigured();
    return new OSS({
      accessKeyId: this.config.getOrThrow<string>('OSS_ACCESS_KEY_ID'),
      accessKeySecret: this.config.getOrThrow<string>('OSS_ACCESS_KEY_SECRET'),
      endpoint: this.config.getOrThrow<string>('OSS_ENDPOINT'),
      region: this.config.getOrThrow<string>('OSS_REGION'),
      bucket,
      secure: true,
      authorizationV4: true,
      timeout: 60000,
    });
  }

  async issueUploadCredentials(
    id: string,
    bucket: string,
    objectKey: string,
    mimeType: string,
  ): Promise<UploadCredentials | SignedPutUpload> {
    this.ensureConfigured();
    if (!this.config.get<string>('OSS_STS_ROLE_ARN')) {
      const ttl = this.config.getOrThrow<number>('UPLOAD_URL_TTL_SECONDS');
      const headers = {
        'Content-Type': mimeType,
        'x-oss-object-acl': 'private' as const,
      };
      try {
        const url = await this.client(bucket).signatureUrlV4(
          'PUT',
          ttl,
          { headers },
          objectKey,
        );
        return {
          mode: 'signed-put',
          method: 'PUT',
          url,
          headers,
          expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
          region: this.config.getOrThrow<string>('OSS_REGION'),
          endpoint: this.config.getOrThrow<string>('OSS_ENDPOINT'),
          bucket,
          objectKey,
        };
      } catch {
        throw new BadGatewayException('Unable to sign OSS upload URL');
      }
    }
    const sts = new OSS.STS({
      accessKeyId: this.config.getOrThrow<string>('OSS_ACCESS_KEY_ID'),
      accessKeySecret: this.config.getOrThrow<string>('OSS_ACCESS_KEY_SECRET'),
    });
    try {
      const { credentials } = await sts.assumeRole(
        this.config.getOrThrow<string>('OSS_STS_ROLE_ARN'),
        uploadPolicy(bucket, objectKey),
        this.config.getOrThrow<number>('OSS_STS_DURATION_SECONDS'),
        `upload-${id}`,
      );
      return {
        mode: 'sts',
        headers: { 'x-oss-object-acl': 'private' },
        accessKeyId: credentials.AccessKeyId,
        accessKeySecret: credentials.AccessKeySecret,
        stsToken: credentials.SecurityToken,
        expiresAt: credentials.Expiration,
        region: this.config.getOrThrow<string>('OSS_REGION'),
        endpoint: this.config.getOrThrow<string>('OSS_ENDPOINT'),
        bucket,
        objectKey,
      };
    } catch {
      throw new BadGatewayException(
        'Unable to issue OSS upload credentials; check RAM and STS configuration',
      );
    }
  }

  async head(bucket: string, key: string): Promise<ObjectMetadata> {
    const client = this.client(bucket);
    try {
      const result = await client.head(key);
      const headers = result.res.headers as Record<string, string | undefined>;
      const sizeBytes = Number(headers['content-length']);
      const mimeType = String(headers['content-type'] ?? '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      const etag = String(headers.etag ?? '');
      if (
        !Number.isSafeInteger(sizeBytes) ||
        sizeBytes < 1 ||
        !mimeType ||
        !etag
      )
        throw new Error('Invalid metadata');
      return { sizeBytes, mimeType, etag };
    } catch (error) {
      if ((error as { code?: string }).code === 'NoSuchKey')
        throw new ConflictException(
          'OSS object does not exist yet; finish uploading first',
        );
      throw new BadGatewayException('Unable to verify OSS object');
    }
  }

  async promote(
    bucket: string,
    source: string,
    destination: string,
    metadata: ObjectMetadata,
  ): Promise<void> {
    const client = this.client(bucket);
    const headers = {
      'Content-Type': metadata.mimeType,
      'x-oss-object-acl': 'private',
    };
    const condition = { 'x-oss-copy-source-if-match': metadata.etag };
    let uploadId: string | undefined;
    try {
      if (metadata.sizeBytes <= 1024 * 1024 * 1024) {
        await client.copy(destination, source, {
          headers: {
            ...headers,
            ...condition,
            'x-oss-metadata-directive': 'REPLACE',
          },
        });
      } else {
        // Copy large videos entirely inside OSS; no media bytes pass through NestJS.
        uploadId = (
          await client.initMultipartUpload(destination, {
            mime: metadata.mimeType,
            headers,
          })
        ).uploadId;
        const parts: { number: number; etag: string }[] = [];
        const partSize = 64 * 1024 * 1024;
        for (let start = 0; start < metadata.sizeBytes; start += partSize) {
          const number = parts.length + 1;
          const result = await client.uploadPartCopy(
            destination,
            uploadId,
            number,
            `${start}-${Math.min(start + partSize, metadata.sizeBytes) - 1}`,
            { sourceKey: source, sourceBucketName: bucket },
            { headers: condition },
          );
          parts.push({ number, etag: result.etag });
        }
        await client.completeMultipartUpload(destination, uploadId, parts);
      }
    } catch (error) {
      if (uploadId) {
        try {
          await client.abortMultipartUpload(destination, uploadId);
        } catch {
          /* OSS lifecycle is the fallback. */
        }
      }
      if ((error as { status?: number }).status === 412)
        throw new ConflictException(
          'Uploaded object changed during validation; retry completion',
        );
      throw new BadGatewayException(
        'Unable to finalize OSS object; retry completion',
      );
    }
  }

  async delete(bucket: string, key: string): Promise<void> {
    const client = this.client(bucket);
    try {
      await client.delete(key);
    } catch (error) {
      if ((error as { code?: string }).code !== 'NoSuchKey')
        throw new BadGatewayException(
          'Unable to delete OSS object; deletion will be retried',
        );
    }
  }

  async signedUrl(
    bucket: string,
    key: string,
    _mimeType: string,
    name: string,
    inline: boolean,
  ) {
    const client = this.client(bucket);
    const ttl = this.config.getOrThrow<number>('PREVIEW_URL_TTL_SECONDS');
    const disposition = `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`;
    try {
      const url = await client.signatureUrlV4(
        'GET',
        ttl,
        {
          queries: {
            // OSS rejects response-content-type overrides. Completion already
            // verifies and stores the object's actual Content-Type.
            'response-content-disposition': disposition,
            'response-cache-control': 'private, no-store',
          },
        },
        key,
      );
      return {
        url,
        expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
        disposition: inline ? 'inline' : 'attachment',
      };
    } catch {
      throw new BadGatewayException('Unable to sign OSS URL');
    }
  }
}
