import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DataSource, Repository } from 'typeorm';
import { FilesService } from './files.service.js';
import { FileEntity } from './file.entity.js';
import type { OssService } from '../oss/oss.service.js';

describe('FilesService upload lifecycle', () => {
  let file: FileEntity;
  let service: FilesService;
  let repository: {
    findOne: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    findOneBy: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
  };
  let cloud: {
    bucket: string;
    head: ReturnType<typeof vi.fn>;
    promote: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    issueUploadCredentials: ReturnType<typeof vi.fn>;
    signedUrl: ReturnType<typeof vi.fn>;
  };
  beforeEach(() => {
    file = Object.assign(new FileEntity(), {
      id: '38a427b2-d6ea-4d82-9848-21de8101fae1',
      status: 'pending',
      bucket: 'example-bucket',
      objectKey: 'files/test.jpg',
      stagingKey: 'staging/test.jpg',
      originalName: 'test.jpg',
      displayName: 'test.jpg',
      mimeType: 'image/jpeg',
      mediaType: 'image',
      sizeBytes: 100,
      etag: null,
      pendingExpiresAt: new Date(Date.now() + 86400000),
    });
    repository = {
      findOne: vi.fn().mockImplementation(() => file),
      save: vi.fn().mockImplementation((value) => value),
      create: vi.fn().mockImplementation((value) => value),
      findOneBy: vi.fn().mockImplementation(() => file),
      find: vi.fn().mockResolvedValue([file]),
    };
    const dataSource = {
      transaction: vi
        .fn()
        .mockImplementation((callback) =>
          callback({ getRepository: () => repository }),
        ),
    };
    cloud = {
      bucket: 'example-bucket',
      head: vi.fn().mockResolvedValue({
        sizeBytes: 100,
        mimeType: 'image/jpeg',
        etag: 'etag',
      }),
      promote: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      issueUploadCredentials: vi.fn().mockResolvedValue({
        expiresAt: new Date(Date.now() + 900000).toISOString(),
        objectKey: file.stagingKey,
      }),
      signedUrl: vi.fn().mockResolvedValue({
        url: 'https://example.invalid/signed',
        expiresAt: 'later',
      }),
    };
    service = new FilesService(
      repository as unknown as Repository<FileEntity>,
      dataSource as unknown as DataSource,
      new ConfigService({
        MAX_FILE_SIZE_BYTES: 5368709120,
        UPLOAD_SESSION_TTL_SECONDS: 86400,
      }),
      cloud as unknown as OssService,
    );
  });

  it('issues credentials for the staging key, never the permanent object', async () => {
    const result = await service.credentials(file.id);
    expect(cloud.issueUploadCredentials).toHaveBeenCalledWith(
      file.id,
      file.bucket,
      file.stagingKey,
      file.mimeType,
    );
    expect(repository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
    expect(result.file).not.toHaveProperty('stagingKey');
    expect(file.credentialsExpireAt).toBeInstanceOf(Date);
  });
  it('rejects renewal for a completed or expired session', async () => {
    file.status = 'ready';
    await expect(service.credentials(file.id)).rejects.toBeInstanceOf(
      ConflictException,
    );
    file.status = 'pending';
    file.pendingExpiresAt = new Date(0);
    await expect(service.credentials(file.id)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(cloud.issueUploadCredentials).not.toHaveBeenCalled();
  });
  it('validates metadata and promotes before marking ready', async () => {
    const result = await service.complete(file.id);
    expect(cloud.head.mock.calls).toEqual([
      [file.bucket, file.stagingKey],
      [file.bucket, file.objectKey],
    ]);
    expect(cloud.promote).toHaveBeenCalledWith(
      file.bucket,
      file.stagingKey,
      file.objectKey,
      expect.objectContaining({ etag: 'etag' }),
    );
    expect(result.status).toBe('ready');
    expect(file.etag).toBe('etag');
  });
  it.each([
    { sizeBytes: 101, mimeType: 'image/jpeg', etag: 'etag' },
    { sizeBytes: 100, mimeType: 'video/mp4', etag: 'etag' },
  ])('rejects a mismatching uploaded object: %j', async (metadata) => {
    cloud.head.mockResolvedValue(metadata);
    await expect(service.complete(file.id)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(cloud.promote).not.toHaveBeenCalled();
    expect(file.status).toBe('pending');
  });
  it('completion is idempotent and never recopies ready media', async () => {
    file.status = 'ready';
    await expect(service.complete(file.id)).resolves.toMatchObject({
      status: 'ready',
    });
    expect(cloud.head).not.toHaveBeenCalled();
    expect(cloud.promote).not.toHaveBeenCalled();
  });
  it('will not preview a pending upload', async () => {
    await expect(
      service.url(file.id, { mode: 'preview' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(cloud.signedUrl).not.toHaveBeenCalled();
  });
  it('forces active-content formats to download', async () => {
    file.status = 'ready';
    file.mimeType = 'image/svg+xml';
    const result = await service.url(file.id, { mode: 'preview' });
    expect(result.previewable).toBe(false);
    expect(cloud.signedUrl).toHaveBeenCalledWith(
      file.bucket,
      file.objectKey,
      file.mimeType,
      file.displayName,
      false,
    );
  });
  it('retains a retryable deleting state if OSS fails, then cleanup finishes deletion', async () => {
    file.status = 'ready';
    cloud.delete.mockRejectedValueOnce(new BadGatewayException());
    await expect(service.remove(file.id)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(file.status).toBe('deleting');
    await service.cleanup();
    expect(file.status).toBe('deleted');
    expect(file.deletedAt).toBeInstanceOf(Date);
  });
  it('does not delete an upload that was renewed after the cleanup scan', async () => {
    await service.cleanup();
    expect(cloud.delete).not.toHaveBeenCalled();
    expect(file.status).toBe('pending');
  });
  it('rejects files above the configured size before creating any record', async () => {
    await expect(
      service.init({
        fileName: 'huge.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 5368709121,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.save).not.toHaveBeenCalled();
  });
});
