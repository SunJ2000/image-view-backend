import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

export const Public = () => SetMetadata('public', true);

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (
      this.reflector.getAllAndOverride<boolean>('public', [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    const request = context.switchToHttp().getRequest<Request>();
    const match = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? '');
    const expected = this.config.getOrThrow<string>('ADMIN_API_TOKEN');
    const digest = (value: string) =>
      createHash('sha256').update(value).digest();
    if (!match || !timingSafeEqual(digest(match[1]), digest(expected)))
      throw new UnauthorizedException(
        'Valid administrator bearer token required',
      );
    return true;
  }
}
