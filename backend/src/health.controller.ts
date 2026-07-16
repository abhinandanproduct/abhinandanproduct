import { Controller, Get } from '@nestjs/common';
import { Public } from './common/decorators';

/**
 * Health check for Railway / uptime monitors. Public (no JWT needed) —
 * Railway's health check probes this after every deploy and won't route
 * traffic until it returns 200. Same endpoint doubles for external
 * uptime monitors (UptimeRobot, BetterStack, etc.).
 */
@Public()
@Controller('health')
export class HealthController {
  @Get()
  check() {
    return { status: 'ok', at: new Date().toISOString() };
  }
}
