import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FilesService } from './files.service.js';

@Injectable()
export class CleanupService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private active = false;
  private readonly logger = new Logger(CleanupService.name);
  constructor(
    private readonly files: FilesService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    if (!this.config.get<boolean>('CLEANUP_ENABLED')) return;
    this.timer = setInterval(() => {
      void this.run();
    }, 60000);
    this.timer.unref();
  }
  private async run() {
    if (this.active) return;
    this.active = true;
    try {
      await this.files.cleanup();
    } catch {
      this.logger.warn('File cleanup pass failed; retrying on next interval');
    } finally {
      this.active = false;
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
