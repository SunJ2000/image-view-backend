import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { FilesService } from './files.service.js';
import {
  FileUrlDto,
  InitUploadDto,
  ListFilesDto,
  ListPublicPhotosDto,
  RenameFileDto,
  UpdateVisibilityDto,
} from './file.dto.js';
import { Public } from '../auth/admin-auth.guard.js';

@ApiTags('uploads')
@ApiBearerAuth()
@Controller('uploads')
export class UploadsController {
  constructor(private readonly files: FilesService) {}

  @Post('init')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary:
      'Create an upload session and receive a signed PUT URL or object-scoped STS credentials',
  })
  init(@Body() dto: InitUploadDto) {
    return this.files.init(dto);
  }

  @Post(':id/credentials')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'Renew a signed PUT URL or STS credentials for a pending upload',
  })
  credentials(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.files.credentials(id);
  }

  @Post(':id/complete')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Validate and finalize the uploaded OSS object (idempotent)',
  })
  complete(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.files.complete(id);
  }
}

@ApiTags('files')
@ApiBearerAuth()
@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Get() list(@Query() query: ListFilesDto) {
    return this.files.list(query);
  }
  @Get(':id') detail(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.files.detail(id);
  }
  @Get(':id/preview-url')
  url(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: FileUrlDto,
  ) {
    return this.files.url(id, query);
  }
  @Patch(':id')
  rename(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: RenameFileDto,
  ) {
    return this.files.rename(id, dto);
  }
  @Delete(':id')
  remove(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.files.remove(id);
  }

  @Patch(':id/visibility')
  @ApiOperation({ summary: 'Publish a ready image or make a file private' })
  visibility(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateVisibilityDto,
  ) {
    return this.files.updateVisibility(id, dto);
  }
}

@ApiTags('public photos')
@Public()
@Controller('public/photos')
export class PublicPhotosController {
  constructor(private readonly files: FilesService) {}

  @Get()
  @ApiOperation({
    summary: 'List published images without administrator credentials',
  })
  list(@Query() query: ListPublicPhotosDto) {
    return this.files.listPublicPhotos(query);
  }

  @Get(':id')
  detail(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.files.publicPhotoDetail(id);
  }

  @Get(':id/preview-url')
  @ApiOperation({ summary: 'Get a temporary URL for a published image' })
  url(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: FileUrlDto,
  ) {
    return this.files.publicPhotoUrl(id, query);
  }
}
