import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OSS from 'ali-oss';
import { OssService, uploadPolicy } from './oss.service.js';

describe('OSS authorization and finalization', () => {
  let service: OssService;
  let config: ConfigService;
  beforeEach(() => {
    config = new ConfigService({
      OSS_ACCESS_KEY_ID: 'test-id',
      OSS_ACCESS_KEY_SECRET: 'test-secret',
      OSS_BUCKET: 'example-bucket',
      OSS_STS_ROLE_ARN: 'test-role',
      OSS_REGION: 'oss-cn-hangzhou',
      OSS_ENDPOINT: 'https://oss-cn-hangzhou.aliyuncs.com',
      PREVIEW_URL_TTL_SECONDS: 3600,
      UPLOAD_URL_TTL_SECONDS: 900,
      OSS_STS_DURATION_SECONDS: 900,
    });
    service = new OssService(config);
  });
  afterEach(() => vi.restoreAllMocks());
  it('authorizes a signed PUT without a role and never returns a long-term secret', async () => {
    config.set('OSS_STS_ROLE_ARN', '');
    const assumeRole = vi.spyOn(OSS.STS.prototype, 'assumeRole');
    expect(service.isConfigured()).toBe(true);
    const upload = await service.issueUploadCredentials(
      'test-id',
      'example-bucket',
      'staging/test.jpg',
      'image/jpeg',
    );
    expect(upload.mode).toBe('signed-put');
    if (upload.mode !== 'signed-put') throw new Error('Expected signed PUT');
    expect(upload.method).toBe('PUT');
    expect(upload.headers).toEqual({
      'Content-Type': 'image/jpeg',
      'x-oss-object-acl': 'private',
    });
    expect(new URL(upload.url).pathname).toBe('/staging/test.jpg');
    expect(new URL(upload.url).searchParams.get('x-oss-expires')).toBe('900');
    expect(upload).not.toHaveProperty('accessKeySecret');
    expect(JSON.stringify(upload)).not.toContain('test-secret');
    expect(assumeRole).not.toHaveBeenCalled();
  });
  it('signs the declared Content-Type into the PUT authorization', async () => {
    config.set('OSS_STS_ROLE_ARN', '');
    const sign = vi.spyOn(OSS.prototype, 'signatureUrlV4');
    await service.issueUploadCredentials(
      'test-id',
      'example-bucket',
      'staging/test.jpg',
      'image/jpeg',
    );
    expect(sign).toHaveBeenCalledWith(
      'PUT',
      900,
      {
        headers: {
          'Content-Type': 'image/jpeg',
          'x-oss-object-acl': 'private',
        },
      },
      'staging/test.jpg',
    );
  });
  it('continues to issue scoped temporary credentials when a role is configured', async () => {
    const assumeRole = vi
      .spyOn(OSS.STS.prototype, 'assumeRole')
      .mockResolvedValue({
        credentials: {
          AccessKeyId: 'temporary-id',
          AccessKeySecret: 'temporary-secret',
          SecurityToken: 'temporary-token',
          Expiration: new Date(Date.now() + 900000).toISOString(),
        },
      });
    const upload = await service.issueUploadCredentials(
      'test-id',
      'example-bucket',
      'staging/test.jpg',
      'image/jpeg',
    );
    expect(upload.mode).toBe('sts');
    expect(upload).toMatchObject({
      accessKeyId: 'temporary-id',
      accessKeySecret: 'temporary-secret',
      headers: { 'x-oss-object-acl': 'private' },
    });
    expect(assumeRole).toHaveBeenCalledWith(
      'test-role',
      uploadPolicy('example-bucket', 'staging/test.jpg'),
      900,
      'upload-test-id',
    );
  });
  it('generates an HTTPS V4 preview URL with signed response headers without a cloud request', async () => {
    const result = await service.signedUrl(
      'example-bucket',
      'files/a.jpg',
      'image/jpeg',
      "旅行'照片.jpg",
      true,
    );
    const url = new URL(result.url);
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('example-bucket.oss-cn-hangzhou.aliyuncs.com');
    expect(url.searchParams.get('x-oss-signature-version')).toBe(
      'OSS4-HMAC-SHA256',
    );
    expect(url.searchParams.get('x-oss-expires')).toBe('3600');
    expect(url.searchParams.has('response-content-type')).toBe(false);
    expect(url.searchParams.get('response-content-disposition')).toContain(
      '%27',
    );
    expect(result.disposition).toBe('inline');
  });
  it('limits upload permissions to one exact object without list/read/delete permission', () => {
    const policy = uploadPolicy('example-bucket', 'staging/test.mp4');
    expect(policy.Statement[0].Resource).toEqual([
      'acs:oss:*:*:example-bucket/staging/test.mp4',
    ]);
    expect(policy.Statement[0].Action).toEqual([
      'oss:PutObject',
      'oss:ListParts',
      'oss:AbortMultipartUpload',
    ]);
  });
  it('uses a conditional private copy for small objects', async () => {
    const copy = vi.spyOn(OSS.prototype, 'copy').mockResolvedValue({} as never);
    await service.promote('example-bucket', 'staging/a.jpg', 'files/a.jpg', {
      sizeBytes: 100,
      mimeType: 'image/jpeg',
      etag: 'etag',
    });
    expect(copy).toHaveBeenCalledWith('files/a.jpg', 'staging/a.jpg', {
      headers: expect.objectContaining({
        'x-oss-copy-source-if-match': 'etag',
        'x-oss-object-acl': 'private',
      }),
    });
  });
  it('copies a video larger than 1GiB in contiguous parts without downloading it', async () => {
    vi.spyOn(OSS.prototype, 'initMultipartUpload').mockResolvedValue({
      uploadId: 'copy-id',
    } as never);
    const copyPart = vi
      .spyOn(OSS.prototype, 'uploadPartCopy')
      .mockResolvedValue({ etag: 'part-etag' } as never);
    const complete = vi
      .spyOn(OSS.prototype, 'completeMultipartUpload')
      .mockResolvedValue({} as never);
    await service.promote('example-bucket', 'staging/a.mp4', 'files/a.mp4', {
      sizeBytes: 1024 * 1024 * 1024 + 1,
      mimeType: 'video/mp4',
      etag: 'source-etag',
    });
    expect(copyPart).toHaveBeenCalledTimes(17);
    expect(copyPart.mock.calls[0][3]).toBe('0-67108863');
    expect(copyPart.mock.calls[16][3]).toBe('1073741824-1073741824');
    expect(copyPart.mock.calls[0][5]).toEqual({
      headers: { 'x-oss-copy-source-if-match': 'source-etag' },
    });
    expect(complete.mock.calls[0][2]).toHaveLength(17);
  });
  it('aborts an incomplete copy if the source changes', async () => {
    vi.spyOn(OSS.prototype, 'initMultipartUpload').mockResolvedValue({
      uploadId: 'copy-id',
    } as never);
    vi.spyOn(OSS.prototype, 'uploadPartCopy').mockRejectedValue({
      status: 412,
    });
    const abort = vi
      .spyOn(OSS.prototype, 'abortMultipartUpload')
      .mockResolvedValue({} as never);
    await expect(
      service.promote('example-bucket', 'staging/a.mp4', 'files/a.mp4', {
        sizeBytes: 1024 * 1024 * 1024 + 1,
        mimeType: 'video/mp4',
        etag: 'source-etag',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(abort).toHaveBeenCalledWith('files/a.mp4', 'copy-id');
  });
});
