import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DataSource, Repository } from 'typeorm';
import { FilesService } from './files.service.js';
import { FileEntity } from './file.entity.js';
import type { OssService } from '../oss/oss.service.js';
import { ListFilesDto, ListPublicPhotosDto } from './file.dto.js';

describe('FilesService upload lifecycle', () => {
  let file: FileEntity;
  let service: FilesService;
  let repository: {
    findOne: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    findOneBy: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
    createQueryBuilder: ReturnType<typeof vi.fn>;
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
      visibility: 'private',
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
      createQueryBuilder: vi.fn(),
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

  it('always creates private uploads and keeps them private after completion', async () => {
    await service.init({
      fileName: 'photo.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 100,
    });
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: 'private', status: 'pending' }),
    );
    expect((await service.complete(file.id)).visibility).toBe('private');
  });

  it('publishes a ready image and unpublishes it under the existing row lock', async () => {
    file.status = 'ready';
    expect(
      (await service.updateVisibility(file.id, { visibility: 'public' }))
        .visibility,
    ).toBe('public');
    expect(repository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
    await service.publicPhotoDetail(file.id);
    await service.updateVisibility(file.id, { visibility: 'private' });
    await expect(service.publicPhotoDetail(file.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.publicPhotoUrl(file.id, { mode: 'preview' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(cloud.signedUrl).not.toHaveBeenCalled();
    expect((await service.detail(file.id)).visibility).toBe('private');
  });

  it.each([
    { status: 'pending', mediaType: 'image' },
    { status: 'deleting', mediaType: 'image' },
    { status: 'deleted', mediaType: 'image' },
    { status: 'ready', mediaType: 'video' },
    { status: 'ready', mediaType: 'other' },
  ] as const)(
    'rejects publishing unavailable or non-image files: %j',
    async (attributes) => {
      Object.assign(file, attributes);
      await expect(
        service.updateVisibility(file.id, { visibility: 'public' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repository.save).not.toHaveBeenCalled();
    },
  );

  it.each([
    { visibility: 'private', status: 'ready', mediaType: 'image' },
    { visibility: 'public', status: 'pending', mediaType: 'image' },
    { visibility: 'public', status: 'deleting', mediaType: 'image' },
    { visibility: 'public', status: 'deleted', mediaType: 'image' },
    { visibility: 'public', status: 'ready', mediaType: 'video' },
    { visibility: 'public', status: 'ready', mediaType: 'other' },
  ] as const)(
    'hides inaccessible files from public detail and URL requests: %j',
    async (attributes) => {
      Object.assign(file, attributes);
      await expect(service.publicPhotoDetail(file.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(
        service.publicPhotoUrl(file.id, { mode: 'preview' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(cloud.signedUrl).not.toHaveBeenCalled();
    },
  );

  it('returns 404 for a missing public photo without signing a URL', async () => {
    repository.findOneBy.mockResolvedValue(null);
    await expect(service.publicPhotoDetail(file.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.publicPhotoUrl(file.id, { mode: 'preview' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(cloud.signedUrl).not.toHaveBeenCalled();
  });

  it('returns the same public error for missing, private and deleted photos', async () => {
    for (const candidate of [
      null,
      file,
      Object.assign(new FileEntity(), file, { status: 'deleted' }),
    ]) {
      repository.findOneBy.mockResolvedValue(candidate);
      await expect(service.publicPhotoDetail(file.id)).rejects.toThrow(
        'Photo not found',
      );
      await expect(
        service.publicPhotoUrl(file.id, { mode: 'preview' }),
      ).rejects.toThrow('Photo not found');
    }
    expect(cloud.signedUrl).not.toHaveBeenCalled();
  });

  it('exposes only display metadata and signs the checked public image', async () => {
    file.status = 'ready';
    file.visibility = 'public';
    expect(await service.publicPhotoDetail(file.id)).toEqual({
      id: file.id,
      displayName: file.displayName,
      mimeType: file.mimeType,
      mediaType: file.mediaType,
      sizeBytes: file.sizeBytes,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
    });
    expect(
      await service.publicPhotoUrl(file.id, { mode: 'preview' }),
    ).toMatchObject({
      fileId: file.id,
      previewable: true,
      url: 'https://example.invalid/signed',
    });
    expect(cloud.signedUrl).toHaveBeenCalledWith(
      file.bucket,
      file.objectKey,
      file.mimeType,
      file.displayName,
      true,
    );
  });

  it('keeps public SVG downloads as attachments', async () => {
    file.status = 'ready';
    file.visibility = 'public';
    file.mimeType = 'image/svg+xml';
    expect(
      (await service.publicPhotoUrl(file.id, { mode: 'preview' })).previewable,
    ).toBe(false);
    expect(cloud.signedUrl).toHaveBeenCalledWith(
      file.bucket,
      file.objectKey,
      file.mimeType,
      file.displayName,
      false,
    );
  });

  it('public lists enforce visibility, readiness and image type and search only display names', async () => {
    const builder = {
      where: vi.fn().mockReturnThis(),
      andWhere: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      addOrderBy: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      take: vi.fn().mockReturnThis(),
      getManyAndCount: vi.fn().mockResolvedValue([[file], 1]),
    };
    repository.createQueryBuilder.mockReturnValue(builder);
    const result = await service.listPublicPhotos(
      Object.assign(new ListPublicPhotosDto(), {
        page: 2,
        pageSize: 10,
        search: 'a!%_',
      }),
    );
    expect(builder.where).toHaveBeenCalledWith(
      'file.visibility = :visibility',
      { visibility: 'public' },
    );
    expect(builder.andWhere).toHaveBeenCalledWith('file.status = :status', {
      status: 'ready',
    });
    expect(builder.andWhere).toHaveBeenCalledWith('file.mediaType = :type', {
      type: 'image',
    });
    expect(builder.andWhere).toHaveBeenCalledWith(
      "file.displayName LIKE :search ESCAPE '!'",
      { search: '%a!!!%!_%' },
    );
    expect(builder.skip).toHaveBeenCalledWith(10);
    expect(builder.take).toHaveBeenCalledWith(10);
    expect(result).toMatchObject({ total: 1, page: 2, pageSize: 10 });
    for (const key of [
      'originalName',
      'bucket',
      'objectKey',
      'stagingKey',
      'etag',
      'pendingExpiresAt',
      'credentialsExpireAt',
    ])
      expect(result.items[0]).not.toHaveProperty(key);
  });

  it('allows administrators to filter files by visibility', async () => {
    const builder = {
      where: vi.fn().mockReturnThis(),
      andWhere: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      addOrderBy: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      take: vi.fn().mockReturnThis(),
      getManyAndCount: vi.fn().mockResolvedValue([[file], 1]),
    };
    repository.createQueryBuilder.mockReturnValue(builder);
    await service.list(
      Object.assign(new ListFilesDto(), { visibility: 'private' }),
    );
    expect(builder.andWhere).toHaveBeenCalledWith(
      'file.visibility = :visibility',
      { visibility: 'private' },
    );
  });
});
