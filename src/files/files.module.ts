import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OssService } from '../oss/oss.service.js';
import { FileEntity } from './file.entity.js';
import { FilesController, UploadsController } from './files.controller.js';
import { FilesService } from './files.service.js';
import { CleanupService } from './cleanup.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([FileEntity])],
  controllers: [FilesController, UploadsController],
  providers: [OssService, FilesService, CleanupService],
  exports: [OssService],
})
export class FilesModule {}
