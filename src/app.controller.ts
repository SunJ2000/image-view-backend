import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { Public } from './auth/admin-auth.guard.js';
import { OssService } from './oss/oss.service.js';

@Controller()
@ApiTags('health')
export class AppController {
  constructor(
    private readonly database: DataSource,
    private readonly oss: OssService,
  ) {}

  @Public()
  @Get('health')
  async health() {
    try {
      await this.database.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException('Database unavailable');
    }
    return {
      status: 'ok',
      database: 'up',
      ossConfigured: this.oss.isConfigured(),
    };
  }
}
