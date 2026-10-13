import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AdminAuthGuard } from '../src/auth/admin-auth.guard.js';
import { AppController } from '../src/app.controller.js';
import {
  FilesController,
  PublicPhotosController,
  UploadsController,
} from '../src/files/files.controller.js';
import { FilesService } from '../src/files/files.service.js';
import { OssService } from '../src/oss/oss.service.js';
import { setupApp } from '../src/setup-app.js';

describe('HTTP authentication and validation', () => {
  let app: INestApplication;
  const token = 'test-administrator-token-at-least-32-characters';
  const files = {
    init: vi.fn().mockResolvedValue({ file: { id: 'example' } }),
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    detail: vi.fn(),
    credentials: vi.fn(),
    complete: vi.fn(),
    url: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
    updateVisibility: vi.fn().mockResolvedValue({ visibility: 'public' }),
    listPublicPhotos: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    publicPhotoDetail: vi.fn().mockResolvedValue({ displayName: 'photo' }),
    publicPhotoUrl: vi
      .fn()
      .mockResolvedValue({ url: 'https://example.invalid/signed' }),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60000, limit: 120 }])],
      controllers: [
        AppController,
        FilesController,
        UploadsController,
        PublicPhotosController,
      ],
      providers: [
        {
          provide: ConfigService,
          useValue: new ConfigService({
            ADMIN_API_TOKEN: token,
            CORS_ORIGINS: 'http://localhost:5173',
            ENABLE_SWAGGER: false,
          }),
        },
        {
          provide: DataSource,
          useValue: { query: vi.fn().mockResolvedValue([{ 1: 1 }]) },
        },
        { provide: OssService, useValue: { isConfigured: () => false } },
        { provide: FilesService, useValue: files },
        { provide: APP_GUARD, useClass: AdminAuthGuard },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    setupApp(app);
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => vi.clearAllMocks());
  it('exposes a non-sensitive health check without a token', async () => {
    const result = await request(app.getHttpServer())
      .get('/api/health')
      .expect(200);
    expect(result.body).toEqual({
      status: 'ok',
      database: 'up',
      ossConfigured: false,
    });
  });
  it.each([undefined, 'Bearer invalid', `Basic ${token}`])(
    'rejects invalid authorization: %s',
    async (authorization) => {
      const query = request(app.getHttpServer()).get('/api/files');
      if (authorization) query.set('Authorization', authorization);
      await query.expect(401);
      expect(files.list).not.toHaveBeenCalled();
    },
  );
  it('transforms pagination and applies defaults', async () => {
    await request(app.getHttpServer())
      .get('/api/files?page=2&pageSize=10')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(files.list).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, pageSize: 10, status: 'ready' }),
    );
  });
  it.each([
    { fileName: '../photo.jpg', sizeBytes: 100, mimeType: 'image/jpeg' },
    { fileName: 'photo.jpg', sizeBytes: '100', mimeType: 'image/jpeg' },
    { fileName: 'photo.jpg', sizeBytes: 0, mimeType: 'image/jpeg' },
    {
      fileName: 'photo.jpg',
      sizeBytes: 100,
      mimeType: 'image/jpeg',
      objectKey: 'files/overwrite',
    },
  ])('rejects malformed or injected upload metadata: %j', async (body) => {
    await request(app.getHttpServer())
      .post('/api/uploads/init')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(400);
    expect(files.init).not.toHaveBeenCalled();
  });
  it('accepts valid upload metadata and disables caching', async () => {
    const result = await request(app.getHttpServer())
      .post('/api/uploads/init')
      .set('Authorization', `Bearer ${token}`)
      .send({
        fileName: 'photo.jpg',
        sizeBytes: 100,
        mimeType: 'image/jpeg',
        category: '随手',
      })
      .expect(201);
    expect(files.init).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: 'photo.jpg',
        sizeBytes: 100,
        category: '随手',
      }),
    );
    expect(result.headers['cache-control']).toBe('no-store');
  });
  it('validates UUIDs before calling the service', async () => {
    await request(app.getHttpServer())
      .get('/api/files/not-a-uuid')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
    expect(files.detail).not.toHaveBeenCalled();
  });
  it('allows CORS preflight from the configured Vue origin', async () => {
    const result = await request(app.getHttpServer())
      .options('/api/files')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization')
      .expect(204);
    expect(result.headers['access-control-allow-origin']).toBe(
      'http://localhost:5173',
    );
  });

  const id = '38a427b2-d6ea-4d82-9848-21de8101fae1';

  it('allows anonymous public browsing with validated pagination and no caching', async () => {
    const result = await request(app.getHttpServer())
      .get('/api/public/photos?page=2&pageSize=10&search=旅行')
      .expect(200);
    expect(files.listPublicPhotos).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, pageSize: 10, search: '旅行' }),
    );
    expect(result.headers['cache-control']).toBe('no-store');
    await request(app.getHttpServer())
      .get(`/api/public/photos/${id}`)
      .expect(200);
    expect(files.publicPhotoDetail).toHaveBeenCalledWith(id);
    await request(app.getHttpServer())
      .get(`/api/public/photos/${id}/preview-url?mode=download`)
      .expect(200);
    expect(files.publicPhotoUrl).toHaveBeenCalledWith(
      id,
      expect.objectContaining({ mode: 'download' }),
    );
    expect(files.detail).not.toHaveBeenCalled();
    expect(files.url).not.toHaveBeenCalled();
  });

  it.each([
    'status=pending',
    'visibility=private',
    'mediaType=video',
    'page=0',
    'pageSize=101',
    'page=oops',
    'pageSize=1.5',
    'page=',
  ])(
    'rejects public query injection or invalid pagination: %s',
    async (query) => {
      await request(app.getHttpServer())
        .get(`/api/public/photos?${query}`)
        .expect(400);
      expect(files.listPublicPhotos).not.toHaveBeenCalled();
    },
  );

  it('validates public UUIDs and URL modes before calling the service', async () => {
    await request(app.getHttpServer())
      .get('/api/public/photos/not-a-uuid')
      .expect(400);
    await request(app.getHttpServer())
      .get('/api/public/photos/not-a-uuid/preview-url')
      .expect(400);
    await request(app.getHttpServer())
      .get(`/api/public/photos/${id}/preview-url?mode=other`)
      .expect(400);
    expect(files.publicPhotoDetail).not.toHaveBeenCalled();
    expect(files.publicPhotoUrl).not.toHaveBeenCalled();
  });

  it('allows authenticated administrators to publish and unpublish', async () => {
    for (const visibility of ['public', 'private']) {
      await request(app.getHttpServer())
        .patch(`/api/files/${id}/visibility`)
        .set('Authorization', `Bearer ${token}`)
        .send({ visibility })
        .expect(200);
      expect(files.updateVisibility).toHaveBeenCalledWith(
        id,
        expect.objectContaining({ visibility }),
      );
    }
  });

  it.each([
    {},
    { visibility: 'invalid' },
    { visibility: null },
    { visibility: true },
    { visibility: 'public', status: 'ready' },
  ])('rejects invalid visibility updates: %j', async (body) => {
    await request(app.getHttpServer())
      .patch(`/api/files/${id}/visibility`)
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(400);
    expect(files.updateVisibility).not.toHaveBeenCalled();
  });

  it('keeps every existing file and upload endpoint protected from anonymous requests', async () => {
    await request(app.getHttpServer()).get(`/api/files/${id}`).expect(401);
    await request(app.getHttpServer())
      .get(`/api/files/${id}/preview-url`)
      .expect(401);
    await request(app.getHttpServer())
      .patch(`/api/files/${id}`)
      .send({ displayName: 'rename' })
      .expect(401);
    await request(app.getHttpServer()).delete(`/api/files/${id}`).expect(401);
    await request(app.getHttpServer())
      .patch(`/api/files/${id}/visibility`)
      .send({ visibility: 'public' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/uploads/init')
      .send({ fileName: 'photo.jpg', sizeBytes: 100, mimeType: 'image/jpeg' })
      .expect(401);
    await request(app.getHttpServer())
      .post(`/api/uploads/${id}/credentials`)
      .expect(401);
    await request(app.getHttpServer())
      .post(`/api/uploads/${id}/complete`)
      .expect(401);
    for (const method of [
      'detail',
      'url',
      'rename',
      'remove',
      'updateVisibility',
      'init',
      'credentials',
      'complete',
    ] as const)
      expect(files[method]).not.toHaveBeenCalled();
  });
});
