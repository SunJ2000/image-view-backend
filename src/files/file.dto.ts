/* eslint-disable no-control-regex -- Reject control characters in user-provided file names. */
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { FileStatus, FileVisibility, MediaType } from './file.entity.js';

export class InitUploadDto {
  @ApiProperty({ example: 'photo.jpg' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  @Matches(/^[^\x00-\x1f\x7f/\\]+$/, {
    message: 'fileName must not contain paths or control characters',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  fileName: string;

  @ApiProperty({ example: 102400 })
  @IsInt()
  @Min(1)
  @Max(5368709120)
  sizeBytes: number;

  @ApiProperty({
    example: 'image/jpeg',
    description:
      'Use application/octet-stream when the browser provides no MIME type',
  })
  @IsString()
  @MaxLength(127)
  @Matches(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  mimeType: string;

  @ApiProperty({ example: '旅行', maxLength: 64 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(/^[^\x00-\x1f\x7f/\\]*$/)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  category: string;
}

export class ListPublicPhotosDto {
  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  page = 1;
  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
  @ApiPropertyOptional({ example: '旅行', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[^\x00-\x1f\x7f/\\]*$/)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  category?: string;
}

export class ListFilesDto extends ListPublicPhotosDto {
  @ApiPropertyOptional({ enum: ['private', 'public'] })
  @IsOptional()
  @IsIn(['private', 'public'])
  visibility?: FileVisibility;
  @ApiPropertyOptional({ enum: ['image', 'video', 'other'] })
  @IsOptional()
  @IsIn(['image', 'video', 'other'])
  mediaType?: MediaType;
  @ApiPropertyOptional({
    enum: ['pending', 'ready', 'deleting'],
    default: 'ready',
  })
  @IsIn(['pending', 'ready', 'deleting'])
  status: Exclude<FileStatus, 'deleted'> = 'ready';
}

export class RenameFileDto {
  @ApiProperty({ example: '旅行照片' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  @Matches(/^[^\x00-\x1f\x7f/\\]+$/)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  displayName: string;
}

export class UpdateVisibilityDto {
  @ApiProperty({ enum: ['private', 'public'] })
  @IsIn(['private', 'public'])
  visibility: FileVisibility;
}

export class FileUrlDto {
  @ApiPropertyOptional({ enum: ['preview', 'download'], default: 'preview' })
  @IsIn(['preview', 'download'])
  mode: 'preview' | 'download' = 'preview';
}
