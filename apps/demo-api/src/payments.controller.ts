import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { plan } from '@rivokit/server';
import { IdempotencyGuard } from './idempotency.guard';

/**
 * REST tipis di atas Server SDK. Controller TIDAK memuat logika routing —
 * keputusan hidup di Planner/Saga (sdk-server).
 */
@Controller('payments')
export class PaymentsController {
  /** TODO(M1): buat payment + jalankan Saga. Untuk kini: pratinjau rute saja. */
  @Post()
  @UseGuards(IdempotencyGuard)
  create(@Body() body: { to: string; amount: { amount: string; currency: 'USD' | 'EUR' } }) {
    const routePlan = plan({
      source: { currency: 'USD', form: 'stablecoin', location: 'arc' },
      destination: { currency: body.amount.currency, form: 'fiat' },
      destinationLocation: 'bank',
      constraints: { needsEscrow: true },
    });

    return { status: 'created', to: body.to, amount: body.amount, routePlan };
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return { paymentId: id, status: 'created', legs: [] };
  }
}
