import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, LessThan, Repository } from 'typeorm';
import { OssService, type ObjectMetadata } from '../oss/oss.service.js';
import { FileEntity } from './file.entity.js';
import type {
  FileUrlDto,
  InitUploadDto,
  ListFilesDto,
  ListPublicPhotosDto,
  RenameFileDto,
  UpdateVisibilityDto,
} from './file.dto.js';

export function fileView(file: FileEntity) {
  return {
    id: file.id,
    originalName: file.originalName,
    displayName: file.displayName,
    bucket: file.bucket,
    objectKey: file.objectKey,
    mimeType: file.mimeType,
    mediaType: file.mediaType,
    sizeBytes: file.sizeBytes,
    status: file.status,
    visibility: file.visibility,
    etag: file.etag,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    pendingExpiresAt: file.status === 'pending' ? file.pendingExpiresAt : null,
  };
}

export function publicPhotoView(file: FileEntity) {
  return {
    id: file.id,
    displayName: file.displayName,
    mimeType: file.mimeType,
    mediaType: file.mediaType,
    sizeBytes: file.sizeBytes,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  };
}

@Injectable()
export class FilesService {
  constructor(
    @InjectRepository(FileEntity)
    private readonly files: Repository<FileEntity>,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly oss: OssService,
  ) {}

  async init(dto: InitUploadDto) {
    if (dto.sizeBytes > this.config.getOrThrow<number>('MAX_FILE_SIZE_BYTES'))
      throw new BadRequestException('File exceeds configured maximum size');
    const id = randomUUID();
    const extension =
      /\.[a-zA-Z0-9]{1,10}$/.exec(dto.fileName)?.[0].toLowerCase() ?? '';
    const file = this.files.create({
      id,
      originalName: dto.fileName,
      displayName: dto.fileName,
      bucket: this.oss.bucket,
      stagingKey: `staging/${id}${extension}`,
      objectKey: `files/${id}${extension}`,
      mimeType: dto.mimeType,
      mediaType: dto.mimeType.startsWith('image/')
        ? 'image'
        : dto.mimeType.startsWith('video/')
          ? 'video'
          : 'other',
      sizeBytes: dto.sizeBytes,
      status: 'pending',
      visibility: 'private',
      etag: null,
      deletedAt: null,
      credentialsExpireAt: null,
      pendingExpiresAt: new Date(
        Date.now() +
          this.config.getOrThrow<number>('UPLOAD_SESSION_TTL_SECONDS') * 1000,
      ),
    });
    await this.files.save(file);
    return this.credentials(id);
  }

