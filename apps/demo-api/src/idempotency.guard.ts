import { BadRequestException, CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';

/**
 * `Idempotency-Key` WAJIB pada setiap endpoint pengubah-dana (CLAUDE.md § Konvensi).
 * Host yang generate key-nya.
 */
@Injectable()
export class IdempotencyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!req.header('Idempotency-Key')) {
      throw new BadRequestException('Idempotency-Key header wajib untuk endpoint pengubah-dana');
    }
    return true;
  }
}
