import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

export type MediaType = 'image' | 'video' | 'other';
export type FileStatus = 'pending' | 'ready' | 'deleting' | 'deleted';
export type FileVisibility = 'private' | 'public';
const bigintTransformer = {
  to: (value: number) => value,
  from: (value: string | number) => Number(value),
};

@Entity('files')
@Index('idx_files_status_created', ['status', 'createdAt'])
@Index('idx_files_status_expires', ['status', 'pendingExpiresAt'])
@Index('idx_files_public_gallery', [
  'visibility',
  'status',
  'mediaType',
  'createdAt',
  'id',
])
export class FileEntity {
  @PrimaryColumn({ type: 'char', length: 36 }) id: string;
  @Column({ type: 'varchar', length: 255 }) originalName: string;
  @Column({ type: 'varchar', length: 255 }) displayName: string;
  @Column({ type: 'varchar', length: 63 }) bucket: string;
  @Column({ type: 'varchar', length: 512, unique: true }) objectKey: string;
  @Column({ type: 'varchar', length: 512, unique: true }) stagingKey: string;
  @Column({ type: 'varchar', length: 127 }) mimeType: string;
  @Column({ type: 'varchar', length: 10 }) mediaType: MediaType;
  @Column({ type: 'bigint', transformer: bigintTransformer }) sizeBytes: number;
  @Column({ type: 'varchar', length: 10, default: 'pending' })
  status: FileStatus;
  @Column({ type: 'varchar', length: 7, default: 'private' })
  visibility: FileVisibility;
  @Column({ type: 'varchar', length: 128, nullable: true }) etag: string | null;
  @Column({ type: 'datetime', precision: 3 }) pendingExpiresAt: Date;
  @Column({ type: 'datetime', precision: 3, nullable: true })
  credentialsExpireAt: Date | null;
  @CreateDateColumn({ type: 'datetime', precision: 3 }) createdAt: Date;
  @UpdateDateColumn({ type: 'datetime', precision: 3 }) updatedAt: Date;
  @Column({ type: 'datetime', precision: 3, nullable: true })
  deletedAt: Date | null;
}