  private async locked<T>(
    id: string,
    work: (file: FileEntity, repository: Repository<FileEntity>) => Promise<T>,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(FileEntity);
      const file = await repository.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!file) throw new NotFoundException('File not found');
      return work(file, repository);
    });
  }

  async credentials(id: string) {
    return this.locked(id, async (file, repository) => {
      if (
        file.status !== 'pending' ||
        file.pendingExpiresAt.getTime() <= Date.now()
      )
        throw new ConflictException('Upload session is no longer active');
      const upload = await this.oss.issueUploadCredentials(
        file.id,
        file.bucket,
        file.stagingKey,
        file.mimeType,
      );
      file.credentialsExpireAt = new Date(upload.expiresAt);
      // A renewed credential is always accounted for before a session can be cleaned up.
      file.pendingExpiresAt = new Date(
        Math.max(
          file.pendingExpiresAt.getTime(),
          file.credentialsExpireAt.getTime() + 60000,
        ),
      );
      await repository.save(file);
      return {
        file: fileView(file),
        upload,
        maxFileSizeBytes: this.config.getOrThrow<number>('MAX_FILE_SIZE_BYTES'),
      };
    });
  }

  private validateMetadata(file: FileEntity, metadata: ObjectMetadata) {
    if (
      metadata.sizeBytes !== file.sizeBytes ||
      metadata.sizeBytes > this.config.getOrThrow<number>('MAX_FILE_SIZE_BYTES')
    )
      throw new BadRequestException(
        'Actual OSS file size differs from declared size or exceeds the limit',
      );
    if (metadata.mimeType !== file.mimeType)
      throw new BadRequestException(
        'OSS Content-Type differs from declared MIME type',
      );
  }

  async complete(id: string) {
    return this.locked(id, async (file, repository) => {
      if (file.status === 'ready') return fileView(file);
      if (
        file.status !== 'pending' ||
        file.pendingExpiresAt.getTime() <= Date.now()
      )
        throw new ConflictException('Upload session is no longer active');
      const metadata = await this.oss.head(file.bucket, file.stagingKey);
      this.validateMetadata(file, metadata);
      await this.oss.promote(
        file.bucket,
        file.stagingKey,
        file.objectKey,
        metadata,
      );
      const permanent = await this.oss.head(file.bucket, file.objectKey);
      this.validateMetadata(file, permanent);
      file.etag = permanent.etag;
      file.status = 'ready';
      await repository.save(file);
      // staging/ objects are also removed by the bucket lifecycle after credentials expire.
      return fileView(file);
    });
  }

  async list(query: ListFilesDto) {
    const builder = this.files
      .createQueryBuilder('file')
      .where('file.status = :status', { status: query.status });
    if (query.mediaType)
      builder.andWhere('file.mediaType = :type', { type: query.mediaType });
    if (query.visibility)
      builder.andWhere('file.visibility = :visibility', {
        visibility: query.visibility,
      });
    if (query.search)
      builder.andWhere(
        "(file.displayName LIKE :search ESCAPE '!' OR file.originalName LIKE :search ESCAPE '!')",
        { search: `%${query.search.replace(/[!%_]/g, '!$&')}%` },
      );
    const [items, total] = await builder
      .orderBy('file.createdAt', 'DESC')
      .addOrderBy('file.id', 'DESC')
      .skip((query.page - 1) * query.pageSize)
      .take(query.pageSize)
      .getManyAndCount();
    return {
      items: items.map(fileView),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async get(id: string) {
    const file = await this.files.findOneBy({ id });
    if (!file || file.status === 'deleted')
      throw new NotFoundException('File not found');
    return file;
  }

  async detail(id: string) {
    return fileView(await this.get(id));
  }

  async listPublicPhotos(query: ListPublicPhotosDto) {
    const builder = this.files
      .createQueryBuilder('file')
      .where('file.visibility = :visibility', { visibility: 'public' })
      .andWhere('file.status = :status', { status: 'ready' })
      .andWhere('file.mediaType = :type', { type: 'image' });
    if (query.search)
      builder.andWhere("file.displayName LIKE :search ESCAPE '!'", {
        search: `%${query.search.replace(/[!%_]/g, '!$&')}%`,
      });
    const [items, total] = await builder
      .orderBy('file.createdAt', 'DESC')
      .addOrderBy('file.id', 'DESC')
      .skip((query.page - 1) * query.pageSize)
      .take(query.pageSize)
      .getManyAndCount();
    return {
      items: items.map(publicPhotoView),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  private async getPublicPhoto(id: string) {
    const file = await this.files.findOneBy({ id });
    if (
      !file ||
      file.visibility !== 'public' ||
      file.status !== 'ready' ||
      file.mediaType !== 'image'
    )
      throw new NotFoundException('Photo not found');
    return file;
  }

  async publicPhotoDetail(id: string) {
    return publicPhotoView(await this.getPublicPhoto(id));
  }

  async publicPhotoUrl(id: string, query: FileUrlDto) {
    return this.signFileUrl(await this.getPublicPhoto(id), query);
  }

  async updateVisibility(id: string, dto: UpdateVisibilityDto) {
    return this.locked(id, async (file, repository) => {
      if (file.status !== 'pending' && file.status !== 'ready')
        throw new ConflictException(
          'File visibility cannot be changed in its current state',
        );
      if (
        dto.visibility === 'public' &&
        (file.status !== 'ready' || file.mediaType !== 'image')
      )
        throw new ConflictException('Only ready images can be published');
      file.visibility = dto.visibility;
      await repository.save(file);
      return fileView(file);
    });
  }

  async rename(id: string, dto: RenameFileDto) {
    return this.locked(id, async (file, repository) => {
      if (file.status !== 'pending' && file.status !== 'ready')
        throw new ConflictException(
          'File cannot be renamed in its current state',
        );
      file.displayName = dto.displayName;
      await repository.save(file);
      return fileView(file);
    });
  }

  async url(id: string, query: FileUrlDto) {
    const file = await this.get(id);
    if (file.status !== 'ready')
      throw new ConflictException(
        'File is not available for preview or download',
      );
    return this.signFileUrl(file, query);
  }

  private async signFileUrl(file: FileEntity, query: FileUrlDto) {
    // HTML, SVG and unknown formats are downloaded rather than executed in the browser.
    const previewable =
      /^(image\/(jpeg|png|gif|webp|avif|bmp)|video\/(mp4|webm|ogg))$/.test(
        file.mimeType,
      );
    const inline = query.mode === 'preview' && previewable;
    return {
      fileId: file.id,
      previewable,
      ...(await this.oss.signedUrl(
        file.bucket,
        file.objectKey,
        file.mimeType,
        file.displayName,
        inline,
      )),
    };
  }

  async remove(id: string) {
    await this.locked(id, async (file, repository) => {
      if (file.status === 'deleted') return;
      file.status = 'deleting';
      await repository.save(file);
    });
    return this.finishDeletion(id);
  }

  private async finishDeletion(id: string) {
    return this.locked(id, async (file, repository) => {
      if (file.status === 'deleted') return { id, status: 'deleted' };
      if (file.status !== 'deleting')
        throw new ConflictException('File is not being deleted');
      await this.oss.delete(file.bucket, file.objectKey);
      await this.oss.delete(file.bucket, file.stagingKey);
      file.status = 'deleted';
      file.deletedAt = new Date();
      await repository.save(file);
      return { id, status: file.status };
    });
  }

  async cleanup(): Promise<void> {
    const candidates = await this.files.find({
      where: [
        { status: 'pending', pendingExpiresAt: LessThan(new Date()) },
        { status: 'deleting' },
      ],
      take: 50,
      order: { createdAt: 'ASC' },
    });
    for (const candidate of candidates) {
      try {
        await this.locked(candidate.id, async (file, repository) => {
          if (
            file.status === 'pending' &&
            file.pendingExpiresAt.getTime() <= Date.now()
          ) {
            file.status = 'deleting';
            await repository.save(file);
          }
        });
        await this.finishDeletion(candidate.id);
      } catch {
        /* Keep the durable state for the next cleanup pass. */
      }
    }
  }
}
