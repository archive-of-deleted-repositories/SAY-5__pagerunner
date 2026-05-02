import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('healthz')
  health(): { ok: true } {
    return { ok: true };
  }

  @Get('readyz')
  ready(): { ok: true } {
    return { ok: true };
  }
}
